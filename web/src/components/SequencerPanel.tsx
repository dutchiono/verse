import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  type PoolView, type SequencerConfig, type SequencerAction,
  type SavedSequence, type WalletInfo, type WalletStatus,
} from "../types";

interface Props {
  pool: PoolView;
  wallets: WalletInfo[];
  selectedSequence: SavedSequence | null;
  onChanged: () => Promise<void> | void;
  onLog?: (text: string, level?: "info" | "warn" | "ok") => void;
  onWalletStatus?: (name: string, status: WalletStatus) => void;
  walletStatuses?: Record<string, WalletStatus>;
  solBalances?: Record<string, number | null>;
  onSolBalances?: (balances: Record<string, number | null>) => void;
  balanceCheckWallets?: WalletInfo[];
  effectiveControlWallet?: string | null;
  isVisitor?: boolean;
}

/** A single entry in the UI queue — one "word" = 1 or 2 wallet fires (prefix, then suffix). */
interface WordStep {
  uid: string;
  label: string;
  walletNames: string[]; // firing order: prefix first, then suffix
}


const AFFIX_ORDER: Record<string, number> = { prefix: 0, suffix: 1, none: 2 };

function affixOrder(affix: string) { return AFFIX_ORDER[affix] ?? 2; }

/** Group wallets by label, sorted prefix-first within each group. */
function buildWordMap(wallets: WalletInfo[]): Map<string, WalletInfo[]> {
  const m = new Map<string, WalletInfo[]>();
  for (const w of wallets) {
    const key = w.label || w.name;
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(w);
  }
  for (const [, group] of m) {
    group.sort((a, b) => affixOrder(a.affix) - affixOrder(b.affix));
  }
  return m;
}

/** Reconstruct WordSteps from a flat backend queue. */
function flatToWordQueue(queue: { walletName: string }[], wallets: WalletInfo[]): WordStep[] {
  const result: WordStep[] = [];
  const pendingByLabel = new Map<string, WordStep[]>();

  for (const step of queue) {
    const name = step.walletName;
    const w = wallets.find((x) => x.name === name);
    const label = w?.label || name;

    if (w?.affix === "suffix") {
      const pending = pendingByLabel.get(label)?.find((x) => x.walletNames.length === 1);
      if (pending) {
        pending.walletNames.push(name);
        continue;
      }
    }

    const wordStep = { uid: uid(), label, walletNames: [name] };
    result.push(wordStep);
    if (w?.affix === "prefix") {
      const pending = pendingByLabel.get(label) ?? [];
      pending.push(wordStep);
      pendingByLabel.set(label, pending);
    }
  }

  for (const step of result) {
    step.walletNames.sort((a, b) => {
      const aw = wallets.find((x) => x.name === a);
      const bw = wallets.find((x) => x.name === b);
      return affixOrder(aw?.affix ?? "none") - affixOrder(bw?.affix ?? "none");
    });
  }
  return result;
}

function wordQueueToFiringFlat(wq: WordStep[]): { walletName: string }[] {
  const laneCount = Math.max(0, ...wq.map((w) => w.walletNames.length));
  const queue: { walletName: string }[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    for (const word of wq) {
      const walletName = word.walletNames[lane];
      if (walletName) queue.push({ walletName });
    }
  }
  return queue;
}

function fireCount(action: SequencerAction, flatSteps: { walletName: string }[]): number {
  return action === "buy-sell" ? flatSteps.length * 2 : flatSteps.length;
}

function plannedStep(action: SequencerAction, flatSteps: { walletName: string }[], i: number): { walletName: string; action: "buy" | "sell" } {
  if (action === "sell") return { walletName: flatSteps[i]?.walletName ?? "", action: "sell" };
  if (action !== "buy-sell") return { walletName: flatSteps[i]?.walletName ?? "", action: "buy" };
  let n = i % (flatSteps.length * 2);
  for (const block of laneBlocks(flatSteps)) {
    const blockLen = block.length;
    const blockCycle = blockLen * 2;
    if (n < blockCycle) {
      return {
        walletName: flatSteps[block[n % blockLen]!]?.walletName ?? "",
        action: n < blockLen ? "buy" : "sell",
      };
    }
    n -= blockCycle;
  }
  return { walletName: "", action: "buy" };
}

