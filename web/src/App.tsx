import { useEffect, useMemo, useState, useRef } from "react";
import { api, authToken } from "./api";
import type { PoolView, SessionSnapshot, ServerEvent, WalletInfo, SavedSequence, WalletStatus } from "./types";
import { LockScreen } from "./components/LockScreen";
import { PoolsList } from "./components/PoolsList";
import { SequencesList } from "./components/SequencesList";
import { PoolDetail } from "./components/PoolDetail";
import { Roster } from "./components/Roster";
import { UsersPanel } from "./components/UsersPanel";
import { GuidePanel } from "./components/GuidePanel";
import { AddPoolModal } from "./components/AddPoolModal";
import { PaperGrain } from "./components/PaperGrain";

type View = "dashboard" | "roster" | "users" | "guide";
type WsState = "idle" | "connecting" | "open" | "closed";
type AuthState = "loading" | "no-users" | "unauthenticated" | "authenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [username, setUsername] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [wsState, setWsState] = useState<WsState>("idle");
  const [view, setView] = useState<View>("dashboard");
  const [pools, setPools] = useState<PoolView[]>([]);
  const [sequences, setSequences] = useState<SavedSequence[]>([]);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(null);
  const [selectedActionWalletName, setSelectedActionWalletName] = useState<string | null>(null);
  const [walletStatuses, setWalletStatuses] = useState<Record<string, WalletStatus>>({});
  const [solBalances, setSolBalances] = useState<Record<string, number | null>>({});
  const [showAddPool, setShowAddPool] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // ── Bootstrap auth check ─────────────────────────────────────────────────
  useEffect(() => {
    void checkAuth();

    // Listen for 401s fired from req()
    const onUnauthorized = () => {
      setAuthState("unauthenticated");
      setUsername(null);
      clearAppState();
    };
    window.addEventListener("verse-unauthorized", onUnauthorized);
    return () => window.removeEventListener("verse-unauthorized", onUnauthorized);
  }, []);

  async function checkAuth() {
    const token = authToken.get();
    if (!token) {
      await detectNoUsers();
      return;
    }
    try {
      const me = await api.me();
      if (!me.authenticated || !me.username) {
        authToken.clear();
        await detectNoUsers();
        return;
      }
      setUsername(me.username);
      setIsAdmin(Boolean(me.isAdmin));
      setAuthState("authenticated");
      void api.getState().then(setSnapshot).catch(() => {});
      void refreshAll();
    } catch {
      authToken.clear();
      await detectNoUsers();
    }
  }

  async function detectNoUsers() {
    try {
      const r = await api.bootstrap();
      setAuthState(r.hasUsers ? "unauthenticated" : "no-users");
    } catch {
      setAuthState("unauthenticated");
    }
  }

  async function handleLogout() {
    try { await api.logout(); } catch { /* ignore */ }
    authToken.clear();
    setUsername(null);
    setIsAdmin(false);
    setAuthState("unauthenticated");
    clearAppState();
    wsRef.current?.close();
  }

  function clearAppState() {
    setPools([]); setSequences([]); setWallets([]);
    setSelectedPoolId(null); setSelectedSequenceId(null);
    setWalletStatuses({}); setSolBalances({});
    setSnapshot(null);
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  async function refreshAll() {
    try {
      const [p, w, seq] = await Promise.all([
        api.listPools(),
        api.listWallets(),
        api.listSequences(),
      ]);
      setPools(p.pools);
      setWallets(w.wallets);
      setSequences(seq.sequences);
      if (!selectedPoolId && p.pools.length > 0) setSelectedPoolId(p.pools[0]!.id);
    } catch {}
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (authState !== "authenticated") return;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function wsUrl(): string {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = authToken.get() ?? "";
      const q = token ? `?token=${encodeURIComponent(token)}` : "";
      if (import.meta.env.DEV && import.meta.env.VITE_WS_DIRECT === "1") {
        const port = import.meta.env.VITE_API_PORT ?? "3000";
        return `${proto}//${window.location.hostname}:${port}/ws${q}`;
      }
      return `${proto}//${window.location.host}/ws${q}`;
    }

    function connect() {
      if (stopped) return;
      setWsState("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => { attempt = 0; setWsState("open"); };
      ws.onmessage = (ev) => {
        try { handleEvent(JSON.parse(ev.data) as ServerEvent); } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsState("closed");
        wsRef.current = null;
        if (stopped) return;
        attempt += 1;
        const delayMs = Math.min(30_000, 1500 * 2 ** Math.min(attempt - 1, 5));
        reconnectTimer = setTimeout(connect, delayMs);
      };
      ws.onerror = () => {};
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [authState]);

  function handleEvent(msg: ServerEvent) {
    if (msg.type === "hello" || msg.type === "session-change") {
      setSnapshot(msg.snapshot);
    } else if (msg.type === "pools-change" || msg.type === "sequences-change") {
      void refreshAll();
    } else if (msg.type === "sequencer-change" || msg.type === "sequencer-run-complete") {
      void refreshAll();
    } else if (msg.type === "sequencer-arm-progress") {
      setWalletStatus(msg.walletName, msg.status);
      if (msg.balanceLamports !== undefined) setWalletSolBalance(msg.walletName, msg.balanceLamports);
    } else if (msg.type === "wallet-balance-progress") {
      setWalletStatus(msg.walletName, msg.status);
      if (msg.balanceLamports !== undefined) setWalletSolBalance(msg.walletName, msg.balanceLamports);
    }
  }

  const enabledWallets = useMemo(() => wallets.filter((w) => w.enabled), [wallets]);

  function setWalletStatus(name: string, status: WalletStatus) {
    setWalletStatuses((prev) => ({ ...prev, [name]: status }));
  }
  function setWalletSolBalance(name: string, balance: number | null) {
    setSolBalances((prev) => ({ ...prev, [name]: balance }));
  }
  function mergeSolBalances(next: Record<string, number | null>) {
    setSolBalances((prev) => ({ ...prev, ...next }));
  }

  async function deletePool(poolId: string, name: string) {
    if (!confirm(`Delete pool "${name}"?`)) return;
    try {
      await api.deletePool(poolId);
      if (selectedPoolId === poolId) setSelectedPoolId(null);
      await refreshAll();
    } catch { /* ignore */ }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (authState === "loading") return <div className="bootstrap">connecting…</div>;

  if (authState === "no-users" || authState === "unauthenticated") {
    return <LockScreen noUsers={authState === "no-users"} onLogin={(token, user, admin) => {
      authToken.set(token);
      setUsername(user);
      setIsAdmin(admin);
      setAuthState("authenticated");
      void api.getState().then(setSnapshot).catch(() => {});
      void refreshAll();
    }} />;
  }

  const selectedPool = pools.find((p) => p.id === selectedPoolId) ?? null;
  const selectedSequence = sequences.find((s) => s.id === selectedSequenceId) ?? null;
  const selectedActionWallet = enabledWallets.find(
    (w) => w.name === selectedActionWalletName && w.name !== selectedPool?.control_wallet_name,
  ) ?? null;
  const fallbackActionWalletName = enabledWallets.find((w) => w.name !== selectedPool?.control_wallet_name)?.name ?? null;
  const quickSwapWalletName = selectedActionWallet?.name ?? fallbackActionWalletName;
  const dotClass = wsState === "open" ? "ok" : wsState === "closed" ? "bad" : "idle";

  return (
    <div className="shell">
      <PaperGrain />
      <header className="top-bar">
        <div className="brand">Verse</div>
        <nav className="top-nav">
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>Dashboard</button>
          <button className={view === "roster" ? "active" : ""} onClick={() => setView("roster")}>Roster ({wallets.length})</button>
          <button className={view === "users" ? "active" : ""} onClick={() => setView("users")}>Users</button>
          <button className={view === "guide" ? "active" : ""} onClick={() => setView("guide")}>Guide</button>
        </nav>
        <div className="top-right">
          <a
            className="github-link"
            href="https://github.com/dutchiono/verse"
            target="_blank"
            rel="noreferrer"
            title="View on GitHub"
          >
            <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87
                2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
                0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12
                0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04
                2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15
                0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
                0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
          <span className="small muted" style={{ marginRight: 4 }}>{username}</span>
          <span className="status">
            <span className={`dot ${dotClass}`} />
            {wsState}
          </span>
          <button className="ghost" onClick={() => void handleLogout()}>sign out</button>
        </div>
      </header>

      {view === "guide" ? (
        <main className="guide-view">
          <GuidePanel />
        </main>
      ) : view === "users" ? (
        <main className="roster-view">
          <UsersPanel currentUsername={username!} isAdmin={isAdmin} />
        </main>
      ) : view === "dashboard" ? (
        <main className="dashboard">
          <aside className="left-rail">
            <section className="rail-section">
              <div className="rail-head">
                <span className="rail-title">POOLS</span>
                <button className="ghost small" onClick={() => setShowAddPool(true)}>+ add</button>
              </div>
              <PoolsList
                pools={pools}
                selectedId={selectedPoolId}
                onSelect={setSelectedPoolId}
                onDeletePool={(id, name) => void deletePool(id, name)}
              />
            </section>
            <section className="rail-section">
              <div className="rail-head">
                <span className="rail-title">SEQUENCES</span>
              </div>
              <SequencesList
                sequences={sequences}
                selectedId={selectedSequenceId}
                wallets={enabledWallets}
                onSelect={setSelectedSequenceId}
              />
            </section>
          </aside>

          <section className="main-pane">
            <PoolDetail
              pool={selectedPool}
              wallets={enabledWallets}
              selectedWalletName={quickSwapWalletName}
              onSelectWallet={setSelectedActionWalletName}
              selectedSequence={selectedSequence}
              onChanged={refreshAll}
              onWalletStatus={setWalletStatus}
              walletStatuses={walletStatuses}
              solBalances={solBalances}
              onSolBalances={mergeSolBalances}
            />
          </section>
        </main>
      ) : (
        <main className="roster-view">
          <Roster
            wallets={wallets}
            pools={pools}
            selectedPoolId={selectedPoolId}
            selectedWalletName={quickSwapWalletName}
            onSelectWallet={setSelectedActionWalletName}
            onChanged={refreshAll}
            walletStatuses={walletStatuses}
            solBalances={solBalances}
          />
        </main>
      )}

      {showAddPool && <AddPoolModal onClose={() => setShowAddPool(false)} onAdded={refreshAll} />}
    </div>
  );
}
