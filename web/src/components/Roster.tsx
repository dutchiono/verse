import { useEffect, useState } from "react";
import { api } from "../api";
import { type AffixKind, type PoolView, type WalletInfo, type WalletStatus, type BulkImportResult } from "../types";
import { WordPairGrid } from "./WordPairGrid";

interface Props {
  wallets: WalletInfo[];
  pools: PoolView[];
  selectedPoolId: string | null;
  selectedWalletName?: string | null;
  onSelectWallet?: (name: string) => void;
  onChanged: () => Promise<void> | void;
  walletStatuses: Record<string, WalletStatus>;
  solBalances?: Record<string, number | null>;
  isAdmin?: boolean;
}

type AddMode = "single" | "bulk";

export function Roster({ wallets, pools, selectedPoolId, selectedWalletName, onSelectWallet, onChanged, walletStatuses, solBalances = {}, isAdmin = false }: Props) {
  const [localWallets, setLocalWallets] = useState(wallets);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("single");
  const [err, setErr] = useState<string | null>(null);
  const selectedPool = pools.find((p) => p.id === selectedPoolId) ?? null;

  useEffect(() => {
    setLocalWallets(wallets);
  }, [wallets]);

  async function patchWallets(names: string[], patch: { enabled: boolean }) {
    const before = localWallets;
    setLocalWallets((prev) => prev.map((w) => names.includes(w.name) ? { ...w, ...patch } : w));
    try {
      await api.updateWallets(names, patch);
      await onChanged();
    } catch (e) {
      setLocalWallets(before);
      setErr((e as Error).message);
    }
  }

  async function removeWallets(names: string[]) {
    const before = localWallets;
    setLocalWallets((prev) => prev.filter((w) => !names.includes(w.name)));
    try {
      await Promise.all(names.map((name) => api.deleteWallet(name)));
      await onChanged();
    } catch (e) {
      setLocalWallets(before);
      setErr((e as Error).message);
    }
  }

  const rosterWallets = localWallets.filter((w) => w.role === "sequence");
  const activeCount = rosterWallets.filter((w) => w.enabled).length;

  return (
    <div className="roster">
      <div className="roster-head">
        <div>
          <h2>Roster</h2>
          <div className="roster-meta-line small mono">
            <span><span className="muted">wallets</span> {activeCount}/{rosterWallets.length}</span>
            <span><span className="muted">pool</span> {selectedPool?.name ?? "—"}</span>
          </div>
        </div>
        {isAdmin && (
          <>
            <button className="ghost small" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "cancel" : "+ import"}
            </button>
            <button
              type="button"
              className="ghost small"
              disabled={rosterWallets.length === 0 || activeCount === rosterWallets.length}
              onClick={() => void patchWallets(rosterWallets.map((w) => w.name), { enabled: true })}
            >
              reset all on
            </button>
          </>
        )}
      </div>

      {showAdd && (
        <div className="roster-add-form add-form">
          <div className="roster-add-tabs">
            <button
              className={addMode === "single" ? "active" : ""}
              onClick={() => setAddMode("single")}
              type="button"
            >Single</button>
            <button
              className={addMode === "bulk" ? "active" : ""}
              onClick={() => setAddMode("bulk")}
              type="button"
            >Paste CSV</button>
          </div>
          {addMode === "single"
            ? <AddWalletForm onDone={async () => { setShowAdd(false); await onChanged(); }} />
            : <BulkImportForm onDone={async () => { await onChanged(); }} />}
        </div>
      )}

      {err && <div className="err">{err}</div>}

      {rosterWallets.length === 0 ? (
        <div className="roster-empty muted small">No wallets. Import one above.</div>
      ) : (
        <WordPairGrid
          wallets={rosterWallets}
          statuses={walletStatuses}
          solBalances={solBalances}
          tokenBalances={{}}
          hasPool={false}
          selectedWalletName={selectedWalletName}
          onSelectWallet={onSelectWallet}
          onTogglePair={isAdmin ? (names, enabled) => void patchWallets(names, { enabled }) : undefined}
          onDeletePair={isAdmin ? (names) => void removeWallets(names) : undefined}
        />
      )}
    </div>
  );
}

// ── Single import ───────────────────────────────────────────────────────────

