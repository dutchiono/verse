import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  POOL_TYPES,
  POOL_TYPE_LABELS,
  type PoolType,
  type TokenInfo,
  type PoolDetectionResult,
} from "../types";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}

type DetectState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "result"; result: PoolDetectionResult }
  | { state: "error"; msg: string };

export function AddPoolModal({ onClose, onAdded }: Props) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<PoolType | null>(null); // null until user picks or auto-detected
  const [typeOverridden, setTypeOverridden] = useState(false); // true if user picked manually
  const [poolAddress, setPoolAddress] = useState("");
  const [tokenMint, setTokenMint] = useState("");
  const [useDefaults, setUseDefaults] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState<{ state: "idle" | "loading" | "ok" | "error"; info?: TokenInfo; msg?: string }>({ state: "idle" });
  const [detect, setDetect] = useState<DetectState>({ state: "idle" });
  const tokenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Pool address auto-detect (debounced) ---
  useEffect(() => {
    const addr = poolAddress.trim();
    if (detectDebounceRef.current) clearTimeout(detectDebounceRef.current);
    if (!addr || addr.length < 32) { setDetect({ state: "idle" }); return; }
    setDetect({ state: "loading" });
    detectDebounceRef.current = setTimeout(async () => {
      try {
        const result = await api.detectPool(addr);
        setDetect({ state: "result", result });
        // Auto-fill type only if user hasn't already manually picked.
        if (result.status === "ok" && !typeOverridden) {
          setType(result.type);
        }
      } catch (e) {
        setDetect({ state: "error", msg: (e as Error).message });
      }
    }, 400);
    return () => { if (detectDebounceRef.current) clearTimeout(detectDebounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolAddress]);

  // --- Token mint resolution (debounced) ---
  useEffect(() => {
    const mint = tokenMint.trim();
    if (tokenDebounceRef.current) clearTimeout(tokenDebounceRef.current);
    if (!mint || mint.length < 32) { setToken({ state: "idle" }); return; }
    setToken({ state: "loading" });
    tokenDebounceRef.current = setTimeout(async () => {
      try {
        const info = await api.tokenInfo(mint);
        setToken({ state: "ok", info });
      } catch (e) {
        setToken({ state: "error", msg: (e as Error).message });
      }
    }, 300);
    return () => { if (tokenDebounceRef.current) clearTimeout(tokenDebounceRef.current); };
  }, [tokenMint]);

  function handleTypeChange(t: PoolType) {
    setType(t);
    setTypeOverridden(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!type) {
      setErr("Pick a pool type (auto-detect failed — choose from the dropdown).");
      return;
    }
    setBusy(true);
    try {
      await api.addPool({
        id: id.trim(),
        name: name.trim() || undefined,
        type,
        pool_address: poolAddress.trim(),
        token_mint: tokenMint.trim(),
        use_default_strategy: useDefaults,
      });
      await onAdded();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Render the auto-detect status chip.
  function DetectChip() {
    if (detect.state === "idle") return null;
    if (detect.state === "loading") {
      return <div className="detect-chip loading">detecting pool type…</div>;
    }
    if (detect.state === "error") {
      return <div className="detect-chip err">detect failed: {detect.msg}</div>;
    }
    const r = detect.result;
    if (r.status === "ok") {
      return (
        <div className={`detect-chip ${r.pricingSupported ? "ok" : "warn"}`}>
          <strong>✓ {r.programName}</strong> → <code>{r.type}</code>
          {!r.pricingSupported && <div className="small" style={{ marginTop: 4 }}>
            ⚠ no native price feed yet — pool is tradable via Jupiter, but mcap/price column will be blank.
          </div>}
        </div>
      );
    }
    if (r.status === "unsupported") {
      return (
        <div className="detect-chip err">
          <strong>✗ unrecognised program</strong>
          <div className="small" style={{ marginTop: 4 }}>
            Owner: <code>{r.programId}</code>
          </div>
          <div className="small" style={{ marginTop: 4 }}>{r.reason}</div>
          <div className="small" style={{ marginTop: 4 }}>You can still add it manually below.</div>
        </div>
      );
    }
    if (r.status === "not-found") {
      return (
        <div className="detect-chip err">
          <strong>✗ account not found on chain</strong>
          <div className="small" style={{ marginTop: 4 }}>{r.reason}</div>
        </div>
      );
    }
    return <div className="detect-chip err"><strong>✗ {r.reason}</strong></div>;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Add pool</h3>
          <button className="ghost small" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          {/* Pool address first — type derives from it */}
          <label>
            <span>Pool address</span>
            <input
              value={poolAddress}
              onChange={(e) => setPoolAddress(e.target.value)}
              placeholder="pubkey of the on-chain pool account"
              autoFocus
            />
          </label>
          <DetectChip />

          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>
              <span>
                Type
                {detect.state === "result" && detect.result.status === "ok" && !typeOverridden && (
                  <span className="small muted" style={{ marginLeft: 6 }}>(auto)</span>
                )}
                {typeOverridden && (
                  <span className="small muted" style={{ marginLeft: 6 }}>(manual)</span>
                )}
              </span>
              <select
                value={type ?? ""}
                onChange={(e) => handleTypeChange(e.target.value as PoolType)}
              >
                <option value="" disabled>— select —</option>
                {POOL_TYPES.map((t) => (
                  <option key={t} value={t}>{POOL_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={useDefaults} onChange={(e) => setUseDefaults(e.target.checked)} />
              <span>pre-fill default strategy</span>
            </label>
          </div>

          <div className="form-grid" style={{ marginTop: 12 }}>
            <label>
              <span>ID (short slug)</span>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. brrr" />
            </label>
            <label>
              <span>Display name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" />
            </label>
          </div>

          <label>
            <span>Token mint</span>
            <input value={tokenMint} onChange={(e) => setTokenMint(e.target.value)} placeholder="pubkey" />
          </label>

          {token.state === "loading" && <div className="token-preview muted small">resolving token…</div>}
          {token.state === "ok" && token.info && (
            <div className="token-preview">
              {token.info.image && <img src={token.info.image} alt="" />}
              <div className="token-meta">
                <div className="token-name">
                  {token.info.name ?? <span className="muted">(no metadata name)</span>}
                  {token.info.symbol && <span className="small muted"> · {token.info.symbol}</span>}
                </div>
                <div className="small muted">
                  supply: {token.info.supply !== null ? fmtNum(token.info.supply) : "—"}
                  {token.info.decimals !== null && <> · {token.info.decimals} dec</>}
                </div>
              </div>
            </div>
          )}
          {token.state === "error" && <div className="token-preview err">token lookup failed: {token.msg}</div>}

          {err && <div className="err">{err}</div>}
          <div className="form-actions">
            <button type="submit" disabled={busy || !type}>{busy ? "adding…" : "Add pool"}</button>
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
