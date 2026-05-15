import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PublicKey } from "@solana/web3.js";
import { makeLogger } from "./logger.ts";

const log = makeLogger("pools-store");
const PATH = "config/pools.json";

export type PoolType =
  | "meteora-dbc"
  | "meteora-damm"
  | "pumpfun-bc"
  | "pumpfun-amm"
  | "raydium-v4"
  | "raydium-cpmm";
export type DcaCoordination = "alternating" | "independent";
export type StrategyWalletMode = "accumulate" | "dip-only" | "exit-only" | "watch";
export type SequencerAction = "buy" | "sell" | "buy-sell" | "alternate";
export type SequencerLoopMode = "loop" | "once" | "ping-pong" | "shuffle";
export type SequencerScheduleMode = "fixed" | "random" | "manual";

export interface DipTier {
  discount_pct: number;
  size_sol: number;
}
export interface ExitLadderStep {
  gain_pct: number;
  sell_pct: number;
}
export interface KnifeFilter {
  min_stable_sec: number;
  min_bounce_pct: number;
}
export interface DcaConfig {
  coordination: DcaCoordination;
  interval_min_minutes: number;
  interval_max_minutes: number;
  size_min_sol: number;
  size_max_sol: number;
}
export interface StrategyConfig {
  budget_sol_per_wallet: number;
  reserve_sol_per_wallet: number;
  slippage_bps: number;
  priority_fee_microlamports: number;
  cooldown_sec_per_wallet: number;
  stop_loss_pct: number | null;
  dca: DcaConfig;
  dip_tiers: DipTier[];
  exit_ladder: ExitLadderStep[];
  knife_filter: KnifeFilter;
}

export interface StrategyAssignment {
  walletName: string;
  mode: StrategyWalletMode;
}

export interface SequencerStep {
  walletName: string;
}
export interface SequencerSchedule {
  mode: SequencerScheduleMode;
  interval_min_sec: number;
  interval_max_sec: number;
}
export interface SequencerSize {
  min_sol: number;
  max_sol: number;
}
export interface SequencerConfig {
  active: boolean;
  queue: SequencerStep[];
  action: SequencerAction;
  schedule: SequencerSchedule;
  size: SequencerSize;
  loop_mode: SequencerLoopMode;
}

export interface PoolConfig {
  id: string;
  name: string;
  type: PoolType;
  pool_address: string;
  token_mint: string;
  active: boolean;
  watch_graduation: boolean;
  strategy: StrategyConfig | null;
  strategy_wallets: StrategyAssignment[];
  sequencer: SequencerConfig;
}

export interface PoolsFile {
  version: 2;
  pools: PoolConfig[];
}

export const defaultStrategy = (): StrategyConfig => ({
  budget_sol_per_wallet: 1.0,
  reserve_sol_per_wallet: 0.1,
  slippage_bps: 100,
  priority_fee_microlamports: 50_000,
  cooldown_sec_per_wallet: 30,
  stop_loss_pct: null,
  dca: {
    coordination: "alternating",
    interval_min_minutes: 30,
    interval_max_minutes: 60,
    size_min_sol: 0.01,
    size_max_sol: 0.03,
  },
  dip_tiers: [
    { discount_pct: 15, size_sol: 0.1 },
    { discount_pct: 35, size_sol: 0.25 },
    { discount_pct: 55, size_sol: 0.4 },
  ],
  exit_ladder: [
    { gain_pct: 50, sell_pct: 25 },
    { gain_pct: 100, sell_pct: 35 },
    { gain_pct: 200, sell_pct: 25 },
  ],
  knife_filter: { min_stable_sec: 30, min_bounce_pct: 3 },
});

export const defaultSequencer = (): SequencerConfig => ({
  active: false,
  queue: [],
  action: "buy-sell",
  schedule: { mode: "random", interval_min_sec: 30, interval_max_sec: 120 },
  size: { min_sol: 0.001, max_sol: 0.001 },
  loop_mode: "loop",
});

function validatePubkey(s: string, field: string): void {
  try {
    new PublicKey(s);
  } catch {
    throw new Error(`invalid pubkey for ${field}: ${s}`);
  }
}

