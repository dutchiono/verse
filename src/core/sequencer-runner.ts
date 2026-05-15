import { EventEmitter } from "node:events";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import { swapSolForToken, swapTokenForSol } from "./jupiter-swap.ts";
import { transferSol, drainSol, KEEP_LAMPORTS } from "./sol-transfer.ts";
import { getWalletTokenBalance } from "./token-ata-balance.ts";
import type { PoolConfig } from "./pools-store.ts";
import { makeLogger } from "./logger.ts";

export interface ArmStepResult {
  walletName: string;
  ok: boolean;
  sig?: string;
  lamports?: number;
  balanceLamports?: number;
  error?: string;
}
export interface ArmProgressEvent {
  walletName: string;
  status: "arming" | "armed" | "error";
  sig?: string;
  lamports?: number;
  balanceLamports?: number;
  error?: string;
}

export interface CleanupStepResult {
  walletName: string;
  ok: boolean;
  sig?: string;
  tokenSellSig?: string;
  tokenRawAmount?: string;
  lamports?: number;
  balanceLamports?: number;
  skipped?: boolean; // balance already at floor
  error?: string;
}

const log = makeLogger("sequencer");
const ARM_SOL_PER_WALLET = 0.03;
const ARM_FEE_BUFFER_LAMPORTS = 100_000;
const ARM_BALANCE_CHECK_DELAY_MS = 300;   // between getBalance calls during ARM
const ARM_TRANSFER_DELAY_MS = 800;        // between SOL top-up transfers during ARM
const ARM_RETRY_ATTEMPTS = 3;             // retries on rate-limited transfer
const CLEANUP_WALLET_INTERVAL_MS = 1_000; // min gap between cleanup wallets (was 315)
const RATE_LIMIT_PAUSE_MS = 12_000;       // pause on any 429 before retry

export interface StepEvent {
  poolId: string;
  stepIndex: number;
  walletName: string;
  action: "buy" | "sell";
  solAmount: number;
  signature: string;
}
export interface StepErrorEvent {
  poolId: string;
  stepIndex: number;
  walletName: string;
  error: string;
}

/**
 * Executes sequencer queues.
 *
 * Start / stop per pool. Fires Jupiter buys (sell support in a future pass).
 * Manual schedule: only fires when fireNext() is called explicitly.
 * Fixed / random: auto-fires with the configured timing.
 */
export class SequencerRunner extends EventEmitter {
  private acs = new Map<string, AbortController>();
  private cursors = new Map<string, number>(); // current queue position per pool
  private conn: Connection;
  private getKeypair: (name: string) => Keypair | null;
  private getAnyKeypair: (name: string) => Keypair | null;

  constructor(
    conn: Connection,
    getKeypair: (name: string) => Keypair | null,
    getAnyKeypair: (name: string) => Keypair | null,
  ) {
    super();
    this.conn = conn;
    this.getKeypair = getKeypair;
    this.getAnyKeypair = getAnyKeypair;
  }

  isRunning(poolId: string): boolean { return this.acs.has(poolId); }

  getCursor(poolId: string): number { return this.cursors.get(poolId) ?? 0; }
  resetCursor(poolId: string): void { this.cursors.set(poolId, 0); }

  start(pool: PoolConfig): void {
    if (this.acs.has(pool.id)) return;
    if (pool.sequencer.queue.length === 0) {
      log.warn("start called with empty queue", { poolId: pool.id });
      return;
    }
    this.cursors.set(pool.id, 0);
    const ac = new AbortController();
    this.acs.set(pool.id, ac);

    if (pool.sequencer.schedule.mode === "manual") {
      // In manual mode we stay armed but don't auto-fire.
      log.info("sequencer armed (manual mode)", { poolId: pool.id });
      return;
    }

    void this.autoLoop(pool, ac.signal).finally(() => {
      if (this.acs.get(pool.id) === ac) this.acs.delete(pool.id);
      this.emit("run-complete", pool.id);
    });
    log.info("sequencer auto-started", { poolId: pool.id, mode: pool.sequencer.schedule.mode });
  }

