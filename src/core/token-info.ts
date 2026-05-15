import { makeLogger } from "./logger.ts";

const log = makeLogger("token-info");
const TOKEN_INFO_TIMEOUT_MS = Number(process.env.TOKEN_INFO_TIMEOUT_MS ?? 3000);

export interface TokenInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  supply: number | null;       // UI units (post-decimals)
  rawSupply: string | null;    // raw integer string
  decimals: number | null;
  tokenProgram: string | null;
}

interface HeliusAsset {
  id: string;
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; mime?: string }>;
  };
  token_info?: {
    supply?: number | string;
    decimals?: number;
    token_program?: string;
    symbol?: string;
  };
}

export class TokenInfoClient {
  private rpcUrl: string;
  private cache = new Map<string, { info: TokenInfo; at: number }>();
  private ttlMs = 60_000;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async get(mint: string): Promise<TokenInfo> {
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.info;
    const info = await this.fetchAsset(mint);
    this.cache.set(mint, { info, at: Date.now() });
    return info;
  }

  private async fetchAsset(mint: string): Promise<TokenInfo> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TOKEN_INFO_TIMEOUT_MS);
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-info",
        method: "getAsset",
        params: { id: mint, displayOptions: { showFungible: true } },
      }),
    }).finally(() => clearTimeout(t));
    if (!res.ok) {
      throw new Error(`helius getAsset http ${res.status}`);
    }
    const body = (await res.json()) as { result?: HeliusAsset; error?: { message?: string } };
    if (body.error) {
      log.warn("helius error", { mint, msg: body.error.message });
      return emptyInfo(mint);
    }
    const a = body.result;
    if (!a) return emptyInfo(mint);

    const md = a.content?.metadata;
    const ti = a.token_info;
    const decimals = ti?.decimals ?? null;
    const rawSupplyVal = ti?.supply ?? null;
    const rawSupply = rawSupplyVal !== null && rawSupplyVal !== undefined ? String(rawSupplyVal) : null;
    let supply: number | null = null;
    if (rawSupply && decimals !== null) {
      try {
        const big = BigInt(rawSupply);
        supply = Number(big) / Math.pow(10, decimals);
      } catch {
        supply = null;
      }
    }
    return {
      mint,
      name: md?.name ?? null,
      symbol: md?.symbol ?? ti?.symbol ?? null,
      description: md?.description ?? null,
      image: a.content?.links?.image ?? a.content?.files?.[0]?.uri ?? null,
      supply,
      rawSupply,
      decimals,
      tokenProgram: ti?.token_program ?? null,
    };
  }
}

function emptyInfo(mint: string): TokenInfo {
  return {
    mint,
    name: null,
    symbol: null,
    description: null,
    image: null,
    supply: null,
    rawSupply: null,
    decimals: null,
    tokenProgram: null,
  };
}