function validateStrategy(s: StrategyConfig): void {
  if (s.budget_sol_per_wallet < 0) throw new Error("budget_sol_per_wallet must be >= 0");
  if (s.reserve_sol_per_wallet < 0) throw new Error("reserve_sol_per_wallet must be >= 0");
  if (s.slippage_bps < 0 || s.slippage_bps > 10000) throw new Error("slippage_bps must be 0..10000");
  if (s.priority_fee_microlamports < 0) throw new Error("priority_fee must be >= 0");
  if (s.cooldown_sec_per_wallet < 0) throw new Error("cooldown_sec must be >= 0");
  if (s.stop_loss_pct !== null && (s.stop_loss_pct <= 0 || s.stop_loss_pct >= 100)) {
    throw new Error("stop_loss_pct must be in (0,100) or null");
  }
  const d = s.dca;
  if (d.interval_min_minutes <= 0 || d.interval_max_minutes < d.interval_min_minutes)
    throw new Error("invalid dca interval range");
  if (d.size_min_sol <= 0 || d.size_max_sol < d.size_min_sol)
    throw new Error("invalid dca size range");
  for (const t of s.dip_tiers) {
    if (t.discount_pct <= 0 || t.discount_pct >= 100) throw new Error("dip discount_pct out of range");
    if (t.size_sol <= 0) throw new Error("dip size_sol must be > 0");
  }
  for (const e of s.exit_ladder) {
    if (e.gain_pct <= 0) throw new Error("exit gain_pct must be > 0");
    if (e.sell_pct <= 0 || e.sell_pct > 100) throw new Error("exit sell_pct must be in (0,100]");
  }
  if (s.knife_filter.min_stable_sec < 0) throw new Error("knife min_stable_sec must be >= 0");
  if (s.knife_filter.min_bounce_pct < 0) throw new Error("knife min_bounce_pct must be >= 0");
}

export function validateSequencer(seq: SequencerConfig): void {
  const { mode, interval_min_sec, interval_max_sec } = seq.schedule;
  if (mode === "manual") {
    if (interval_min_sec < 0) throw new Error("schedule.interval_min_sec must be >= 0");
  } else if (interval_min_sec < 1) {
    throw new Error("schedule.interval_min_sec must be >= 1");
  }
  if (interval_max_sec < interval_min_sec) {
    throw new Error("schedule.interval_max_sec must be >= interval_min_sec");
  }
  if (seq.size.min_sol <= 0) throw new Error("size.min_sol must be > 0");
  if (seq.size.max_sol < seq.size.min_sol) throw new Error("size.max_sol must be >= min_sol");
}

function validateAssignments(
  strategy_wallets: StrategyAssignment[],
  sequencer: SequencerConfig,
): void {
  const inStrategy = new Set(strategy_wallets.map((a) => a.walletName));
  const inSequencer = new Set(sequencer.queue.map((s) => s.walletName));
  for (const w of inSequencer) {
    if (inStrategy.has(w)) {
      throw new Error(`wallet "${w}" cannot be both in strategy and sequencer at the same time`);
    }
  }
}

function normalizePool(p: any): PoolConfig {
  return {
    id: p.id,
    name: p.name ?? p.id,
    type: p.type,
    pool_address: p.pool_address,
    token_mint: p.token_mint,
    active: Boolean(p.active),
    watch_graduation: p.watch_graduation ?? true,
    strategy: p.strategy ?? null,
    strategy_wallets: p.strategy_wallets ?? [],
    sequencer: p.sequencer ?? defaultSequencer(),
  };
}

class PoolsStore extends EventEmitter {
  private cache: PoolsFile | null = null;

  private read(): PoolsFile {
    if (this.cache) return this.cache;
    if (!existsSync(PATH)) {
      this.cache = { version: 2, pools: [] };
      return this.cache;
    }
    const raw = readFileSync(PATH, "utf8");
    const parsed = JSON.parse(raw) as any;
    // Migrate from older shapes lacking version/sequencer/strategy_wallets.
    if (!parsed.version || parsed.version < 2) {
      const pools: PoolConfig[] = (parsed.pools ?? []).map((p: any) => ({
        ...normalizePool(p),
        active: false,                         // safe default after migration
      }));
      this.cache = { version: 2, pools };
      this.write(this.cache);
      return this.cache;
    }
    const original = JSON.stringify(parsed.pools ?? []);
    const file: PoolsFile = { version: 2, pools: (parsed.pools ?? []).map(normalizePool) };
    const changed = JSON.stringify(file.pools) !== original;
    this.cache = file;
    if (changed) this.write(file);
    return this.cache;
  }

