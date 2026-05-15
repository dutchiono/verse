import type {
  SessionSnapshot,
  WalletInfo,
  AffixKind,
  PoolView,
  PoolType,
  StrategyConfig,
  SequencerConfig,
  SequencerPreset,
  SavedSequence,
  StrategyAssignment,
  TokenInfo,
  DbcPoolPrice,
  PoolDetectionResult,
  BulkImportResult,
} from "./types";

const TOKEN_KEY = "verse-token";
export type UserRole = "admin" | "operator";
export const authToken = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = authToken.get();
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 && path !== "/api/auth/login") {
    authToken.clear();
    window.dispatchEvent(new CustomEvent("verse-unauthorized"));
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  // --- Auth ---
  login: (username: string, password: string) =>
    req<{ token: string; username: string; role: UserRole; isAdmin: boolean }>("/api/auth/login", {
      method: "POST", body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => req<{ authenticated: boolean; username?: string; role?: UserRole; isAdmin?: boolean; controlWalletName?: string | null }>("/api/auth/me"),
  bootstrap: () => req<{ hasUsers: boolean }>("/api/auth/bootstrap"),

  // --- Users ---
  listUsers: () => req<{ users: { username: string; createdAt: number; role?: UserRole; controlWalletName?: string }[]; total: number }>("/api/users"),
  addUser: (username: string, password: string, controlWallet?: { name: string; secret: string; label?: string; affix?: AffixKind; notes?: string }) =>
    req<{ username: string; createdAt: number; controlWalletName?: string }>("/api/users", {
      method: "POST", body: JSON.stringify({ username, password, ...(controlWallet ? { controlWallet } : {}) }),
    }),
  deleteUser: (username: string) =>
    req<{ ok: true }>(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
  changeUserPassword: (username: string, newPassword: string) =>
    req<{ ok: true }>(`/api/users/${encodeURIComponent(username)}`, {
      method: "PUT", body: JSON.stringify({ newPassword }),
    }),
  setUserControlWallet: (username: string, walletName: string | null) =>
    req<{ ok: true }>(`/api/users/${encodeURIComponent(username)}/control-wallet`, {
      method: "PUT", body: JSON.stringify({ walletName }),
    }),
  importUserControlWallet: (username: string, wallet: { name: string; secret: string; label?: string; affix?: AffixKind; notes?: string }) =>
    req<{ ok: true; wallet: WalletInfo }>(`/api/users/${encodeURIComponent(username)}/control-wallet`, {
      method: "POST", body: JSON.stringify({ wallet }),
    }),

  getState: () => req<SessionSnapshot>("/api/state"),
  unlock: (password: string) =>
    req<SessionSnapshot>("/api/unlock", { method: "POST", body: JSON.stringify({ password }) }),
  lock: () => req<SessionSnapshot>("/api/lock", { method: "POST" }),
  rotatePassword: (newPassword: string) =>
    req<{ ok: true }>("/api/rotate-password", { method: "POST", body: JSON.stringify({ newPassword }) }),

  listWallets: () => req<{ wallets: WalletInfo[] }>("/api/wallets"),
  addWallet: (input: { name: string; secret: string; label: string; affix: AffixKind; notes?: string }) =>
    req<WalletInfo>("/api/wallets", { method: "POST", body: JSON.stringify(input) }),
  bulkAddWallets: (wallets: Array<{ name: string; secret: string; label: string; affix: AffixKind; notes?: string }>) =>
    req<BulkImportResult>("/api/wallets/bulk", { method: "POST", body: JSON.stringify({ wallets }) }),
  updateWallet: (name: string, patch: { label?: string; affix?: AffixKind; enabled?: boolean; notes?: string }) =>
    req<WalletInfo>(`/api/wallets/${encodeURIComponent(name)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  updateWallets: (names: string[], patch: { label?: string; affix?: AffixKind; enabled?: boolean; notes?: string }) =>
    req<{ wallets: WalletInfo[] }>("/api/wallets/bulk-update", {
      method: "PATCH", body: JSON.stringify({ names, patch }),
    }),
  deleteWallet: (name: string) =>
    req<{ ok: true }>(`/api/wallets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  walletBalances: (names: string[]) =>
    req<{ balances: Record<string, number | null> }>(
      `/api/wallets/balances?names=${encodeURIComponent(names.join(","))}`,
    ),
  checkWalletBalances: (names: string[]) =>
    req<{ balances: Record<string, number | null> }>("/api/wallets/balances/check", {
      method: "POST", body: JSON.stringify({ names }),
    }),

  listPools: () => req<{ pools: PoolView[] }>("/api/pools"),
  detectPool: (address: string) =>
    req<PoolDetectionResult>(`/api/pool-detect?address=${encodeURIComponent(address)}`),
  poolTokenBalances: (poolId: string, names: string[]) =>
    req<{ mint: string; balances: Record<string, number | null> }>(
      `/api/pools/${encodeURIComponent(poolId)}/token-balances?names=${encodeURIComponent(names.join(","))}`,
    ),
  addPool: (input: {
    id: string; name?: string; type: PoolType; pool_address: string; token_mint: string;
    watch_graduation?: boolean; use_default_strategy?: boolean;
  }) => req<PoolView>("/api/pools", { method: "POST", body: JSON.stringify(input) }),
  saveSequencer: (id: string, sequencer: SequencerConfig) =>
    req<PoolView>(`/api/pools/${encodeURIComponent(id)}/sequencer`, {
      method: "PUT", body: JSON.stringify(sequencer),
    }),
  withdrawControlWallet: (opts: { destination: string; lamports?: number; sweep?: boolean }) =>
    req<{ ok: true; signature: string; lamports: number }>(
      "/api/control-wallet/withdraw",
      { method: "POST", body: JSON.stringify(opts) },
    ),
  deletePool: (id: string) =>
    req<{ ok: true }>(`/api/pools/${encodeURIComponent(id)}`, { method: "DELETE" }),

  defaultSequencer: () => req<SequencerConfig>("/api/sequencer/default"),

  listSequences: () => req<{ sequences: SavedSequence[] }>("/api/sequences"),
  createSequence: (input: { name: string } & SequencerPreset) =>
    req<SavedSequence>("/api/sequences", { method: "POST", body: JSON.stringify(input) }),
  updateSequence: (id: string, patch: Partial<{ name: string } & SequencerPreset>) =>
    req<SavedSequence>(`/api/sequences/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify(patch),
    }),
  deleteSequence: (id: string) =>
    req<{ ok: true }>(`/api/sequences/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** SOL (native) → pool token via Jupiter v6. Mainnet + real spend. */
  jupiterSwapSolToToken: (input: {
    walletName: string;
    poolId: string;
    solAmount: number;
    slippageBps?: number;
  }) => req<{ ok: true; signature: string }>("/api/swap/jupiter-sol-to-token", {
    method: "POST", body: JSON.stringify(input),
  }),

  /** Pool token → SOL (native) via Jupiter v6. Mainnet + real spend. */
  jupiterSwapTokenToSol: (input: {
    walletName: string;
    poolId: string;
    tokenAmount: number;
    slippageBps?: number;
  }) => req<{ ok: true; signature: string }>("/api/swap/jupiter-token-to-sol", {
    method: "POST", body: JSON.stringify(input),
  }),

  tokenInfo: (mint: string) => req<TokenInfo>(`/api/token/${encodeURIComponent(mint)}`),

  /** Fire the next sequencer step immediately. */
  sequencerFire: (poolId: string) =>
    req<{ ok: true; signature: string; cursor: number }>(
      `/api/pools/${encodeURIComponent(poolId)}/sequencer/fire`,
      { method: "POST" },
    ),
  /** Reset the sequencer cursor to position 0. */
  sequencerReset: (poolId: string) =>
    req<{ ok: true; cursor: number }>(
      `/api/pools/${encodeURIComponent(poolId)}/sequencer/reset`,
      { method: "POST" },
    ),
  /** ARM: distribute SOL from control wallet to all sequence wallets. */
  sequencerArm: (poolId: string) =>
    req<{ ok: true; results: { walletName: string; ok: boolean; sig?: string; lamports?: number; balanceLamports?: number; error?: string }[]; allReady: boolean }>(
      `/api/pools/${encodeURIComponent(poolId)}/sequencer/arm`,
      { method: "POST" },
    ),
  /** CLEANUP: drain SOL from all sequence wallets back to control wallet. */
  sequencerCleanup: (poolId: string) =>
    req<{ ok: true; results: { walletName: string; ok: boolean; sig?: string; tokenSellSig?: string; tokenRawAmount?: string; lamports?: number; balanceLamports?: number; skipped?: boolean; error?: string }[] }>(
      `/api/pools/${encodeURIComponent(poolId)}/sequencer/cleanup`,
      { method: "POST" },
    ),

};
