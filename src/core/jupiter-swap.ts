import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import { makeLogger } from "./logger.ts";

const log = makeLogger("jupiter-swap");

const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Jupiter Lite / Swap API v1 (api.jup.ag). Legacy quote-api.jup.ag often fails DNS in some networks. */
const QUOTE = process.env.JUPITER_QUOTE_URL ?? "https://api.jup.ag/swap/v1/quote";
const SWAP = process.env.JUPITER_SWAP_URL ?? "https://api.jup.ag/swap/v1/swap";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const DEFAULT_JUPITER_INTERVAL_MS = JUPITER_API_KEY ? 1010 : 2100;
const JUPITER_MIN_INTERVAL_MS = Number(process.env.JUPITER_MIN_INTERVAL_MS ?? DEFAULT_JUPITER_INTERVAL_MS);
let jupiterGate: Promise<void> = Promise.resolve();
let jupiterNextAt = 0;

/**
 * Swap native SOL → SPL token via Jupiter v6 (aggregator route).
 * Uses mainnet routes — same cluster as your Helius connection must be mainnet.
 */
export async function swapSolForToken(params: {
  connection: Connection;
  wallet: Keypair;
  outputMint: string;
  lamports: number;
  slippageBps: number;
  prioritizationFeeLamports?: number | "auto";
}): Promise<string> {
  const { connection, wallet, outputMint, lamports, slippageBps, prioritizationFeeLamports = "auto" } = params;
  if (lamports < 10_000) throw new Error("amount too small (min ~0.00001 SOL)");
  if (lamports > 15e9) throw new Error("amount too large (max 15 SOL per request)");

  const quoteUrl = new URL(QUOTE);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", String(lamports));
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const qRes = await jupiterFetch("quote", quoteUrl.toString()).catch((e) => {
    throw new Error(`Jupiter quote unreachable (${QUOTE}): ${(e as Error).message}`);
  });
  const qText = await qRes.text();
  if (!qRes.ok) throw new Error(`Jupiter quote ${qRes.status}: ${qText.slice(0, 400)}`);
  const quote = JSON.parse(qText) as Record<string, unknown>;
  if (!quote || typeof quote !== "object") throw new Error("Jupiter quote: invalid JSON");

  const sRes = await jupiterFetch("swap", SWAP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: prioritizationFeeLamports === "auto" ? "auto" : prioritizationFeeLamports,
    }),
  }).catch((e) => {
    throw new Error(`Jupiter swap unreachable (${SWAP}): ${(e as Error).message}`);
  });
  const sText = await sRes.text();
  if (!sRes.ok) throw new Error(`Jupiter swap ${sRes.status}: ${sText.slice(0, 400)}`);
  const swapJson = JSON.parse(sText) as { swapTransaction?: string };
  const txB64 = swapJson.swapTransaction;
  if (!txB64) throw new Error("Jupiter swap: missing swapTransaction");

  const buf = Buffer.from(txB64, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  log.info("jupiter buy sent", { sig, lamports, outputMint: outputMint.slice(0, 8) });

  await confirmTx(connection, sig);
  return sig;
}

/**
 * Swap SPL token → native SOL via Jupiter (sell).
 *
 * @param rawAmount - raw token units (already multiplied by 10^decimals).
 *                   Pass 0 to query current ATA balance and sell 100%.
 */