function laneBlocks(queue: readonly { walletName: string }[]): number[][] {
  const prefix: number[] = [];
  const suffix: number[] = [];
  for (const [idx, step] of queue.entries()) {
    if (isSuffixWalletName(step.walletName)) suffix.push(idx);
    else prefix.push(idx);
  }
  return [prefix, suffix].filter((block) => block.length > 0);
}

function isSuffixWalletName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("-suffix-") || n.endsWith("-suffix") || /-s\d*$/.test(n);
}

function buildPlannedTimeline(action: SequencerAction, flatSteps: { walletName: string }[]): Array<{ walletName: string; action: "buy" | "sell" }> {
  return Array.from({ length: fireCount(action, flatSteps) }, (_, i) => plannedStep(action, flatSteps, i));
}

function short(addr: string): string {
  if (!addr) return "—";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function fmtSolLamports(lamports: number | null | undefined): string {
  if (lamports == null) return "—";
  return `${(lamports / 1e9).toFixed(4)}`;
}
function fmtSolShort(lamports: number | null | undefined): string {
  if (lamports == null) return "—";
  return (lamports / 1e9).toFixed(3);
}

const BUY_FEE_BUFFER_LAMPORTS = 100_000;

function requiredBuyLamports(
  action: SequencerAction,
  plannedTimeline: Array<{ walletName: string; action: "buy" | "sell" }>,
  solAmount: number,
): Record<string, number> {
  if (action === "sell") return {};
  const lamportsPerBuy = Math.floor(solAmount * 1e9) + BUY_FEE_BUFFER_LAMPORTS;
  const req: Record<string, number> = {};
  for (const step of plannedTimeline) {
    if (step.action !== "buy" || !step.walletName) continue;
    req[step.walletName] = (req[step.walletName] ?? 0) + lamportsPerBuy;
  }
  return req;
}

function balancesCoverRequirements(balances: Record<string, number | null>, requirements: Record<string, number>): boolean {
  return Object.entries(requirements).every(([name, needed]) => (balances[name] ?? -1) >= needed);
}

let _uid = 0;
function uid() { return String(++_uid); }

export function SequencerPanel({
  pool,
  wallets,
  selectedSequence,
  onChanged,
  onLog,
  onWalletStatus,
  walletStatuses = {},
  solBalances = {},
  onSolBalances,
  balanceCheckWallets = [],
  effectiveControlWallet = null,
  isVisitor = false,
}: Props) {
  const [wordQueue, setWordQueue] = useState<WordStep[]>([]);
  const [action, setAction] = useState<SequencerAction>("buy-sell");
  const [solAmount, setSolAmount] = useState(0.001);
  const controlWallet = effectiveControlWallet ?? pool.control_wallet_name ?? "";
  const controlWalletInfo = wallets.find((w) => w.name === controlWallet) ?? null;
  const controlLabel = controlWalletInfo?.label?.trim() || null;
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [armed, setArmed] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [firingAll, setFiringAll] = useState(false);
  const [firingStep, setFiringStep] = useState<number | null>(null);
  const [completedFireCount, setCompletedFireCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [sigs, setSigs] = useState<string[]>([]);
  const [sequenceName, setSequenceName] = useState("");
  const [sequenceBusy, setSequenceBusy] = useState(false);
  const draggingIdx = useRef<number | null>(null);
  const fireInFlightRef = useRef(false);
  const autoBalanceKeyRef = useRef("");

  // Load a saved sequence
  useEffect(() => {
    if (!selectedSequence) return;
    setWordQueue(flatToWordQueue(selectedSequence.queue, wallets));
    setAction(selectedSequence.action);
    setSolAmount(selectedSequence.size.max_sol);
    setSequenceName(selectedSequence.name);
    setDirty(true);
    setErr(null);
  }, [selectedSequence?.id]);

  // Exclude legacy strategy_wallets, the control wallet itself, and anything
  // sharing the control wallet's label group (e.g. LARP-prefix as control hides
  // the LARP-suffix from the picker too).
  const blocked = new Set([
    ...pool.strategy_wallets.map((a) => a.walletName),
    ...(controlWallet ? [controlWallet] : []),
  ]);
  const available = wallets.filter((w) => {
    if (blocked.has(w.name)) return false;
    if (controlLabel && (w.label.trim() || "") === controlLabel) return false;
    return true;
  });
  const wordMap = buildWordMap(available);

  function markDirty() {
    setDirty(true);
    setErr(null);
    setArmed(false);
    setCompletedFireCount(0);
  }
  function resetArm() {
    setArmed(false);
    setSigs([]);
    setCompletedFireCount(0);
  }

  function addWord(label: string) {
    const group = wordMap.get(label);
    if (!group || group.length === 0) return;
    const step: WordStep = { uid: uid(), label, walletNames: group.map((w) => w.name) };
    setWordQueue((prev) => [...prev, step]);
    markDirty();
  }

  function removeStep(idx: number) {
    setWordQueue((prev) => prev.filter((_, i) => i !== idx));
    markDirty();
  }

  function moveStep(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    setWordQueue((prev) => {
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
    markDirty();
  }

  function buildConfig(): SequencerConfig {
    return {
      active: false,
      queue: wordQueueToFiringFlat(wordQueue),
      action,
      schedule: pool.sequencer.schedule,
      size: { min_sol: solAmount, max_sol: solAmount },
      loop_mode: pool.sequencer.loop_mode,
    };
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.saveSequencer(pool.id, buildConfig());
      setDirty(false);
      await onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function checkRosterBalances(namesOverride?: string[], reason: "auto" | "manual" | "post-fire" = "manual") {
    const names = [...new Set((namesOverride ?? balanceCheckWallets.map((w) => w.name)).filter(Boolean))];
    if (names.length === 0) return;
    setChecking(true); setErr(null);
    for (const name of names) onWalletStatus?.(name, "checking");
    try {
      const r = await api.checkWalletBalances(names);
      onSolBalances?.(r.balances);
      const known = Object.values(r.balances).filter((v) => v !== null).length;
      onLog?.(`${reason === "auto" ? "auto-check" : reason === "post-fire" ? "post-fire check" : "check"} ✓ ${known}/${names.length} wallet balance(s) loaded`, "ok");
    } catch (e) {
      setErr((e as Error).message);
      for (const name of names) onWalletStatus?.(name, "error");
    } finally { setChecking(false); }
  }

  async function doArm() {
    if (!controlWallet || wordQueue.length === 0) return;
    // Save first so the queue is committed to the pool
    if (dirty) await save();
    setArming(true); setErr(null); setArmed(false); setSigs([]);
    const allNames = wordQueueToFiringFlat(wordQueue).map((s) => s.walletName);
    for (const name of allNames) onWalletStatus?.(name, "idle");
    try {
      const r = await api.sequencerArm(pool.id, controlWallet);
      setArmed(r.allReady);
      setCompletedFireCount(0);
      for (const res of r.results) onWalletStatus?.(res.walletName, res.ok ? "armed" : "error");
      const balanceUpdates: Record<string, number | null> = Object.fromEntries(
        r.results
          .filter((res) => res.ok && res.balanceLamports !== undefined)
          .map((res) => [res.walletName, res.balanceLamports!]),
      );
      const totalAdded = r.results.reduce((sum, x) => sum + (x.lamports ?? 0), 0);
      if (controlWallet && solBalances[controlWallet] != null) {
        balanceUpdates[controlWallet] = Math.max(0, solBalances[controlWallet]! - totalAdded);
      }
      onSolBalances?.(balanceUpdates);
      if (r.allReady) {
        const ready = r.results.filter((x) => x.ok).length;
        const toppedUp = r.results.filter((x) => (x.lamports ?? 0) > 0).length;
        onLog?.(`ARM ✓ ${ready} wallet(s) ready · topped up ${toppedUp} · added ${(totalAdded / 1e9).toFixed(4)} SOL`, "ok");
      }
      else onLog?.("ARM incomplete — check errors", "warn");
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      onLog?.(`ARM blocked: ${msg}`, "warn");
      for (const name of allNames) onWalletStatus?.(name, "error");
    } finally { setArming(false); }
  }

  async function fireSentence() {
    if (fireInFlightRef.current) return;
    const steps = wordQueueToFiringFlat(wordQueue);
    if (steps.length === 0 || !canFire) return;
    fireInFlightRef.current = true;
    setFiringAll(true); setErr(null); setSigs([]);
    setCompletedFireCount(0);
    try { await api.sequencerReset(pool.id); } catch { /* ignore */ }
    const newSigs: string[] = [];
    const estimatedBalances = { ...solBalances };
    let failed = false;
    const total = fireCount(action, steps);
    for (let i = 0; i < total; i++) {
      setFiringStep(i);
      const planned = plannedStep(action, steps, i);
      const walletName = planned.walletName;
      onWalletStatus?.(walletName, "firing");
      try {
        const result = await api.sequencerFire(pool.id);
        newSigs.push(result.signature);
        setCompletedFireCount(i + 1);
        onWalletStatus?.(walletName, "done");
        if (planned.action === "buy") {
          const spent = Math.floor(solAmount * 1e9) + BUY_FEE_BUFFER_LAMPORTS;
          estimatedBalances[walletName] = Math.max(0, (estimatedBalances[walletName] ?? 0) - spent);
          onSolBalances?.({ [walletName]: estimatedBalances[walletName] });
        }
        onLog?.(`▶ ${planned.action} ${walletName} · ${result.signature.slice(0, 8)}…`, "ok");
      } catch (e) {
        failed = true;
        const msg = (e as Error).message;
        onWalletStatus?.(walletName, "error");
        setErr(`step ${i + 1} failed: ${msg}`);
        onLog?.(`✗ step ${i + 1} (${walletName}): ${msg}`, "warn");
        break;
      }
    }
    setSigs(newSigs);
    setFiringStep(null);
    setFiringAll(false);
    setArmed(!failed && balancesCoverRequirements(estimatedBalances, buyRequirements));
    if (!failed) void checkRosterBalances(neededBalanceNames, "post-fire");
    fireInFlightRef.current = false;
  }

  async function doCleanup() {
    if (!controlWallet) return;
    const allNames = wordQueueToFiringFlat(wordQueue).map((s) => s.walletName);
    for (const name of allNames) onWalletStatus?.(name, "cleaning");
    setCleaning(true); setErr(null);
    try {
      const r = await api.sequencerCleanup(pool.id, controlWallet);
      for (const res of r.results) onWalletStatus?.(res.walletName, res.ok ? "idle" : "error");
      onSolBalances?.(Object.fromEntries(
        r.results
          .filter((res) => res.ok)
          .map((res) => [res.walletName, res.balanceLamports ?? 0]),
      ));
      const total = r.results.reduce((s, x) => s + (x.lamports ?? 0), 0);
      if (controlWallet && solBalances[controlWallet] != null) {
        onSolBalances?.({ [controlWallet]: solBalances[controlWallet]! + total });
      }
      onLog?.(`cleanup ✓ recovered ${(total / 1e9).toFixed(4)} SOL`, "ok");
    } catch (e) {
      setErr((e as Error).message);
      for (const name of allNames) onWalletStatus?.(name, "error");
    } finally { setCleaning(false); }
  }

  async function saveSequence() {
    const name = sequenceName.trim();
    if (!name) { setErr("sequence name required"); return; }
    setSequenceBusy(true); setErr(null);
    const preset = { queue: wordQueueToFiringFlat(wordQueue), action, schedule: pool.sequencer.schedule, size: { min_sol: solAmount, max_sol: solAmount }, loop_mode: pool.sequencer.loop_mode };
    try {
      if (selectedSequence) {
        await api.updateSequence(selectedSequence.id, { name, ...preset });
      } else {
        await api.createSequence({ name, ...preset });
        setSequenceName("");
      }
      await onChanged();
      onLog?.(`${selectedSequence ? "updated" : "saved"} sequence "${name}"`, "ok");
    } catch (e) { setErr((e as Error).message); }
    finally { setSequenceBusy(false); }
  }

  const anyBusy = firingAll || arming || cleaning || checking || busy;
  const flatSteps = wordQueueToFiringFlat(wordQueue);
  const sequenceWalletNames = [...new Set(flatSteps.map((s) => s.walletName).filter(Boolean))];
  const neededBalanceNames = [...new Set([...(controlWallet ? [controlWallet] : []), ...sequenceWalletNames])];
  const plannedTimeline = buildPlannedTimeline(action, flatSteps);
  const buyRequirements = requiredBuyLamports(action, plannedTimeline, solAmount);
  const missingBalanceNames = Object.keys(buyRequirements).filter((name) => solBalances[name] == null);
  const lowBalanceNames = Object.entries(buyRequirements)
    .filter(([name, needed]) => solBalances[name] != null && solBalances[name]! < needed)
    .map(([name]) => name);
  const balancesReady = Object.keys(buyRequirements).length === 0 || balancesCoverRequirements(solBalances, buyRequirements);
  const sentence = wordQueue.map((w) => w.label).join(" ");
  const canArm = !!controlWallet && wordQueue.length > 0 && !anyBusy;
  const canFire = !dirty && (balancesReady || (armed && lowBalanceNames.length === 0)) && wordQueue.length > 0 && !anyBusy;
  const canCleanup = !!controlWallet && !anyBusy;
  const canCheck = neededBalanceNames.length > 0 && !anyBusy;
  const barReady = !dirty && (balancesReady || (armed && lowBalanceNames.length === 0));
  const barLive = firingAll;
  const barCleanup = cleaning;
  const controlBalance = controlWallet ? solBalances[controlWallet] : null;
  const activeCheckingName = neededBalanceNames.find((name) => walletStatuses[name] === "checking");
  const activeArmingName = sequenceWalletNames.find((name) => walletStatuses[name] === "arming");
  const activeCleaningName = sequenceWalletNames.find((name) => walletStatuses[name] === "cleaning");
  const activeCheckIndex = activeCheckingName ? neededBalanceNames.indexOf(activeCheckingName) + 1 : 0;
  const activeArmIndex = activeArmingName ? sequenceWalletNames.indexOf(activeArmingName) + 1 : 0;
  const activeCleanIndex = activeCleaningName ? sequenceWalletNames.indexOf(activeCleaningName) + 1 : 0;
  const currentPlanned = firingStep !== null ? plannedStep(action, flatSteps, firingStep) : null;
  const statusText = firingAll && currentPlanned
    ? `${currentPlanned.action === "buy" ? "buying token with" : "selling token from"} ${currentPlanned.walletName} (${(firingStep ?? 0) + 1}/${fireCount(action, flatSteps)})`
    : checking && activeCheckingName
      ? `checking ${activeCheckingName} (${activeCheckIndex}/${neededBalanceNames.length})`
      : arming && activeArmingName
        ? `arming ${activeArmingName} with SOL (${activeArmIndex}/${sequenceWalletNames.length})`
        : cleaning && activeCleaningName
          ? `cleaning ${activeCleaningName} (${activeCleanIndex}/${sequenceWalletNames.length})`
          : dirty
            ? "sequence changed — arm or save before firing"
            : lowBalanceNames.length > 0
              ? `low SOL: ${lowBalanceNames.slice(0, 2).join(", ")}${lowBalanceNames.length > 2 ? "…" : ""}`
              : missingBalanceNames.length > 0
                ? `waiting on SOL check for ${missingBalanceNames.length} wallet(s)`
                : barReady
                  ? "ready to fire"
                  : "build and arm a sentence";

  useEffect(() => {
    if (isVisitor || neededBalanceNames.length === 0) return;
    const key = `${pool.id}:${controlWallet}:${neededBalanceNames.join("|")}:${solAmount}`;
    if (autoBalanceKeyRef.current === key) return;
    autoBalanceKeyRef.current = key;
    const t = setTimeout(() => void checkRosterBalances(neededBalanceNames, "auto"), 800);
    return () => clearTimeout(t);
  }, [isVisitor, pool.id, controlWallet, neededBalanceNames.join("|"), solAmount]);

  return (
    <div className="sequencer-panel">

      {/* ── Action bar: ARM · FIRE · CLEANUP  ·  Buy/Sell · SOL ── */}
      <div className="seq-arm-bar">
        <button
          className="seq-check-btn"
          disabled={isVisitor || !canCheck}
          title={isVisitor ? "sign in to use" : "slow sequential SOL balance refresh for the controller and current sentence wallets"}
          onClick={() => void checkRosterBalances(neededBalanceNames, "manual")}
        >
          {checking ? "checking…" : "Refresh SOL"}
        </button>

        <button
          className={`seq-arm-btn ${armed ? "armed" : ""}`}
          disabled={isVisitor || !canArm}
          title={isVisitor ? "sign in to use" : !controlWallet ? "LARP control wallet is not loaded" : undefined}
          onClick={() => void doArm()}
        >
          {arming ? "arming…" : armed ? "✓ Armed" : "Arm"}
        </button>

        <button
          className={`seq-fire-btn ${firingAll ? "firing" : ""}`}
          disabled={isVisitor || !canFire}
          title={isVisitor ? "sign in to use" : dirty ? "sequence changed — arm first" : lowBalanceNames.length > 0 ? "low wallet SOL — arm first" : missingBalanceNames.length > 0 ? "waiting for balance check" : undefined}
          onClick={() => void fireSentence()}
        >
          {firingAll ? `${firingStep !== null ? firingStep + 1 : "…"} / ${fireCount(action, flatSteps)}` : "Fire"}
        </button>

        <button
          className="seq-cleanup-btn"
          disabled={isVisitor || !canCleanup}
          title={isVisitor ? "sign in to use" : !controlWallet ? "LARP control wallet is not loaded" : undefined}
          onClick={() => void doCleanup()}
        >
          {cleaning ? "cleaning…" : "Cleanup"}
        </button>

        <div className="seq-arm-spacer" />

        <div className="seq-live-status">
          <span className={`seq-live-dot ${barLive || checking || arming || cleaning ? "live" : barReady ? "ready" : ""}`} />
          <span className="seq-live-text">{statusText}</span>
        </div>

        <div className="seq-bar-lights">
          <BarLight label="ready" state={barReady ? "on" : "off"} />
          <BarLight label="fire" state={barLive ? "live" : "off"} />
          <BarLight label="cleanup" state={barCleanup ? "live" : "off"} />
        </div>

        <span className="seq-target-tag small mono" title={pool.token_mint}>
          <span className="muted">target</span> {pool.name} · {short(pool.token_mint)}
        </span>

        <span className="seq-balance-pill small mono" title={controlWallet ? `controller wallet ${controlWallet}` : "no controller wallet"}>
          <span className="muted">ctrl</span> {controlWallet || "—"} · {fmtSolShort(controlBalance)} SOL
        </span>

        <div className="seq-action-toggle">
          <button className={action === "buy" ? "active" : ""} onClick={() => { setAction("buy"); markDirty(); }}>Buy</button>
          <button className={action === "sell" ? "active" : ""} onClick={() => { setAction("sell"); markDirty(); }}>Sell</button>
          <button className={action === "buy-sell" ? "active" : ""} onClick={() => { setAction("buy-sell"); markDirty(); }}>Buy+Sell</button>
        </div>

        <label className="seq-sol-field">
          <span>SOL / buy</span>
          <input
            className="seq-sol-input"
            type="number"
            step={0.001}
            min={0.001}
            value={solAmount}
            onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) { setSolAmount(n); markDirty(); } }}
            title="SOL per buy transaction"
          />
        </label>
      </div>

      {/* Fired signatures */}
      {sigs.length > 0 && (
        <div className="seq-sigs small mono">
          {sigs.map((s, i) => (
            <span key={s} className="seq-sig-entry ok">
              {i + 1}·<a href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer">{s.slice(0, 10)}…</a>
            </span>
          ))}
        </div>
      )}

      {/* ── Sentence queue ── */}
      <div className="seq-sentence-section">
        <div className="seq-sentence-head">
          <span className="seq-sentence-label small muted">SENTENCE</span>
          <span className="seq-sentence-preview">{sentence || <span className="muted">— add words below</span>}</span>
          {wordQueue.length > 0 && (
            <button className="ghost small danger" onClick={() => { setWordQueue([]); markDirty(); }}>clear</button>
          )}
        </div>

        {wordQueue.length > 0 && (
          <ol className="seq-word-list">
            {wordQueue.map((step, i) => {
              const firingWalletName = firingStep !== null ? plannedStep(action, flatSteps, firingStep).walletName : "";
              const isFiringThisWord = firingAll && firingStep !== null &&
                step.walletNames.includes(firingWalletName);
              const prefixName = step.walletNames[0] ?? "";
              const suffixName = step.walletNames[1] ?? "";
              return (
                <li key={step.uid} className={`seq-word-item ${isFiringThisWord ? "firing" : ""}`}>
                  <span className="seq-word-idx small muted">{i + 1}</span>
                  <span className="seq-word-chip">
                    <span className="seq-word-main">{step.label}</span>
                    <span className="seq-word-sub small muted">
                      {step.walletNames.map((n) => {
                        const w = wallets.find((x) => x.name === n);
                        return w?.affix === "prefix" ? "Pre" : w?.affix === "suffix" ? "Suff" : "?";
                      }).join("→")}
                    </span>
                  </span>
                  <div className="seq-word-lanes">
                    {prefixName && (
                      <WordLane
                        lane="P"
                        walletName={prefixName}
                        plannedTimeline={plannedTimeline}
                        completedFireCount={completedFireCount}
                        firingAll={firingAll}
                        firingStep={firingStep}
                        status={walletStatuses[prefixName] ?? "idle"}
                        solBalance={solBalances[prefixName]}
                      />
                    )}
                    {suffixName && (
                      <WordLane
                        lane="S"
                        walletName={suffixName}
                        plannedTimeline={plannedTimeline}
                        completedFireCount={completedFireCount}
                        firingAll={firingAll}
                        firingStep={firingStep}
                        status={walletStatuses[suffixName] ?? "idle"}
                        solBalance={solBalances[suffixName]}
                      />
                    )}
                  </div>
                  <div className="seq-word-controls">
                    <button className="ghost small" disabled={i === 0 || anyBusy} onClick={() => moveStep(i, -1)}>↑</button>
                    <button className="ghost small" disabled={i === wordQueue.length - 1 || anyBusy} onClick={() => moveStep(i, 1)}>↓</button>
                    <button className="ghost small danger" disabled={anyBusy} onClick={() => removeStep(i)}>×</button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* ── Word picker ── */}
      <div className="seq-word-picker-section">
        <span className="small muted seq-picker-label">WORDS — click to add to sentence</span>
        <div className="seq-word-picker">
          {[...wordMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, group]) => {
            const affixes = group.map((w) => w.affix);
            const hasPrefix = affixes.includes("prefix");
            const hasSuffix = affixes.includes("suffix");
            return (
              <button
                key={label}
                className="seq-word-btn"
                disabled={anyBusy}
                onClick={() => addWord(label)}
                title={group.map((w) => w.name).join(" + ")}
              >
                <span className="seq-word-btn-label">{label}</span>
                <span className="seq-word-btn-badge small muted">
                  {hasPrefix && hasSuffix ? "P→S" : hasPrefix ? "P" : hasSuffix ? "S" : "—"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Save as named sequence ── */}
      <div className="seq-save-row">
        <input
          className="input"
          placeholder="save as sequence name…"
          value={sequenceName}
          onChange={(e) => setSequenceName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void saveSequence()}
          disabled={sequenceBusy}
        />
        <button type="button" disabled={isVisitor || sequenceBusy || wordQueue.length === 0} title={isVisitor ? "sign in to save sequences" : undefined} onClick={() => void saveSequence()}>
          {sequenceBusy ? "saving…" : selectedSequence ? "Update" : "Save sequence"}
        </button>
      </div>

      {err && <div className="err">{err}</div>}
    </div>
  );
}

interface WordLaneProps {
  lane: "P" | "S";
  walletName: string;
  plannedTimeline: Array<{ walletName: string; action: "buy" | "sell" }>;
  completedFireCount: number;
  firingAll: boolean;
  firingStep: number | null;
  status: WalletStatus;
  solBalance: number | null | undefined;
}

function WordLane({
  lane,
  walletName,
  plannedTimeline,
  completedFireCount,
  firingAll,
  firingStep,
  status,
  solBalance,
}: WordLaneProps) {
  const buyIndices = plannedTimeline.flatMap((step, i) => step.walletName === walletName && step.action === "buy" ? [i] : []);
  const sellIndices = plannedTimeline.flatMap((step, i) => step.walletName === walletName && step.action === "sell" ? [i] : []);
  const solState = status === "arming"
    ? "live"
    : solBalance != null && solBalance > 0
      ? "done"
      : status === "error"
        ? "error"
        : "idle";
  const tokenState = buyIndices.some((i) => i < completedFireCount) && !sellIndices.some((i) => i < completedFireCount)
    ? "done"
    : (firingAll && firingStep !== null && buyIndices.includes(firingStep) ? "live" : "idle");
  return (
    <div className="seq-word-lane">
      <span className={`wallet-status-dot ws-${status}`} title={status} />
      <span className="seq-word-lane-tag">{lane === "P" ? "Pre" : "Suff"}</span>
      <span className="seq-word-bal mono">{fmtSolLamports(solBalance)} SOL</span>
      <Indicator label="SOL" state={solState} />
      <Indicator label="TOK" state={tokenState} />
      <StepLight label="BUY" indices={buyIndices} completedFireCount={completedFireCount} firingAll={firingAll} firingStep={firingStep} armed={status === "armed"} />
      <StepLight label="SELL" indices={sellIndices} completedFireCount={completedFireCount} firingAll={firingAll} firingStep={firingStep} armed={status === "armed"} />
    </div>
  );
}

function BarLight({ label, state }: { label: string; state: "off" | "on" | "live" }) {
  return (
    <span className="seq-bar-light-wrap">
      <span className={`seq-bar-light seq-bar-${state}`} />
      <span className="seq-bar-light-label">{label}</span>
    </span>
  );
}

interface StepLightProps {
  label: "BUY" | "SELL";
  indices: number[];
  completedFireCount: number;
  firingAll: boolean;
  firingStep: number | null;
  armed: boolean;
}

function Indicator({ label, state }: { label: string; state: "idle" | "armed" | "live" | "done" | "error" }) {
  return (
    <span className="seq-indicator">
      <span className={`seq-light seq-light-${state}`} />
      <span className="seq-light-label">{label}</span>
    </span>
  );
}

function StepLight({ label, indices, completedFireCount, firingAll, firingStep, armed }: StepLightProps) {
  const state = indices.length === 0
    ? "na"
    : indices.some((i) => i < completedFireCount)
      ? "done"
      : (firingAll && firingStep !== null && indices.includes(firingStep) ? "live" : armed ? "armed" : "idle");
  return <Indicator label={label} state={state === "na" ? "idle" : state} />;
}
