export type SessionState = "fresh" | "locked" | "unlocked";

export type WalletStatus = "idle" | "checking" | "arming" | "armed" | "firing" | "done" | "cleaning" | "error";

export interface SessionSnapshot {
  state: SessionState;
  walletCount: number;
}

export type AffixKind = "prefix" | "suffix" | "none";
export const AFFIX_KINDS: AffixKind[] = ["prefix", "suffix", "none"];

export interface WalletInfo {
  name: string;
  pubkey: string;
  label: string;
  affix: AffixKind;
  enabled: boolean;
  notes?: string;
}

export type PoolType =
  | "meteora-dbc"
  | "meteora-damm"
  | "pumpfun-bc"
  | "pumpfun-amm"
  | "raydium-v4"
  | "raydium-cpmm";

export const POOL_TYPES: PoolType[] = [
  "meteora-dbc",
  "meteora-damm",
  "pumpfun-bc",
  "pumpfun-amm",
  "raydium-v4",
  "raydium-cpmm",
];

export const POOL_TYPE_LABELS: Record<PoolType, string> = {
  "meteora-dbc": "Meteora DBC (bonding curve)",
  "meteora-damm": "Meteora DAMM",
  "pumpfun-bc": "Pump.fun (bonding curve)",
  "pumpfun-amm": "PumpSwap (graduated)",
  "raydium-v4": "Raydium AMM v4",
  "raydium-cpmm": "Raydium CPMM",
};

export type PoolDetectionResult =
  | { status: "ok"; type: PoolType; programId: string; programName: string; pricingSupported: boolean }
  | { status: "unsupported"; programId: string; reason: string }
  | { status: "not-found"; reason: string }
  | { status: "error"; reason: string };

export type StrategyWalletMode = "accumulate" | "dip-only" | "exit-only" | "watch";
export const STRATEGY_MODES: StrategyWalletMode[] = ["accumulate", "dip-only", "exit-only", "watch"];

export interface StrategyAssignment {
  walletName: string;
  mode: StrategyWalletMode;
}

export type SequencerAction = "buy" | "sell" | "buy-sell" | "alternate";
export const SEQUENCER_ACTIONS: SequencerAction[] = ["buy", "sell", "buy-sell", "alternate"];

export type SequencerLoopMode = "loop" | "once" | "ping-pong" | "shuffle";
export const SEQUENCER_LOOP_MODES: SequencerLoopMode[] = ["loop", "once", "ping-pong", "shuffle"];

export type SequencerScheduleMode = "fixed" | "random" | "manual";
export const SEQUENCER_SCHEDULE_MODES: SequencerScheduleMode[] = ["fixed", "random", "manual"];

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

export type SequencerPreset = Omit<SequencerConfig, "active">;

export interface SavedSequence extends SequencerPreset {
  id: string;
  name: string;
  updatedAt: number;
}

export type DcaCoordination = "alternating" | "independent";
export interface DipTier { discount_pct: number; size_sol: number; }
export interface ExitLadderStep { gain_pct: number; sell_pct: number; }
export interface KnifeFilter { min_stable_sec: number; min_bounce_pct: number; }
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

export interface DbcPoolPrice {
  priceSol: number;
  quoteReserveSol: number;
  baseReserveTokens: number;
  curveProgress: number;
  mcapSol: number | null;
}

export interface TokenInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  supply: number | null;
  rawSupply: string | null;
  decimals: number | null;
  tokenProgram: string | null;
}

export interface PoolView {
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
  control_wallet_name: string | null;
  watching: boolean;
  lastSlot: number | null;
  lastUpdate: number | null;
}

export interface BulkImportResult {
  added: WalletInfo[];
  skipped: string[];
  errors: { name: string; error: string }[];
}

export interface PoolUpdateEvent { type: "pool-update"; data: { poolId: string; slot: number; dataLen: number; lamports: number; receivedAt: number; priceSol?: number; mcapSol?: number }; }
export interface WatchStartEvent { type: "watch-start"; poolId: string; }
export interface WatchStopEvent { type: "watch-stop"; poolId: string; }
export interface HelloEvent { type: "hello"; clientId: number; snapshot: SessionSnapshot; }
export interface SessionChangeEvent { type: "session-change"; snapshot: SessionSnapshot; }
export interface PoolsChangeEvent { type: "pools-change"; }
export interface SequencerChangeEvent {
  type: "sequencer-change";
  poolId: string;
  active: boolean;
  queueLen: number;
}
export interface SequencerStepEvent {
  type: "sequencer-step";
  poolId: string;
  stepIndex: number;
  walletName: string;
  action: "buy" | "sell";
  solAmount: number;
  signature: string;
}
export interface SequencerStepErrorEvent {
  type: "sequencer-step-error";
  poolId: string;
  stepIndex: number;
  walletName: string;
  error: string;
}
export interface SequencerArmProgressEvent {
  type: "sequencer-arm-progress";
  poolId: string;
  walletName: string;
  status: "arming" | "armed" | "error";
  sig?: string;
  lamports?: number;
  balanceLamports?: number;
  error?: string;
}
export interface SequencerRunCompleteEvent {
  type: "sequencer-run-complete";
  poolId: string;
}
export interface WalletBalanceProgressEvent {
  type: "wallet-balance-progress";
  walletName: string;
  status: "checking" | "done" | "error";
  balanceLamports?: number;
  error?: string;
}
export interface SequencesChangeEvent { type: "sequences-change"; }

export type ServerEvent =
  | PoolUpdateEvent | WatchStartEvent | WatchStopEvent
  | HelloEvent | SessionChangeEvent | PoolsChangeEvent
  | SequencerChangeEvent | SequencerStepEvent | SequencerStepErrorEvent
  | SequencerArmProgressEvent | SequencerRunCompleteEvent | WalletBalanceProgressEvent | SequencesChangeEvent;