  stop(poolId: string): void {
    const ac = this.acs.get(poolId);
    if (ac) { ac.abort(); this.acs.delete(poolId); }
    this.cursors.delete(poolId);
    log.info("sequencer stopped", { poolId });
  }

  stopAll(): void {
    for (const [id] of [...this.acs]) this.stop(id);
  }

  /**
   * Fire the next step in the queue for a pool.
   * Works in both manual and auto modes. Advances the cursor.
   * Returns signature, or throws on failure.
   */
  async fireNext(pool: PoolConfig): Promise<string> {
    if (pool.sequencer.queue.length === 0) throw new Error("queue is empty");
    const cursor = this.cursors.get(pool.id) ?? 0;
    const plan = planStep(pool, cursor);
    const idx = plan.idx;
    const step = pool.sequencer.queue[idx]!;
    const kp = this.getKeypair(step.walletName);
    if (!kp) throw new Error(`wallet "${step.walletName}" not loaded — unlock first`);

    const solAmount = randBetween(pool.sequencer.size.min_sol, pool.sequencer.size.max_sol);
    const lamports = Math.floor(solAmount * 1e9);

    log.info("firing step", { poolId: pool.id, idx, walletName: step.walletName, action: plan.action, solAmount });
    const sig = plan.action === "buy"
      ? await swapSolForToken({
          connection: this.conn,
          wallet: kp,
          outputMint: pool.token_mint,
          lamports,
          slippageBps: 150,
        })
      : await this.sellAll(pool, kp);

    this.cursors.set(pool.id, cursor + 1);
    this.emit("step", {
      poolId: pool.id,
      stepIndex: idx,
      walletName: step.walletName,
      action: plan.action,
      solAmount: plan.action === "buy" ? solAmount : 0,
      signature: sig,
    } satisfies StepEvent);
    return sig;
  }

