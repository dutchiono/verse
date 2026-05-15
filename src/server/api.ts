import type { Server, ServerWebSocket } from "bun";
import { Connection, PublicKey } from "@solana/web3.js";
import { makeLogger } from "../core/logger.ts";
import { session } from "../core/state.ts";
import {
  pools,
  CONTROL_WALLET_NAME,
  defaultStrategy,
  defaultSequencer,
  type PoolConfig,
  type StrategyConfig,
  type SequencerConfig,
  type SequencerStep,
  type StrategyAssignment,
  type PoolType,
} from "../core/pools-store.ts";
import { sequences } from "../core/sequences-store.ts";
import { swapSolForToken, swapTokenForSol } from "../core/jupiter-swap.ts";
import { transferSol, drainSol } from "../core/sol-transfer.ts";
import { getWalletTokenUiBalance, getWalletTokenBalance } from "../core/token-ata-balance.ts";
import type { AffixKind } from "../core/wallets.ts";
import type { TokenInfoClient } from "../core/token-info.ts";
import { getDbcPoolPrice } from "../core/meteora-client.ts";
import { detectPoolType } from "../core/pool-detect.ts";
import type { ArmProgressEvent, SequencerRunner, StepEvent, StepErrorEvent } from "../core/sequencer-runner.ts";
import { users, type UserRole } from "../core/users-store.ts";

const log = makeLogger("server");

// ── Token store ──────────────────────────────────────────────────────────────
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const tokens = new Map<string, { username: string; expiresAt: number }>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, { count: number; firstFailureAt: number; lockUntil: number | null }>();

function createToken(username: string): string {
  if (tokens.size > 1000) {
    const now = Date.now();
    for (const [k, v] of tokens) { if (now > v.expiresAt) tokens.delete(k); }
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  tokens.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ip = forwarded.split(",")[0]?.trim();
    if (ip) return ip;
  }
  return "unknown";
}

function loginKey(ip: string, username: string): string {
  return `${ip}:${username.toLowerCase().trim()}`;
}

function clearLoginFailure(key: string) {
  loginFailures.delete(key);
}

function getLoginFailure(key: string) {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec) return null;
  if (rec.lockUntil && now > rec.lockUntil) {
    loginFailures.delete(key);
    return null;
  }
  if (now - rec.firstFailureAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }
  return rec;
}

function noteLoginFailure(key: string) {
  const now = Date.now();
  const current = getLoginFailure(key);
  const count = (current?.count ?? 0) + 1;
  const next = {
    count,
    firstFailureAt: current?.firstFailureAt ?? now,
    lockUntil: count >= LOGIN_MAX_FAILURES ? (now + LOGIN_LOCK_MS) : null,
  };
  loginFailures.set(key, next);
  return next;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

function validateRequest(req: Request): string | null {
  const token = extractToken(req);
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { tokens.delete(token); return null; }
  return rec.username;
}

interface AuthedUser {
  username: string;
  role: UserRole;
  isAdmin: boolean;
}

function getAuthedUser(req: Request): AuthedUser | null {
  const username = validateRequest(req);
  if (!username) return null;
  const user = users.get(username);
  if (!user) return null;
  return { username: user.username, role: user.role, isAdmin: user.role === "admin" };
}

function requireAdmin(user: AuthedUser | null): asserts user is AuthedUser {
  if (!user || !user.isAdmin) throw new Error("admin access required");
}

function validateWs(url: URL): string | null {
  const token = url.searchParams.get("token");
  if (!token) return null;
  const rec = tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { tokens.delete(token); return null; }
  return rec.username;
}

interface WsData {
  id: number;
  username: string;
}

interface Context {
  conn: Connection;
  readConn: Connection;
  tokenInfo: TokenInfoClient;
  sequencer: SequencerRunner;
  broadcast: (payload: unknown) => void;
}

const VALID_AFFIX: AffixKind[] = ["prefix", "suffix", "none"];
const VALID_POOL_TYPES: PoolType[] = [
  "meteora-dbc",
  "meteora-damm",
  "pumpfun-bc",
  "pumpfun-amm",
  "raydium-v4",
  "raydium-cpmm",
];
const VALID_STRATEGY_MODES = ["accumulate", "dip-only", "exit-only", "watch"] as const;
const BALANCE_CHECK_REQUESTS_PER_WINDOW = 35;
const BALANCE_CHECK_WINDOW_MS = 11000;
const BALANCE_CHECK_INTERVAL_MS = Math.ceil(BALANCE_CHECK_WINDOW_MS / BALANCE_CHECK_REQUESTS_PER_WINDOW);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRateLimitError(e: unknown): boolean {
  return (e as Error).message.includes("429") || (e as Error).message.toLowerCase().includes("too many requests");
}
async function parseBody<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("invalid JSON body");
  }
}
function requireUnlocked(): void {
  if (!session.isUnlocked()) {
    const snap = session.snapshot();
    if (snap.state === "fresh") throw new Error("session is fresh — call /api/unlock to set a password first");
    throw new Error("session is locked");
  }
}
function poolView(p: PoolConfig) {
  return { ...p, watching: false, lastSlot: null, lastUpdate: null };
}