  private write(file: PoolsFile): void {
    writeFileSync(PATH, JSON.stringify(file, null, 2));
    this.cache = file;
  }

  list(): PoolConfig[] {
    return [...this.read().pools];
  }

  get(id: string): PoolConfig | undefined {
    return this.read().pools.find((p) => p.id === id);
  }

  add(input: {
    id: string;
    name: string;
    type: PoolType;
    pool_address: string;
    token_mint: string;
    watch_graduation?: boolean;
    strategy?: StrategyConfig | null;
  }): PoolConfig {
    const file = this.read();
    if (file.pools.some((p) => p.id === input.id)) {
      throw new Error(`pool with id "${input.id}" already exists`);
    }
    if (!input.id.match(/^[a-z0-9_-]{1,32}$/i)) {
      throw new Error("pool id must be 1-32 chars, alphanumeric/underscore/dash");
    }
    validatePubkey(input.pool_address, "pool_address");
    validatePubkey(input.token_mint, "token_mint");
    if (input.strategy) validateStrategy(input.strategy);
    const pool: PoolConfig = {
      id: input.id,
      name: input.name || input.id,
      type: input.type,
      pool_address: input.pool_address,
      token_mint: input.token_mint,
      active: false,
      watch_graduation: input.watch_graduation ?? true,
      strategy: input.strategy ?? null,
      strategy_wallets: [],
      sequencer: defaultSequencer(),
    };
    file.pools.push(pool);
    this.write(file);
    log.info("pool added", { id: pool.id });
    this.emit("change", { type: "added", id: pool.id, pool });
    return pool;
  }

  update(id: string, patch: Partial<Omit<PoolConfig, "id">>): PoolConfig {
    const file = this.read();
    const pool = file.pools.find((p) => p.id === id);
    if (!pool) throw new Error(`pool not found: ${id}`);
    if (patch.pool_address) validatePubkey(patch.pool_address, "pool_address");
    if (patch.token_mint) validatePubkey(patch.token_mint, "token_mint");
    if (patch.strategy) validateStrategy(patch.strategy);
    if (patch.sequencer) validateSequencer(patch.sequencer);
    const nextStrategyWallets = patch.strategy_wallets ?? pool.strategy_wallets;
    const nextSequencer = patch.sequencer ?? pool.sequencer;
    validateAssignments(nextStrategyWallets, nextSequencer);

    const wasActive = pool.active;
    delete (patch as any).control_wallet_name;
    Object.assign(pool, patch);
    this.write(file);
    log.info("pool updated", { id, patch: Object.keys(patch) });
    if (patch.active !== undefined && patch.active !== wasActive) {
      this.emit("change", { type: patch.active ? "activated" : "deactivated", id, pool });
    } else {
      this.emit("change", { type: "updated", id, pool });
    }
    return pool;
  }

  remove(id: string): void {
    const file = this.read();
    const idx = file.pools.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`pool not found: ${id}`);
    const [removed] = file.pools.splice(idx, 1);
    this.write(file);
    log.info("pool removed", { id });
    this.emit("change", { type: "removed", id, pool: removed });
  }

  /** Called when a wallet is removed — strip it from all pools. */
  removeWalletEverywhere(walletName: string): void {
    const file = this.read();
    let touched = false;
    for (const p of file.pools) {
      const before = p.strategy_wallets.length + p.sequencer.queue.length;
      p.strategy_wallets = p.strategy_wallets.filter((a) => a.walletName !== walletName);
      p.sequencer.queue = p.sequencer.queue.filter((s) => s.walletName !== walletName);
      if (p.strategy_wallets.length + p.sequencer.queue.length !== before) {
        touched = true;
        this.emit("change", { type: "updated", id: p.id, pool: p });
      }
    }
    if (touched) this.write(file);
  }
}

export const pools = new PoolsStore();
