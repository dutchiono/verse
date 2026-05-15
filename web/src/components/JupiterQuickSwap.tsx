import { useState } from "react";
import { api } from "../api";
import { fmtTokenUi } from "../fmtToken";
import type { PoolView, WalletInfo } from "../types";

interface Props {
  pool: PoolView;
  wallets: WalletInfo[];
  selectedWalletName: string | null;
  tokenBalances: Record<string, number | null>;
  onLog?: (text: string, level?: "info" | "warn" | "ok") => void;
  onSwapComplete?: () => void;
}

type Direction = "buy" | "sell";

export function JupiterQuickSwap({ pool, wallets, selectedWalletName, tokenBalances, onLog, onSwapComplete }: Props) {
  const [dir, setDir] = useState<Direction>("buy");
  const [solAmount, setSolAmount] = useState(0.001);
  const [tokenAmount, setTokenAmount] = useState(0);
  const [slippageBps, setSlippageBps] = useState(150);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const walletName = selectedWalletName ?? wallets[0]?.name ?? "";
  const selectedWallet = wallets.find((w) => w.name === walletName) ?? null;

  const tokenBal = tokenBalances[walletName] ?? 0;

  function setMaxTokens() {
    if (tokenBal > 0) setTokenAmount(tokenBal);
  }

  function setPct(pct: number) {
    if (tokenBal > 0) setTokenAmount(parseFloat((tokenBal * pct / 100).toFixed(6)));
  }

  async function run() {
    if (!walletName) { setErr("pick a wallet"); return; }
    setBusy(true);
    setErr(null);
    setLastSig(null);
    try {
      let signature: string;
      if (dir === "buy") {
        ({ signature } = await api.jupiterSwapSolToToken({ walletName, poolId: pool.id, solAmount, slippageBps }));
      } else {
        if (!(tokenAmount > 0)) throw new Error("enter a token amount to sell");
        ({ signature } = await api.jupiterSwapTokenToSol({ walletName, poolId: pool.id, tokenAmount, slippageBps }));
      }
      setLastSig(signature);
      const label = dir === "buy" ? `buy ${solAmount} SOL` : `sell ${tokenAmount} tokens`;
      onLog?.(`Jupiter ${label} → ${signature.slice(0, 8)}…`, "ok");
      onSwapComplete?.();
      await navigator.clipboard.writeText(signature).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      onLog?.(`Jupiter swap failed: ${msg}`, "warn");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jupiter-swap">
      <div className="jupiter-swap-title">Quick swap (Jupiter)</div>
      <div className="jupiter-swap-row small muted">
        Mainnet · real funds · signs server-side with your roster key.
      </div>

      {/* Direction toggle */}
      <div className="jupiter-dir-toggle">
        <button
          className={dir === "buy" ? "active" : ""}
          onClick={() => setDir("buy")}
          type="button"
        >
          Buy (SOL → token)
        </button>
        <button
          className={dir === "sell" ? "active danger" : ""}
          onClick={() => setDir("sell")}
          type="button"
        >
          Sell (token → SOL)
        </button>
      </div>

      <div className="jupiter-swap-controls">
        <div className="field inline">
          <span>Wallet</span>
          <span className="jupiter-selected-wallet mono">
            {selectedWallet ? selectedWallet.name : "select wallet in roster"}
          </span>
        </div>

        {dir === "buy" ? (
          <label className="field inline">
            <span>SOL</span>
            <input
              type="number"
              step="0.001"
              min={0.00001}
              max={15}
              value={solAmount}
              onChange={(e) => setSolAmount(parseFloat(e.target.value) || 0)}
            />
          </label>
        ) : (
          <div className="field inline">
            <span>Tokens</span>
            <input
              type="number"
              step="0.000001"
              min={0}
              value={tokenAmount}
              onChange={(e) => setTokenAmount(parseFloat(e.target.value) || 0)}
            />
            <div className="sell-pct-btns">
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="ghost small"
                  onClick={() => setPct(p)}
                  disabled={!tokenBal}
                >
                  {p}%
                </button>
              ))}
              <button type="button" className="ghost small" onClick={setMaxTokens} disabled={!tokenBal}>max</button>
            </div>
          </div>
        )}

        <label className="field inline">
          <span>Slip bps</span>
          <input
            type="number"
            step={10}
            min={1}
            max={2500}
            value={slippageBps}
            onChange={(e) => setSlippageBps(parseInt(e.target.value, 10) || 150)}
          />
        </label>

        <button
          disabled={busy || !walletName}
          className={dir === "sell" ? "danger" : ""}
          onClick={() => void run()}
        >
          {busy ? "swapping…" : dir === "buy" ? "Buy" : "Sell"}
        </button>
      </div>

      {walletName && (
        <div className="jupiter-bal small muted">
          Pool token balance (this wallet):{" "}
          <span className="mono">{fmtTokenUi(tokenBalances[walletName])}</span>
          {dir === "sell" && tokenBal > 0 && tokenAmount > 0 && (
            <span className="muted">
              {" "}· selling{" "}
              <span className="mono">{((tokenAmount / tokenBal) * 100).toFixed(1)}%</span>
              {" "}of balance
            </span>
          )}
        </div>
      )}

      {err && <div className="err small">{err}</div>}
      {lastSig && (
        <div className="small ok mono">
          sig{" "}
          <a href={`https://solscan.io/tx/${lastSig}`} target="_blank" rel="noreferrer">
            {lastSig.slice(0, 12)}…
          </a>
        </div>
      )}
    </div>
  );
}