function AddWalletForm({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [affix, setAffix] = useState<AffixKind>("prefix");
  const [secret, setSecret] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("name required");
    if (!secret.trim()) return setErr("private key required");
    setBusy(true);
    try {
      await api.addWallet({
        name: name.trim(),
        label: label.trim(),
        affix,
        secret: secret.trim(),
        notes: notes.trim() || undefined,
      });
      setName(""); setLabel(""); setAffix("prefix"); setSecret(""); setNotes("");
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="brrr-1" />
        </label>
        <label>
          <span>Label (word in address)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. BRRR" />
        </label>
        <label>
          <span>Affix</span>
          <select value={affix} onChange={(e) => setAffix(e.target.value as AffixKind)}>
            {(["prefix", "suffix", "none"] as AffixKind[]).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
      </div>
      <label>
        <span>Private key</span>
        <textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="base58 string or JSON byte array [12,34,...]"
          rows={3}
        />
      </label>
      {err && <div className="err">{err}</div>}
      <div className="form-actions">
        <button type="submit" disabled={busy}>{busy ? "saving…" : "Encrypt & import"}</button>
        <span className="small muted">Encrypted with session password. Plaintext key never written to disk.</span>
      </div>
    </form>
  );
}

// ── Bulk import ─────────────────────────────────────────────────────────────

interface ParsedRow {
  name: string;
  label: string;
  affix: AffixKind;
  secret: string;
}

function BulkImportForm({ onDone }: { onDone: () => Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);

  let preview: ParsedRow[] = [];
  let parseError: string | null = null;
  if (csv.trim()) {
    try { preview = parseCsv(csv); } catch (e) { parseError = (e as Error).message; }
  }

  async function submit() {
    setErr(null); setResult(null);
    if (preview.length === 0) { setErr("no rows to import"); return; }
    setBusy(true);
    try {
      const r = await api.bulkAddWallets(preview);
      setResult(r);
      if (r.added.length > 0) await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Paste CSV with columns:&nbsp;
        <code>Word, Type, Short Wallet, Wallet Address, Private Key, Source File</code>.
        Header row optional. Existing wallets (matched by name or pubkey) are skipped.
      </p>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder="Word,Type,Short Wallet,Wallet Address,Private Key,Source File&#10;ARE,Prefix,ARE53s...1UbjYo,ARE53sTRd41EGAry...,435qN15U..."
        rows={6}
        style={{ width: "100%", fontFamily: "inherit", fontSize: 11 }}
      />
      {parseError && <div className="err">{parseError}</div>}
      {!parseError && preview.length > 0 && (
        <div className="small muted" style={{ marginTop: 6 }}>
          {preview.length} row{preview.length === 1 ? "" : "s"} ready —
          {" "}{preview.filter((r) => r.affix === "prefix").length} prefix,
          {" "}{preview.filter((r) => r.affix === "suffix").length} suffix
          {preview.filter((r) => r.affix === "none").length > 0 && (
            <>, {preview.filter((r) => r.affix === "none").length} other</>
          )}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {result && (
        <div className="bulk-result">
          <div><span className="ok">added</span> {result.added.length}</div>
          {result.skipped.length > 0 && (
            <div><span className="muted">skipped (existing)</span> {result.skipped.length}</div>
          )}
          {result.errors.length > 0 && (
            <div className="bulk-errors">
              <span className="bad">errors</span> {result.errors.length}
              <ul>
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={i}><code>{e.name}</code>: {e.error}</li>
                ))}
                {result.errors.length > 10 && <li className="muted">…and {result.errors.length - 10} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="form-actions">
        <button type="button" disabled={busy || preview.length === 0} onClick={() => void submit()}>
          {busy ? "importing…" : `Import ${preview.length} wallet${preview.length === 1 ? "" : "s"}`}
        </button>
        <span className="small muted">Encrypted with session password.</span>
      </div>
    </div>
  );
}

/**
 * Parse the user's CSV format.
 * Generates wallet names like `word-prefix-Abc123` (label-affix-pubkeyPrefix6)
 * to ensure uniqueness when a label has multiple wallets of the same affix.
 */
function parseCsv(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  const out: ParsedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(",").map((c) => c.trim());
    // Skip the header row if present
    if (i === 0 && /^word$/i.test(cols[0] ?? "")) continue;
    if (cols.length < 5) throw new Error(`row ${i + 1}: expected ≥5 columns, got ${cols.length}`);
    const [word, type, , pubkey, secret] = cols;
    if (!word) throw new Error(`row ${i + 1}: missing Word`);
    if (!type) throw new Error(`row ${i + 1}: missing Type`);
    if (!pubkey) throw new Error(`row ${i + 1}: missing Wallet Address`);
    if (!secret) throw new Error(`row ${i + 1}: missing Private Key`);
    const affix = normalizeAffix(type);
    const name = `${word.toLowerCase()}-${affix}-${pubkey.slice(0, 6)}`;
    out.push({ name, label: word, affix, secret });
  }
  return out;
}

function normalizeAffix(raw: string): AffixKind {
  const t = raw.trim().toLowerCase();
  if (t === "prefix" || t === "p") return "prefix";
  if (t === "suffix" || t === "s") return "suffix";
  return "none";
}