  private async sellAll(pool: PoolConfig, wallet: Keypair): Promise<string> {
    let rawAmount = 0n;
    for (let i = 0; i < 10; i++) {
      const bal = await getWalletTokenBalance(this.conn, wallet.publicKey.toBase58(), pool.token_mint);
      rawAmount = BigInt(bal?.rawAmount ?? "0");
      if (rawAmount > 0n) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (rawAmount <= 0n) throw new Error("no pool token balance to sell");
    return swapTokenForSol({
      connection: this.conn,
      wallet,
      inputMint: pool.token_mint,
      rawAmount: Number(rawAmount),
      slippageBps: 150,
    });
  }

  private async autoLoop(pool: PoolConfig, signal: AbortSignal): Promise<void> {
    const seq = pool.sequencer;
    let indices = buildIndices(seq.queue.length, seq.loop_mode);
    let pos = 0;
    let dir = 1;

    while (!signal.aborted) {
      const planned = planStep(pool, this.cursors.get(pool.id) ?? 0);
      const idx = seq.action === "buy-sell" || seq.action === "sell" ? planned.idx : (indices[pos] ?? 0);
      const step = seq.queue[idx];
      if (!step) break;

      const kp = this.getKeypair(step.walletName);
      if (!kp) {
        log.warn("wallet not loaded, skipping", { walletName: step.walletName });
        this.emit("step-error", { poolId: pool.id, stepIndex: idx, walletName: step.walletName, error: "wallet not loaded" } satisfies StepErrorEvent);
      } else {
        const solAmount = randBetween(seq.size.min_sol, seq.size.max_sol);
        const lamports = Math.floor(solAmount * 1e9);
        try {
          const sig = planned.action === "buy"
            ? await swapSolForToken({ connection: this.conn, wallet: kp, outputMint: pool.token_mint, lamports, slippageBps: 150 })
            : await this.sellAll(pool, kp);
          this.cursors.set(pool.id, (this.cursors.get(pool.id) ?? 0) + 1);
          this.emit("step", { poolId: pool.id, stepIndex: idx, walletName: step.walletName, action: planned.action, solAmount: planned.action === "buy" ? solAmount : 0, signature: sig } satisfies StepEvent);
        } catch (e) {
          const error = (e as Error).message;
          log.error("step failed", { poolId: pool.id, idx, error });
          this.emit("step-error", { poolId: pool.id, stepIndex: idx, walletName: step.walletName, error } satisfies StepErrorEvent);
        }
      }
      if (signal.aborted) break;

      // Advance
      if (seq.loop_mode === "once") {
        pos++;
        if (pos >= indices.length) return; // done
      } else if (seq.loop_mode === "loop") {
        pos = (pos + 1) % indices.length;
      } else if (seq.loop_mode === "ping-pong") {
        pos += dir;
        if (pos >= indices.length) { dir = -1; pos = indices.length - 2; }
        else if (pos < 0) { dir = 1; pos = 1; }
      } else if (seq.loop_mode === "shuffle") {
        pos++;
        if (pos >= indices.length) {
          indices = shuffle(buildIndices(seq.queue.length, "shuffle"));
          pos = 0;
        }
      }
      if (signal.aborted) break;

      const waitMs = seq.schedule.mode === "fixed"
        ? seq.schedule.interval_min_sec * 1000
        : randBetween(seq.schedule.interval_min_sec, seq.schedule.interval_max_sec) * 1000;

      await abortableSleep(waitMs, signal);
    }
  }

  /**
   * ARM: distribute a fixed SOL float to each unique sequence wallet.
   * Wallets that are already the control wallet are skipped.
   * Each transfer is awaited before moving to the next (serial, confirmed).
   */
  async arm(
    pool: PoolConfig,
    controlWalletName: string,
    onProgress?: (event: ArmProgressEvent) => void,
  ): Promise<ArmStepResult[]> {
    const controlKp = this.getKeypair(controlWalletName);
    if (!controlKp) throw new Error(`control wallet "${controlWalletName}" not loaded — unlock first`);
    const uniqueWallets = [...new Set(
      pool.sequencer.queue
        .map((step) => step.walletName)
        .filter((name) => name !== controlWalletName),
    )];
    const targetLamports = Math.floor(ARM_SOL_PER_WALLET * 1e9);
    const deficits: Array<{ walletName: string; currentLamports: number; deficitLamports: number }> = [];
    const results: ArmStepResult[] = [];

    for (let i = 0; i < uniqueWallets.length; i++) {
      const walletName = uniqueWallets[i]!;
      onProgress?.({ walletName, status: "arming" });
      const destKp = this.getKeypair(walletName);
      if (!destKp) {
        const result = { walletName, ok: false, error: "wallet not loaded" } satisfies ArmStepResult;
        results.push(result);
        onProgress?.({ walletName, status: "error", error: result.error });
        continue;
      }
      const currentLamports = await getBalanceWithRateLimitRetry(this.conn, destKp.publicKey);
      deficits.push({
        walletName,
        currentLamports,
        deficitLamports: Math.max(0, targetLamports - currentLamports),
      });
      if (i < uniqueWallets.length - 1) await sleep(ARM_BALANCE_CHECK_DELAY_MS);
    }

    const totalLamports = deficits.reduce((sum, x) => sum + x.deficitLamports, 0);
    const controlBalance = await this.conn.getBalance(controlKp.publicKey, "confirmed");
    const requiredLamports = totalLamports + ARM_FEE_BUFFER_LAMPORTS;
    if (controlBalance < requiredLamports) {
      const need = requiredLamports / 1e9;
      const have = controlBalance / 1e9;
      const short = (requiredLamports - controlBalance) / 1e9;
      throw new Error(
        `arm needs ${need.toFixed(4)} SOL to top up ${deficits.length} wallet(s) to ${ARM_SOL_PER_WALLET.toFixed(3)} each; LARP has ${have.toFixed(4)} SOL and is short ${short.toFixed(4)} SOL`,
      );
    }

    for (let i = 0; i < deficits.length; i++) {
      const { walletName, currentLamports, deficitLamports } = deficits[i]!;
      const destKp = this.getKeypair(walletName);
      if (!destKp) continue;
      if (deficitLamports <= 0) {
        const result = { walletName, ok: true, lamports: 0, balanceLamports: currentLamports } satisfies ArmStepResult;
        results.push(result);
        onProgress?.({ walletName, status: "armed", lamports: 0, balanceLamports: currentLamports });
        continue;
      }
      let lastError = "";
      let succeeded = false;
      for (let attempt = 0; attempt < ARM_RETRY_ATTEMPTS; attempt++) {
        try {
          if (attempt > 0) {
            log.info("arm: retrying transfer after rate limit", { to: walletName, attempt });
            await sleep(RATE_LIMIT_PAUSE_MS);
          }
          log.info("arm: topping up SOL", { to: walletName, lamports: deficitLamports });
          const sig = await transferSol(this.conn, controlKp, destKp.publicKey, deficitLamports);
          const balanceLamports = currentLamports + deficitLamports;
          const result = { walletName, ok: true, sig, lamports: deficitLamports, balanceLamports } satisfies ArmStepResult;
          results.push(result);
          onProgress?.({ walletName, status: "armed", sig, lamports: deficitLamports, balanceLamports });
          succeeded = true;
          break;
        } catch (e) {
          lastError = (e as Error).message;
          if (!isRateLimitError(e)) break; // non-rate-limit error — don't retry
        }
      }
      if (!succeeded) {
        const result = { walletName, ok: false, error: lastError } satisfies ArmStepResult;
        results.push(result);
        onProgress?.({ walletName, status: "error", error: lastError });
      }
      if (i < deficits.length - 1) await sleep(ARM_TRANSFER_DELAY_MS);
    }

    return results;
  }

  /**
   * CLEANUP: drain all available SOL from every known wallet back to the control wallet.
   * Empty wallets are tolerated and returned as skipped.
   */
  async cleanup(pool: PoolConfig, walletNames: string[], controlWalletName: string): Promise<CleanupStepResult[]> {
    const controlKp = this.getAnyKeypair(controlWalletName) ?? this.getKeypair(controlWalletName);
    if (!controlKp) throw new Error(`control wallet "${controlWalletName}" not loaded`);

    const results: CleanupStepResult[] = [];
    const seen = new Set<string>();

    for (const walletName of walletNames) {
      const startedAt = Date.now();
      if (walletName === controlWalletName || seen.has(walletName)) continue;
      seen.add(walletName);

      const walletKp = this.getAnyKeypair(walletName) ?? this.getKeypair(walletName);
      if (!walletKp) {
        results.push({ walletName, ok: false, error: "wallet not loaded" });
        continue;
      }
      try {
        let currentLamports = await getBalanceWithRateLimitRetry(this.conn, walletKp.publicKey);
        if (currentLamports <= 0) {
          results.push({ walletName, ok: true, lamports: 0, balanceLamports: currentLamports, skipped: true });
          log.info("cleanup: skipped", { from: walletName, balanceLamports: currentLamports });
          continue;
        }

        const tokenBal = await getWalletTokenBalance(this.conn, walletKp.publicKey.toBase58(), pool.token_mint);
        let tokenSellSig: string | undefined;
        let tokenRawAmount: string | undefined;
        if (BigInt(tokenBal?.rawAmount ?? "0") > 0n) {
          tokenRawAmount = tokenBal!.rawAmount;
          log.info("cleanup: selling pool token", { from: walletName, rawAmount: tokenRawAmount });
          try {
            tokenSellSig = await swapTokenForSol({
              connection: this.conn,
              wallet: walletKp,
              inputMint: pool.token_mint,
              rawAmount: Number(tokenRawAmount),
              slippageBps: 150,
            });
            currentLamports = await getBalanceWithRateLimitRetry(this.conn, walletKp.publicKey);
          } catch (e) {
            const error = `token sell failed before SOL sweep: ${(e as Error).message}`;
            results.push({ walletName, ok: false, tokenRawAmount, error });
            log.warn("cleanup: token sell failed; leaving SOL for retry", { from: walletName, error });
            continue;
          }
        }

        log.info("cleanup: draining SOL", { from: walletName });
        let r: Awaited<ReturnType<typeof drainSol>> = null;
        let drainErr = "";
        for (let attempt = 0; attempt < ARM_RETRY_ATTEMPTS; attempt++) {
          try {
            if (attempt > 0) {
              log.info("cleanup: retrying drain after rate limit", { from: walletName, attempt });
              await sleep(RATE_LIMIT_PAUSE_MS);
            }
            r = await drainSol(this.conn, walletKp, controlKp.publicKey, currentLamports);
            drainErr = "";
            break;
          } catch (e) {
            drainErr = (e as Error).message;
            if (!isRateLimitError(e)) break;
          }
        }
        if (drainErr) throw new Error(drainErr);
        if (!r) {
          const balanceLamports = await this.conn.getBalance(walletKp.publicKey, "confirmed").catch(() => null);
          results.push({
            walletName,
            ok: true,
            tokenSellSig,
            tokenRawAmount,
            lamports: 0,
            balanceLamports: balanceLamports ?? undefined,
            skipped: true,
          });
          log.info("cleanup: skipped", { from: walletName, balanceLamports });
        } else {
          const balanceLamports = await this.conn.getBalance(walletKp.publicKey, "confirmed").catch(() => KEEP_LAMPORTS);
          results.push({ walletName, ok: true, sig: r.sig, tokenSellSig, tokenRawAmount, lamports: r.lamports, balanceLamports });
          log.info("cleanup: drained", { from: walletName, tokenSold: Boolean(tokenSellSig), lamports: r.lamports, balanceLamports });
        }
      } catch (e) {
        const error = (e as Error).message;
        results.push({ walletName, ok: false, error });
        log.warn("cleanup: wallet failed", { from: walletName, error });
      } finally {
        const waitMs = CLEANUP_WALLET_INTERVAL_MS - (Date.now() - startedAt);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    return results;
  }
}

function buildIndices(len: number, mode: string): number[] {
  const idx = Array.from({ length: len }, (_, i) => i);
  return mode === "shuffle" ? shuffle(idx) : idx;
}
function planStep(pool: PoolConfig, cursor: number): { idx: number; action: "buy" | "sell" } {
  const len = pool.sequencer.queue.length;
  const action = pool.sequencer.action;
  if (action === "sell") return { idx: cursor % len, action: "sell" };
  if (action === "buy-sell") {
    let n = cursor % (len * 2);
    for (let start = 0; start < len; start += 2) {
      const pairLen = Math.min(2, len - start);
      const pairCycle = pairLen * 2;
      if (n < pairCycle) {
        return {
          idx: start + (n % pairLen),
          action: n < pairLen ? "buy" : "sell",
        };
      }
      n -= pairCycle;
    }
  }
  return { idx: cursor % len, action: "buy" };
}
function randBetween(min: number, max: number): number { return min + Math.random() * (max - min); }
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j]!, r[i]!]; }
  return r;
}
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBalanceWithRateLimitRetry(conn: Connection, pubkey: PublicKey): Promise<number> {
  try {
    return await conn.getBalance(pubkey, "confirmed");
  } catch (e) {
    if (!isRateLimitError(e)) throw e;
    await sleep(RATE_LIMIT_PAUSE_MS);
    return await conn.getBalance(pubkey, "confirmed");
  }
}

function isRateLimitError(e: unknown): boolean {
  const msg = (e as Error).message ?? String(e);
  return msg.includes("429") || msg.toLowerCase().includes("rate limited");
}
