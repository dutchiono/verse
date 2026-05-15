import { useState } from "react";
import { api } from "../api";
import type { PoolView, WalletInfo } from "../types";

interface Props {
  pool: PoolView;
  wallets: WalletInfo[];
  solBalance: number | null | undefined;
  onChanged: () => Promise<void> | void;
  onLog?: (text: string, level?: "info" | "warn" | "ok") => void;
  onSolBalances?: (balances: Record<string, number | null>) => void;
}

/**
 * Compact control-wallet utility panel: pubkey + click-to-copy, live balance,
 * and a withdraw form (exact amount or sweep). Visible only when the pool has
 * a control wallet set.
 */
export function ControlWalletPanel({ pool, wallets, solBalance, onChanged, onLog, onSolBalances }: Props) {
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [sweep, setSweep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ctrlName = pool.control_wallet_name;
  const ctrl = ctrlName ? wallets.find((w) => w.name === ctrlName) : undefined;

  if (!ctrlName) return null;
  if (!ctrl) {
    return (
      <div className="ctrl-panel">
        <div className="ctrl-panel-head">
          <span className="ctrl-panel-title">Control wallet</span>
          <span className="small muted">{ctrlName} — not loaded (enable it on the Roster)</span>
        </div>
      </div>
    );
  }

  const balSol = solBalance != null ? solBalance / 1e9 : null;

  async function copyPubkey() {
    try {
      await navigator.clipboard.writeText(ctrl!.pubkey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setErr("clipboard copy failed");
    }
  }

  async function submit() {
    setErr(null); setLastSig(null);
    const dest = destination.trim();
    if (!dest) { setErr("destination required"); return; }
    let lamports: number | undefined;
    if (!sweep) {
      const sol = parseFloat(amount);
      if (!Number.isFinite(sol) || sol <= 0) { setErr("enter a positive SOL amount, or check sweep"); return; }
      lamports = Math.floor(sol * 1e9);
      if (balSol != null && sol > balSol) { setErr("amount exceeds balance"); return; }
    }
    setBusy(true);
    try {
      const r = await api.withdrawControlWallet(pool.id, {
        destination: dest,
        ...(sweep ? { sweep: true } : { lamports }),
      });
      setLastSig(r.signature);
      onLog?.(`withdraw ✓ ${(r.lamports / 1e9).toFixed(4)} SOL → ${dest.slice(0, 8)}…`, "ok");
      setAmount("");
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function checkBalance() {
    setChecking(true);
    setErr(null);
    try {
      const r = await api.checkWalletBalances([ctrl!.name]);
      onSolBalances?.(r.balances);
      const next = r.balances[ctrl!.name];
      onLog?.(`control balance ${next != null ? (next / 1e9).toFixed(4) : "unknown"} SOL`, next != null ? "ok" : "warn");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="ctrl-panel">
      <div className="ctrl-panel-head">
        <span className="ctrl-panel-title">Control wallet</span>
        <span className="small muted">{ctrl.label || ctrl.name}</span>
      </div>

      <div className="ctrl-panel-row">
        <button
          className="ctrl-pubkey-btn mono"
          onClick={() => void copyPubkey()}
          title="click to copy full pubkey"
        >
          {ctrl.pubkey}
          <span className={`ctrl-copy-state small ${copied ? "ok" : "muted"}`}>
            {copied ? "✓ copied" : "📋"}
          </span>
        </button>
        <span className="ctrl-balance mono">
          {balSol != null ? `${balSol.toFixed(4)} SOL` : "— SOL"}
        </span>
        <button
          type="button"
          className="ghost small"
          disabled={checking}
          onClick={() => void checkBalance()}
          title="explicit one-wallet SOL balance check for LARP"
        >
          {checking ? "checking…" : "check SOL"}
        </button>
      </div>

      <div className="ctrl-withdraw-row">
        <input
          className="ctrl-dest-input mono"
          placeholder="receiver pubkey…"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          disabled={busy}
        />
        <input
          className="ctrl-amt-input"
          type="number"
          step={0.001}
          min={0}
          placeholder="SOL"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy || sweep}
        />
        <label
          className="ctrl-sweep-lbl small"
          title="Sweep sends nearly all SOL from LARP to this receiver. Cleanup is different: it drains sequence wallets back into LARP."
        >
          <input
            type="checkbox"
            checked={sweep}
            onChange={(e) => setSweep(e.target.checked)}
            disabled={busy}
          />
          sweep LARP
        </label>
        <button
          className="ctrl-send-btn"
          disabled={busy || !destination.trim() || (!sweep && !amount)}
          onClick={() => void submit()}
        >
          {busy ? "sending…" : "Withdraw"}
        </button>
      </div>

      {err && <div className="err small">{err}</div>}
      {lastSig && (
        <div className="small mono ctrl-sig">
          ✓ <a href={`https://solscan.io/tx/${lastSig}`} target="_blank" rel="noreferrer">{lastSig.slice(0, 14)}…</a>
        </div>
      )}
    </div>
  );
}
