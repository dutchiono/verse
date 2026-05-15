import { useEffect, useState } from "react";
import { api } from "../api";
import type { PoolView, SavedSequence, TokenInfo, WalletInfo, WalletStatus } from "../types";
import { SequencerPanel } from "./SequencerPanel";
import { JupiterQuickSwap } from "./JupiterQuickSwap";
import { WordPairGrid } from "./WordPairGrid";
import { ControlWalletPanel } from "./ControlWalletPanel";

interface Props {
  pool?: PoolView | null;
  wallets: WalletInfo[];
  selectedWalletName: string | null;
  onSelectWallet?: (name: string) => void;
  selectedSequence: SavedSequence | null;
  onChanged: () => Promise<void> | void;
  onLog?: (text: string, level?: "info" | "warn" | "ok") => void;
  onWalletStatus?: (name: string, status: WalletStatus) => void;
  walletStatuses?: Record<string, WalletStatus>;
  solBalances?: Record<string, number | null>;
  onSolBalances?: (balances: Record<string, number | null>) => void;
  isVisitor?: boolean;
}

export function PoolDetail({
  pool,
  wallets,
  selectedWalletName,
  onSelectWallet,
  selectedSequence,
  onChanged,
  onLog,
  onWalletStatus,
  walletStatuses = {},
  solBalances = {},
  onSolBalances,
  isVisitor = false,
}: Props) {
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  const controlWalletName = pool?.control_wallet_name ?? null;
  const actionWallets = controlWalletName ? wallets.filter((w) => w.name !== controlWalletName) : wallets;

  useEffect(() => {
    if (!pool) { setToken(null); setTokenErr(null); return; }
    setToken(null);
    setTokenErr(null);
    let cancelled = false;
    void api.tokenInfo(pool.token_mint)
      .then((t) => { if (!cancelled) setToken(t); })
      .catch((e) => { if (!cancelled) setTokenErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [pool?.token_mint]);

  const displayName = token?.name || pool?.name;

  return (
    <div className="pool-detail">
      {pool && (
        <>
          <div className="pd-header">
            <div className="pd-token">
              {token?.image && <img className="pd-token-img" src={token.image} alt="" />}
              <div>
                <h1 className="pd-title">
                  {displayName}
                  {token?.symbol && <span className="muted small"> · {token.symbol}</span>}
                </h1>
                <div className="pd-sub small muted mono">
                  {pool.type === "meteora-dbc" ? "Meteora DBC" : "Meteora DAMM"} ·
                  pool {short(pool.pool_address)} · mint {short(pool.token_mint)}
                </div>
                {tokenErr && (
                  <div className="small warn mono">metadata unavailable: {tokenErr}</div>
                )}
              </div>
            </div>
          </div>

          <JupiterQuickSwap
            pool={pool}
            wallets={actionWallets}
            selectedWalletName={selectedWalletName}
            tokenBalances={{}}
            onLog={onLog}
            onSwapComplete={() => {}}
          />
        </>
      )}

      {!pool && (
        <div className="pd-no-pool muted small">No pool selected — add one from the left rail.</div>
      )}

      {pool && (
        <ControlWalletPanel
          pool={pool}
          wallets={wallets}
          solBalance={controlWalletName ? solBalances[controlWalletName] : null}
          onChanged={onChanged}
          onLog={onLog}
          isVisitor={isVisitor}
        />
      )}

      <div className="pd-section">
        {pool ? (
          <SequencerPanel
            pool={pool}
            wallets={wallets}
            selectedSequence={selectedSequence}
            onChanged={onChanged}
            onLog={onLog}
            onWalletStatus={onWalletStatus}
            walletStatuses={walletStatuses}
            solBalances={solBalances}
            onSolBalances={onSolBalances}
            balanceCheckWallets={wallets}
            isVisitor={isVisitor}
          />
        ) : (
          <div className="muted small" style={{ padding: "1rem" }}>Select a pool to use the sequencer.</div>
        )}
      </div>

      <div className="pd-roster-balances">
        <div className="pd-roster-balances-head">
          <span className="pd-roster-title">Roster</span>
          {pool && <span className="small muted mono">{short(pool.token_mint)}</span>}
        </div>
        {actionWallets.length === 0 ? (
          <div className="muted small">no wallets on roster</div>
        ) : (
          <WordPairGrid
            wallets={actionWallets}
            statuses={walletStatuses}
            solBalances={solBalances}
            tokenBalances={{}}
            hasPool={false}
            controlWalletName={pool?.control_wallet_name ?? null}
            selectedWalletName={selectedWalletName}
            onSelectWallet={onSelectWallet}
          />
        )}
      </div>
    </div>
  );
}

function short(addr: string): string {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}