export function startServer(port: number, base: Omit<Context, "broadcast">): Server<WsData> {
  const clients = new Set<ServerWebSocket<WsData>>();
  let nextClientId = 1;
  const hostname = process.env.SERVER_HOST?.trim() || "127.0.0.1";

  const broadcast = (payload: unknown) => {
    const s = JSON.stringify(payload);
    for (const client of clients) client.send(s);
  };

  const ctx: Context = { ...base, broadcast };

  ctx.sequencer.on("step", (e: StepEvent) => {
    ctx.broadcast({ type: "sequencer-step", ...e });
  });
  ctx.sequencer.on("step-error", (e: StepErrorEvent) => {
    ctx.broadcast({ type: "sequencer-step-error", ...e });
  });
  ctx.sequencer.on("run-complete", (poolId: string) => {
    ctx.broadcast({ type: "sequencer-run-complete", poolId });
  });

  session.on("change", () => ctx.broadcast({ type: "session-change", snapshot: session.snapshot() }));
  pools.on("change", () => ctx.broadcast({ type: "pools-change" }));
  sequences.on("change", () => ctx.broadcast({ type: "sequences-change" }));

  const server = Bun.serve<WsData, never>({
    hostname,
    port,
    idleTimeout: 120,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const startedAt = Date.now();
      if (url.pathname === "/ws") {
        const wsUsername = validateWs(url);
        if (!wsUsername) return new Response("unauthorized", { status: 401 });
        const ok = srv.upgrade(req, { data: { id: nextClientId++, username: wsUsername } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      try {
        const res = (await route(req, url, ctx)) ?? new Response("not found", { status: 404 });
        const ms = Date.now() - startedAt;
        if (ms >= 1000) {
          log.warn("slow request", { method: req.method, path: url.pathname, ms });
        }
        return res;
      } catch (e) {
        const msg = (e as Error).message;
        log.warn("route error", { method: req.method, path: url.pathname, msg, ms: Date.now() - startedAt });
        return err(msg, 400);
      }
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "hello", clientId: ws.data.id, snapshot: session.snapshot() }));
      },
      message(_ws, _msg) {},
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  log.info(`http+ws server listening on http://${hostname}:${port}`);
  return server;
}

async function route(req: Request, url: URL, ctx: Context): Promise<Response | undefined> {
  const { method } = req;
  const path = url.pathname;

  // ── Auth (unprotected) ────────────────────────────────────────────────────
  if (path === "/api/auth/login" && method === "POST") {
    const body = await parseBody<{ username?: string; password?: string }>(req);
    if (!body.username || !body.password) return err("username and password required", 400);
    const ip = getClientIp(req);
    const key = loginKey(ip, body.username);
    const failure = getLoginFailure(key);
    if (failure?.lockUntil && failure.lockUntil > Date.now()) {
      return err("too many failed login attempts, try again later", 429);
    }
    const ok = await users.verify(body.username, body.password);
    if (!ok) {
      const next = noteLoginFailure(key);
      if (next.lockUntil && next.lockUntil > Date.now()) {
        return err("too many failed login attempts, try again later", 429);
      }
      return err("invalid username or password", 401);
    }
    clearLoginFailure(key);
    const user = users.get(body.username.trim());
    if (!user) return err("invalid username or password", 401);
    const token = createToken(user.username);
    log.info("user login", { username: user.username, role: user.role, ip });
    return json({ token, username: user.username, role: user.role, isAdmin: user.role === "admin" });
  }

  if (path === "/api/auth/me" && method === "GET") {
    const authed = getAuthedUser(req);
    if (!authed) return json({ authenticated: false });
    return json({ authenticated: true, username: authed.username, role: authed.role, isAdmin: authed.isAdmin });
  }
  if (path === "/api/auth/bootstrap" && method === "GET") {
    return json({ hasUsers: users.count() > 0 });
  }

  // First-user bootstrap: allow POST /api/users with no auth if no users exist
  const isBootstrap = path === "/api/users" && method === "POST" && users.count() === 0;

  // ── Auth middleware ───────────────────────────────────────────────────────
  const authedUser = isBootstrap ? null : getAuthedUser(req);
  if (!isBootstrap && !authedUser) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  const isWriteMethod = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const userPathMatch = path.match(/^\/api\/users\/([^/]+)$/);
  const targetUser = userPathMatch ? decodeURIComponent(userPathMatch[1]!) : null;
  const isSelfPasswordChange = Boolean(
    authedUser &&
      method === "PUT" &&
      targetUser &&
      targetUser.toLowerCase() === authedUser.username.toLowerCase(),
  );
  const allowNonAdminWrite = path === "/api/auth/logout" || isSelfPasswordChange;
  if (!isBootstrap && authedUser && isWriteMethod && !allowNonAdminWrite) {
    requireAdmin(authedUser);
  }

  // ── Auth (protected) ──────────────────────────────────────────────────────
  if (path === "/api/auth/logout" && method === "POST") {
    const token = extractToken(req);
    if (token) tokens.delete(token);
    return json({ ok: true });
  }

  // ── User management ───────────────────────────────────────────────────────
  if (path === "/api/users" && method === "GET") {
    requireAdmin(authedUser);
    return json({ users: users.list(), total: users.count() });
  }
  if (path === "/api/users" && method === "POST") {
    const body = await parseBody<{ username?: string; password?: string }>(req);
    if (!body.username || !body.password) return err("username and password required");
    const user = await users.add(body.username, body.password, isBootstrap ? "admin" : "operator");
    return json(user, 201);
  }
  if (userPathMatch) {
    const name = decodeURIComponent(userPathMatch[1]!);
    if (method === "DELETE") {
      if (authedUser?.username.toLowerCase() === name.toLowerCase()) return err("cannot delete your own account");
      users.remove(name);
      return json({ ok: true });
    }
    if (method === "PUT") {
      const { newPassword } = await parseBody<{ newPassword?: string }>(req);
      if (!newPassword) return err("newPassword required");
      await users.changePassword(name, newPassword);
      return json({ ok: true });
    }
  }

  // --- Session ---
  if (path === "/api/state" && method === "GET") return json(session.snapshot());
  if (path === "/api/unlock" && method === "POST") {
    const { password } = await parseBody<{ password?: string }>(req);
    if (!password || password.length < 8) return err("password must be at least 8 chars");
    try {
      return json(session.unlock(password));
    } catch (e) {
      return err((e as Error).message, 401);
    }
  }
  if (path === "/api/lock" && method === "POST") {
    session.lock();
    return json(session.snapshot());
  }
  if (path === "/api/rotate-password" && method === "POST") {
    requireUnlocked();
    const { newPassword } = await parseBody<{ newPassword?: string }>(req);
    if (!newPassword || newPassword.length < 8) return err("newPassword must be at least 8 chars");
    session.rotatePassword(newPassword);
    return json({ ok: true });
  }

  // --- Wallets ---
  if (path === "/api/wallets" && method === "GET") {
    return json({ wallets: session.listPublic() });
  }
  if (path === "/api/wallets" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      name?: string;
      secret?: string;
      label?: string;
      affix?: AffixKind;
      notes?: string;
    }>(req);
    if (!body.name) return err("name required");
    if (!body.secret) return err("secret (private key) required");
    if (body.affix && !VALID_AFFIX.includes(body.affix)) return err("affix must be prefix|suffix|none");
    const rec = session.addWallet({
      name: body.name,
      secret: body.secret,
      label: body.label ?? "",
      affix: body.affix ?? "none",
      notes: body.notes,
    });
    return json(rec);
  }

  if (path === "/api/wallets/bulk" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      wallets?: Array<{ name?: string; secret?: string; label?: string; affix?: AffixKind; notes?: string }>;
    }>(req);
    if (!Array.isArray(body.wallets)) return err("wallets must be an array");
    // Per-row validation happens inside addWalletsBulk; fail fast on global shape only.
    for (const w of body.wallets) {
      if (w.affix && !VALID_AFFIX.includes(w.affix)) return err(`invalid affix: ${w.affix}`);
    }
    const result = session.addWalletsBulk(
      body.wallets.map((w) => ({
        name: w.name ?? "",
        secret: w.secret ?? "",
        label: w.label ?? "",
        affix: w.affix ?? "none",
        notes: w.notes,
      })),
    );
    return json(result);
  }

  if (path === "/api/wallets/bulk-update" && method === "PATCH") {
    requireUnlocked();
    const body = await parseBody<{
      names?: string[];
      patch?: { label?: string; affix?: AffixKind; enabled?: boolean; notes?: string };
    }>(req);
    if (!Array.isArray(body.names) || body.names.length === 0) return err("names required");
    const patch = body.patch ?? {};
    if (patch.affix && !VALID_AFFIX.includes(patch.affix)) return err("affix must be prefix|suffix|none");
    const rows = session.updateWallets(body.names, patch);
    return json({ wallets: rows });
  }

  const walletMatch = path.match(/^\/api\/wallets\/([^/]+)$/);
  if (walletMatch) {
    requireUnlocked();
    const name = decodeURIComponent(walletMatch[1]!);
    if (method === "PATCH") {
      const body = await parseBody<{ label?: string; affix?: AffixKind; enabled?: boolean; notes?: string }>(req);
      if (body.affix && !VALID_AFFIX.includes(body.affix)) return err("affix must be prefix|suffix|none");
      const rec = session.updateWallet(name, body);
      return json(rec);
    }
    if (method === "DELETE") {
      session.deleteWallet(name);
      pools.removeWalletEverywhere(name);
      return json({ ok: true });
    }
  }

  if (path === "/api/wallets/balances" && method === "GET") {
    const requested = new Set((url.searchParams.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    if (requested.size === 0) return err("names query param required", 400);
    const list = session.listPublic().filter((w) => requested.has(w.name));
    const balances: Record<string, number | null> = {};
    if (list.length > 0) {
      try {
        const pubkeys = list.map((w) => new PublicKey(w.pubkey));
        const infos = await ctx.readConn.getMultipleAccountsInfo(pubkeys, "confirmed");
        for (let i = 0; i < list.length; i++) {
          balances[list[i]!.name] = infos[i]?.lamports ?? null;
        }
      } catch {
        for (const w of list) balances[w.name] = null;
      }
    }
    return json({ balances });
  }

  if (path === "/api/wallets/balances/check" && method === "POST") {
    const body = await parseBody<{ names?: string[] }>(req);
    const requested = Array.isArray(body.names) ? [...new Set(body.names.map((s) => s.trim()).filter(Boolean))] : [];
    if (requested.length === 0) return err("names required", 400);
    const requestedSet = new Set(requested);
    const list = session.listPublic().filter((w) => requestedSet.has(w.name));
    const balances: Record<string, number | null> = {};
    log.info("wallet balance check started", {
      requested: requested.length,
      found: list.length,
      requestsPerWindow: BALANCE_CHECK_REQUESTS_PER_WINDOW,
      windowMs: BALANCE_CHECK_WINDOW_MS,
      intervalMs: BALANCE_CHECK_INTERVAL_MS,
    });
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      const startedAt = Date.now();
      ctx.broadcast({ type: "wallet-balance-progress", walletName: w.name, status: "checking" });
      try {
        const pubkey = new PublicKey(w.pubkey);
        let balanceLamports: number;
        try {
          balanceLamports = await ctx.readConn.getBalance(pubkey, "confirmed");
        } catch (firstErr) {
          if (!isRateLimitError(firstErr)) throw firstErr;
          log.warn("wallet balance rate limited; pausing before retry", {
            walletName: w.name,
            waitMs: BALANCE_CHECK_WINDOW_MS,
            err: (firstErr as Error).message,
          });
          await sleep(BALANCE_CHECK_WINDOW_MS);
          balanceLamports = await ctx.readConn.getBalance(pubkey, "confirmed");
        }
        balances[w.name] = balanceLamports;
        log.info("wallet balance checked", {
          walletName: w.name,
          sol: balanceLamports / 1e9,
          request: i + 1,
          total: list.length,
          intervalMs: BALANCE_CHECK_INTERVAL_MS,
        });
        ctx.broadcast({ type: "wallet-balance-progress", walletName: w.name, status: "done", balanceLamports });
      } catch (e) {
        balances[w.name] = null;
        log.warn("wallet balance check failed", { walletName: w.name, err: (e as Error).message });
        ctx.broadcast({
          type: "wallet-balance-progress",
          walletName: w.name,
          status: "error",
          error: (e as Error).message,
        });
      }
      const hasMore = i < list.length - 1;
      if (hasMore) {
        const elapsed = Date.now() - startedAt;
        const waitMs = Math.max(0, BALANCE_CHECK_INTERVAL_MS - elapsed);
        if (waitMs > 0) await sleep(waitMs);
      }
    }
    log.info("wallet balance check finished", { checked: list.length });
    return json({ balances });
  }

  // --- Pool detect ---
  if (path === "/api/pool-detect" && method === "GET") {
    const address = url.searchParams.get("address");
    if (!address) return err("address query param required");
    const result = await detectPoolType(ctx.conn, address);
    return json(result);
  }

  // --- Pools ---
  if (path === "/api/pools" && method === "GET") {
    return json({ pools: pools.list().map(poolView) });
  }
  if (path === "/api/pools" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      id?: string;
      name?: string;
      type?: PoolType;
      pool_address?: string;
      token_mint?: string;
      watch_graduation?: boolean;
      use_default_strategy?: boolean;
    }>(req);
    if (!body.id) return err("id required");
    if (!body.type || !VALID_POOL_TYPES.includes(body.type)) return err(`type must be one of ${VALID_POOL_TYPES.join(",")}`);
    if (!body.pool_address) return err("pool_address required");
    if (!body.token_mint) return err("token_mint required");
    const pool = pools.add({
      id: body.id,
      name: body.name || body.id,
      type: body.type,
      pool_address: body.pool_address,
      token_mint: body.token_mint,
      watch_graduation: body.watch_graduation,
      strategy: body.use_default_strategy ? defaultStrategy() : null,
    });
    return json(poolView(pool));
  }

  // Withdraw SOL from control wallet: POST /api/pools/:id/control-wallet/withdraw
  const ctrlWithdrawMatch = path.match(/^\/api\/pools\/([^/]+)\/control-wallet\/withdraw$/);
  if (ctrlWithdrawMatch && method === "POST") {
    requireUnlocked();
    const id = decodeURIComponent(ctrlWithdrawMatch[1]!);
    const pool = pools.get(id);
    if (!pool) return err(`pool not found: ${id}`, 404);
    if (!pool.control_wallet_name) return err("no control wallet set on this pool");
    const body = await parseBody<{ destination?: string; lamports?: number; sweep?: boolean }>(req);
    if (!body.destination) return err("destination required");
    let destPk: PublicKey;
    try { destPk = new PublicKey(body.destination); }
    catch { return err("invalid destination pubkey"); }
    const ctrl = session.getLoadedByName(pool.control_wallet_name);
    if (!ctrl) return err(`control wallet "${pool.control_wallet_name}" not loaded (disabled?)`);
    if (ctrl.pubkey === destPk.toBase58()) return err("destination is the control wallet itself");
    try {
      if (body.sweep) {
        const r = await drainSol(ctx.conn, ctrl.keypair, destPk);
        if (!r) return err("balance below dust threshold — nothing to send");
        return json({ ok: true, signature: r.sig, lamports: r.lamports });
      }
      if (typeof body.lamports !== "number" || !Number.isFinite(body.lamports) || body.lamports <= 0) {
        return err("lamports must be a positive number, or set sweep=true");
      }
      const amount = Math.floor(body.lamports);
      const sig = await transferSol(ctx.conn, ctrl.keypair, destPk, amount);
      return json({ ok: true, signature: sig, lamports: amount });
    } catch (e) {
      return err((e as Error).message, 502);
    }
  }

  // Nested sequencer actions: POST /api/pools/:id/sequencer/(fire|reset|arm|cleanup)
  const seqFireMatch = path.match(/^\/api\/pools\/([^/]+)\/sequencer\/(fire|reset|arm|cleanup)$/);
  if (seqFireMatch && method === "POST") {
    requireUnlocked();
    const id = decodeURIComponent(seqFireMatch[1]!);
    const action = seqFireMatch[2]!;
    const pool = pools.get(id);
    if (!pool) return err(`pool not found: ${id}`, 404);

    if (action === "reset") {
      ctx.sequencer.resetCursor(id);
      return json({ ok: true, cursor: 0 });
    }

    if (action === "arm") {
      const body = await parseBody<{ controlWalletName: string }>(req);
      if (!body?.controlWalletName) return err("controlWalletName required");
      if (pool.sequencer.queue.length === 0) return err("sequencer queue is empty");
      try {
        const results = await ctx.sequencer.arm(pool, body.controlWalletName, (event: ArmProgressEvent) => {
          ctx.broadcast({ type: "sequencer-arm-progress", poolId: id, ...event });
        });
        const allReady = results.length > 0 && results.every((r) => r.ok);
        return json({ ok: true, results, allReady });
      } catch (e) {
        return err((e as Error).message, 502);
      }
    }

    if (action === "cleanup") {
      const body = await parseBody<{ controlWalletName: string }>(req);
      if (!body?.controlWalletName) return err("controlWalletName required");
      try {
        const results = await ctx.sequencer.cleanup(
          pool,
          session.listPublic().map((w) => w.name),
          body.controlWalletName,
        );
        return json({ ok: true, results });
      } catch (e) {
        return err((e as Error).message, 502);
      }
    }

    // fire
    if (pool.sequencer.queue.length === 0) return err("sequencer queue is empty");
    try {
      const sig = await ctx.sequencer.fireNext(pool);
      return json({ ok: true, signature: sig, cursor: ctx.sequencer.getCursor(id) });
    } catch (e) {
      return err((e as Error).message, 502);
    }
  }

  const poolMatch = path.match(
    /^\/api\/pools\/([^/]+)(\/(strategy|sequencer|strategy-wallets|control-wallet|token-balances|price))?$/,
  );
  if (poolMatch) {
    const id = decodeURIComponent(poolMatch[1]!);
    const action = poolMatch[3];
    const existing = pools.get(id);
    if (!existing) return err(`pool not found: ${id}`, 404);

    if (!action && method === "GET") return json(poolView(existing));
    if (action === "token-balances" && method === "GET") {
      const mint = existing.token_mint;
      const requested = new Set((url.searchParams.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      if (requested.size === 0) return err("names query param required", 400);
      const publicWallets = session.listPublic();
      const list = publicWallets.filter((w) => requested.has(w.name));
      const balances: Record<string, number | null> = {};
      for (const w of list) balances[w.name] = null;
      for (const w of list) {
        try {
          balances[w.name] = await getWalletTokenUiBalance(ctx.readConn, w.pubkey, mint);
        } catch {
          balances[w.name] = null;
        }
      }
      return json({ mint, balances });
    }
    if (action === "price" && method === "GET") {
      if (existing.type !== "meteora-dbc") {
        return json({ error: "price only available for meteora-dbc pools" }, 400);
      }
      let tokenDecimals = 6;
      let totalSupply: number | null = null;
      try {
        const info = await ctx.tokenInfo.get(existing.token_mint);
        tokenDecimals = info?.decimals ?? 6;
        totalSupply = info?.supply ?? null;
      } catch { /* non-critical */ }
      const price = await getDbcPoolPrice(
        ctx.conn,
        existing.pool_address,
        tokenDecimals,
        totalSupply,
      );
      if (!price) return json({ error: "price unavailable" }, 503);
      return json(price);
    }

    if (!action && method === "PATCH") {
      requireUnlocked();
      const body = await parseBody<Partial<PoolConfig>>(req);
      delete (body as any).id;
      const updated = pools.update(id, body);
      return json(poolView(updated));
    }
    if (!action && method === "DELETE") {
      requireUnlocked();
      pools.remove(id);
      return json({ ok: true });
    }
    if (action === "strategy" && method === "PUT") {
      requireUnlocked();
      const strategy = (await parseBody<StrategyConfig>(req)) as StrategyConfig;
      const updated = pools.update(id, { strategy });
      return json(poolView(updated));
    }
    if (action === "sequencer" && method === "PUT") {
      requireUnlocked();
      const newSeq = (await parseBody<SequencerConfig>(req)) as SequencerConfig;
      const known = new Set(session.listPublic().map((w) => w.name));
      for (const s of newSeq.queue) {
        if (!known.has(s.walletName)) return err(`unknown wallet in sequencer queue: ${s.walletName}`);
      }
      const updated = pools.update(id, { sequencer: newSeq });
      const wasActive = existing.sequencer.active;
      if (newSeq.active && !wasActive) {
        ctx.sequencer.start(updated);
      } else if (!newSeq.active && wasActive) {
        ctx.sequencer.stop(id);
      }
      ctx.broadcast({
        type: "sequencer-change",
        poolId: id,
        active: newSeq.active,
        queueLen: newSeq.queue.length,
      });
      return json(poolView(updated));
    }
    if (action === "control-wallet" && method === "PUT") {
      requireUnlocked();
      await parseBody<{ walletName: string | null }>(req);
      const known = new Set(session.listPublic().map((w) => w.name));
      if (!known.has(CONTROL_WALLET_NAME)) return err(`unknown wallet: ${CONTROL_WALLET_NAME}`);
      if (existing.sequencer.queue.some((s) => s.walletName === CONTROL_WALLET_NAME)) {
        return err(`"${CONTROL_WALLET_NAME}" is in the sequencer queue — remove it first`);
      }
      const updated = pools.update(id, { control_wallet_name: CONTROL_WALLET_NAME });
      return json(poolView(updated));
    }
    if (action === "strategy-wallets" && method === "PUT") {
      requireUnlocked();
      const body = (await parseBody<{ assignments: StrategyAssignment[] }>(req));
      if (!Array.isArray(body.assignments)) return err("assignments must be an array");
      const known = new Set(session.listPublic().map((w) => w.name));
      for (const a of body.assignments) {
        if (!known.has(a.walletName)) return err(`unknown wallet: ${a.walletName}`);
        if (!VALID_STRATEGY_MODES.includes(a.mode)) return err(`invalid mode: ${a.mode}`);
      }
      const updated = pools.update(id, { strategy_wallets: body.assignments });
      return json(poolView(updated));
    }
  }

  if (path === "/api/strategy/default" && method === "GET") return json(defaultStrategy());
  if (path === "/api/sequencer/default" && method === "GET") return json(defaultSequencer());

  if (path === "/api/sequences" && method === "GET") {
    return json({ sequences: sequences.list() });
  }
  if (path === "/api/sequences" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      name?: string;
      queue?: SequencerStep[];
      action?: SequencerConfig["action"];
      schedule?: SequencerConfig["schedule"];
      size?: SequencerConfig["size"];
      loop_mode?: SequencerConfig["loop_mode"];
    }>(req);
    if (!body.name?.trim()) return err("name required");
    if (!body.queue || !body.action || !body.schedule || !body.size || !body.loop_mode) {
      return err("queue, action, schedule, size, and loop_mode are required");
    }
    const known = new Set(session.listPublic().map((w) => w.name));
    for (const step of body.queue) {
      if (!known.has(step.walletName)) return err(`unknown wallet in queue: ${step.walletName}`);
    }
    const row = sequences.add({
      name: body.name.trim(),
      queue: body.queue,
      action: body.action,
      schedule: body.schedule,
      size: body.size,
      loop_mode: body.loop_mode,
    });
    return json(row);
  }

  const seqMatch = path.match(/^\/api\/sequences\/([^/]+)$/);
  if (seqMatch) {
    const sid = decodeURIComponent(seqMatch[1]!);
    if (method === "GET") {
      const s = sequences.get(sid);
      if (!s) return err("sequence not found", 404);
      return json(s);
    }
    if (method === "PUT") {
      requireUnlocked();
      const patch = await parseBody<Partial<{
        name: string;
        queue: SequencerStep[];
        action: SequencerConfig["action"];
        schedule: SequencerConfig["schedule"];
        size: SequencerConfig["size"];
        loop_mode: SequencerConfig["loop_mode"];
      }>>(req);
      if (patch.queue) {
        const known = new Set(session.listPublic().map((w) => w.name));
        for (const step of patch.queue) {
          if (!known.has(step.walletName)) return err(`unknown wallet in queue: ${step.walletName}`);
        }
      }
      const updated = sequences.update(sid, patch);
      return json(updated);
    }
    if (method === "DELETE") {
      requireUnlocked();
      sequences.remove(sid);
      return json({ ok: true });
    }
  }

  if (path === "/api/swap/jupiter-sol-to-token" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      walletName?: string;
      poolId?: string;
      solAmount?: number;
      slippageBps?: number;
    }>(req);
    if (!body.walletName) return err("walletName required");
    if (!body.poolId) return err("poolId required");
    if (body.solAmount === undefined || !(body.solAmount > 0)) return err("solAmount must be > 0");
    const pool = pools.get(body.poolId);
    if (!pool) return err(`pool not found: ${body.poolId}`, 404);
    const loaded = session.getLoadedByName(body.walletName);
    if (!loaded) return err(`wallet not loaded: ${body.walletName}`);
    const slippage = body.slippageBps ?? 150;
    if (slippage < 1 || slippage > 2500) return err("slippageBps must be 1..2500");
    const lamports = Math.floor(body.solAmount * 1e9);
    try {
      const signature = await swapSolForToken({
        connection: ctx.conn,
        wallet: loaded.keypair,
        outputMint: pool.token_mint,
        lamports,
        slippageBps: slippage,
      });
      return json({ ok: true, signature });
    } catch (e) {
      return err((e as Error).message, 502);
    }
  }

  if (path === "/api/swap/jupiter-token-to-sol" && method === "POST") {
    requireUnlocked();
    const body = await parseBody<{
      walletName?: string;
      poolId?: string;
      tokenAmount?: number;
      slippageBps?: number;
    }>(req);
    if (!body.walletName) return err("walletName required");
    if (!body.poolId) return err("poolId required");
    if (body.tokenAmount === undefined || !(body.tokenAmount > 0)) return err("tokenAmount must be > 0");
    const pool = pools.get(body.poolId);
    if (!pool) return err(`pool not found: ${body.poolId}`, 404);
    const loaded = session.getLoadedByName(body.walletName);
    if (!loaded) return err(`wallet not loaded: ${body.walletName}`);
    const slippage = body.slippageBps ?? 150;
    if (slippage < 1 || slippage > 2500) return err("slippageBps must be 1..2500");

    const balInfo = await getWalletTokenBalance(ctx.conn, loaded.keypair.publicKey.toBase58(), pool.token_mint);
    if (!balInfo) return err("no token account found for this wallet + mint");
    const actualRaw = BigInt(balInfo.rawAmount);
    if (actualRaw <= 0n) return err("wallet has 0 tokens to sell");

    const requestedRaw = BigInt(Math.floor(body.tokenAmount * Math.pow(10, balInfo.decimals)));
    const rawAmount = requestedRaw > actualRaw ? actualRaw : requestedRaw;

    try {
      const signature = await swapTokenForSol({
        connection: ctx.conn,
        wallet: loaded.keypair,
        inputMint: pool.token_mint,
        rawAmount: Number(rawAmount),
        slippageBps: slippage,
      });
      return json({ ok: true, signature });
    } catch (e) {
      return err((e as Error).message, 502);
    }
  }

  const tokenMatch = path.match(/^\/api\/token\/([^/]+)$/);
  if (tokenMatch && method === "GET") {
    const mint = decodeURIComponent(tokenMatch[1]!);
    try {
      const info = await ctx.tokenInfo.get(mint);
      return json(info);
    } catch (e) {
      return err((e as Error).message, 502);
    }
  }

  return undefined;
}