export async function swapTokenForSol(params: {
  connection: Connection;
  wallet: Keypair;
  inputMint: string;
  rawAmount: number;        // raw token units
  slippageBps: number;
  prioritizationFeeLamports?: number | "auto";
}): Promise<string> {
  const { connection, wallet, inputMint, rawAmount, slippageBps, prioritizationFeeLamports = "auto" } = params;
  if (rawAmount <= 0) throw new Error("rawAmount must be > 0");

  const quoteUrl = new URL(QUOTE);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", SOL_MINT);
  quoteUrl.searchParams.set("amount", String(Math.floor(rawAmount)));
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const qRes = await jupiterFetch("quote", quoteUrl.toString()).catch((e) => {
    throw new Error(`Jupiter quote unreachable (${QUOTE}): ${(e as Error).message}`);
  });
  const qText = await qRes.text();
  if (!qRes.ok) throw new Error(`Jupiter quote ${qRes.status}: ${qText.slice(0, 400)}`);
  const quote = JSON.parse(qText) as Record<string, unknown>;
  if (!quote || typeof quote !== "object") throw new Error("Jupiter quote: invalid JSON");

  const sRes = await jupiterFetch("swap", SWAP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: prioritizationFeeLamports === "auto" ? "auto" : prioritizationFeeLamports,
    }),
  }).catch((e) => {
    throw new Error(`Jupiter swap unreachable (${SWAP}): ${(e as Error).message}`);
  });
  const sText = await sRes.text();
  if (!sRes.ok) throw new Error(`Jupiter swap ${sRes.status}: ${sText.slice(0, 400)}`);
  const swapJson = JSON.parse(sText) as { swapTransaction?: string };
  const txB64 = swapJson.swapTransaction;
  if (!txB64) throw new Error("Jupiter swap: missing swapTransaction");

  const buf = Buffer.from(txB64, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  log.info("jupiter sell sent", { sig, rawAmount, inputMint: inputMint.slice(0, 8) });

  await confirmTx(connection, sig);
  return sig;
}

export async function quoteTokenForSolLamports(params: {
  inputMint: string;
  rawAmount: number;
  slippageBps: number;
}): Promise<number> {
  const { inputMint, rawAmount, slippageBps } = params;
  if (rawAmount <= 0) throw new Error("rawAmount must be > 0");

  const quoteUrl = new URL(QUOTE);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", SOL_MINT);
  quoteUrl.searchParams.set("amount", String(Math.floor(rawAmount)));
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const qRes = await jupiterFetch("quote", quoteUrl.toString()).catch((e) => {
    throw new Error(`Jupiter quote unreachable (${QUOTE}): ${(e as Error).message}`);
  });
  const qText = await qRes.text();
  if (!qRes.ok) throw new Error(`Jupiter quote ${qRes.status}: ${qText.slice(0, 400)}`);
  const quote = JSON.parse(qText) as { outAmount?: string };
  const out = Number(quote.outAmount ?? 0);
  if (!Number.isFinite(out) || out <= 0) throw new Error("Jupiter quote: missing outAmount");
  return Math.floor(out);
}

async function confirmTx(connection: Connection, sig: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`transaction failed: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`confirmation timeout — signature may still land: ${sig}`);
}

async function jupiterFetch(label: "quote" | "swap", url: string, init?: RequestInit): Promise<Response> {
  return enqueueJupiter(async () => {
    await waitForJupiterCooldown();
    const res = await fetch(url, withJupiterHeaders(init));
    jupiterNextAt = Math.max(jupiterNextAt, Date.now() + JUPITER_MIN_INTERVAL_MS);
    if (res.status === 429) {
      const body = await res.clone().text().catch(() => "");
      log.warn("jupiter rate limited", {
        label,
        intervalMs: JUPITER_MIN_INTERVAL_MS,
        apiKeyConfigured: Boolean(JUPITER_API_KEY),
        retryAfter: res.headers.get("retry-after"),
        body: body.slice(0, 240),
      });
    }
    return res;
  });
}

function withJupiterHeaders(init?: RequestInit): RequestInit | undefined {
  if (!JUPITER_API_KEY) return init;
  return {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "x-api-key": JUPITER_API_KEY,
    },
  };
}

function enqueueJupiter<T>(fn: () => Promise<T>): Promise<T> {
  const run = jupiterGate.then(fn, fn);
  jupiterGate = run.then(() => undefined, () => undefined);
  return run;
}

async function waitForJupiterCooldown(): Promise<void> {
  const waitMs = jupiterNextAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
