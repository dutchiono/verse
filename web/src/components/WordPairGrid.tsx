import { useMemo, useRef } from "react";
import { fmtTokenUi } from "../fmtToken";
import type { WalletInfo, WalletStatus } from "../types";

interface Props {
  wallets: WalletInfo[];
  statuses: Record<string, WalletStatus>;
  solBalances: Record<string, number | null>;
  tokenBalances: Record<string, number | null>;
  hasPool: boolean;
  /** Name of the wallet currently designated as control. Highlighted in the grid. */
  controlWalletName?: string | null;
  selectedWalletName?: string | null;
  onSelectWallet?: (name: string) => void;
  /** Show enable/delete controls on hover. Omit for read-only display. */
  onTogglePair?: (names: string[], enabled: boolean) => void;
  onDeletePair?: (names: string[]) => void;
}

/**
 * Compact word-pair card grid: groups wallets by label, displays prefix / suffix
 * side-by-side with balances and a live status dot per wallet.
 */
export function WordPairGrid({
  wallets, statuses, solBalances, tokenBalances, hasPool, controlWalletName, selectedWalletName, onSelectWallet, onTogglePair, onDeletePair,
}: Props) {
  const groups = useMemo(() => groupByWord(wallets), [wallets]);
  if (groups.length === 0) return null;
  return (
    <div className="roster-word-grid">
      {groups.map(([key, group]) => (
        <WordCard
          key={key}
          label={key.startsWith("~") ? null : key}
          group={group}
          statuses={statuses}
          solBalances={solBalances}
          tokenBalances={tokenBalances}
          hasPool={hasPool}
          controlWalletName={controlWalletName}
          selectedWalletName={selectedWalletName}
          onSelectWallet={onSelectWallet}
          onTogglePair={onTogglePair}
          onDeletePair={onDeletePair}
        />
      ))}
    </div>
  );
}

function groupByWord(wallets: WalletInfo[]): [string, WalletInfo[]][] {
  const groups = new Map<string, WalletInfo[]>();
  for (const w of wallets) {
    const key = w.label.trim() ? w.label.trim() : `~${w.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }
  for (const [, group] of groups) {
    group.sort((a, b) => {
      const ao = { prefix: 0, suffix: 1, none: 2 }[a.affix] ?? 2;
      const bo = { prefix: 0, suffix: 1, none: 2 }[b.affix] ?? 2;
      return ao - bo;
    });
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const aU = a.startsWith("~"), bU = b.startsWith("~");
    if (aU !== bU) return aU ? 1 : -1;
    return a.localeCompare(b);
  });
}

function StatusDot({ status }: { status: WalletStatus }) {
  return <span className={`wallet-status-dot ws-${status}`} title={status} />;
}

interface WordCardProps {
  label: string | null;
  group: WalletInfo[];
  statuses: Record<string, WalletStatus>;
  solBalances: Record<string, number | null>;
  tokenBalances: Record<string, number | null>;
  hasPool: boolean;
  controlWalletName?: string | null;
  selectedWalletName?: string | null;
  onSelectWallet?: (name: string) => void;
  onTogglePair?: (names: string[], enabled: boolean) => void;
  onDeletePair?: (names: string[]) => void;
}

function WordCard({ label, group, statuses, solBalances, tokenBalances, hasPool, controlWalletName, selectedWalletName, onSelectWallet, onTogglePair, onDeletePair }: WordCardProps) {
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const prefix = group.find((w) => w.affix === "prefix");
  const suffix = group.find((w) => w.affix === "suffix");
  const solos  = group.filter((w) => w.affix === "none");
  const allDisabled = group.every((w) => !w.enabled);
  const someDisabled = group.some((w) => !w.enabled);
  const nextEnabled = allDisabled || someDisabled;
  const isControl = group.some((w) => w.name === controlWalletName);
  const names = group.map((w) => w.name);

  function onButtonPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }

  function isRealButtonClick(e: React.MouseEvent<HTMLButtonElement>): boolean {
    e.preventDefault();
    e.stopPropagation();
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!start) return true;
    return Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6;
  }

  return (
    <div className={`roster-word-card${allDisabled ? " rwc-all-off" : ""}${isControl ? " rwc-is-control" : ""}`}>
      <div className="rwc-card-head">
        <div className="rwc-label">
          {label ?? <span className="muted small">—</span>}
          {isControl && <span className="rwc-control-badge">CTRL</span>}
        </div>
        {(onTogglePair || onDeletePair) && (
          <div className="rwc-card-actions">
            {onTogglePair && (
              <button
                type="button"
                className={`rwc-card-toggle ${allDisabled ? "off" : "on"}`}
                draggable={false}
                onPointerDown={onButtonPointerDown}
                onClick={(e) => {
                  if (!isRealButtonClick(e)) return;
                  onTogglePair(names, nextEnabled);
                }}
                title={allDisabled ? "enable pair" : someDisabled ? "enable all in pair" : "disable pair"}
              >
                {allDisabled ? "OFF" : someDisabled ? "MIX" : "ON"}
              </button>
            )}
            {onDeletePair && (
              <button
                type="button"
                className="rwc-card-delete"
                draggable={false}
                onPointerDown={onButtonPointerDown}
                onClick={(e) => {
                  if (!isRealButtonClick(e)) return;
                  const name = label ?? group.map((w) => w.name).join(", ");
                  if (confirm(`Delete wallet pair "${name}"?`)) onDeletePair(names);
                }}
                title="delete pair"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {(prefix || suffix) && (
        <div className={`rwc-pair${!prefix || !suffix ? " rwc-solo" : ""}`}>
          {prefix && (
            <WalletHalf
              wallet={prefix}
              status={statuses[prefix.name] ?? "idle"}
              solBalance={solBalances[prefix.name]}
              tokenBalance={tokenBalances[prefix.name]}
              hasPool={hasPool}
              isControl={prefix.name === controlWalletName}
              isSelected={prefix.name === selectedWalletName}
              onSelect={onSelectWallet}
            />
          )}
          {suffix && (
            <WalletHalf
              wallet={suffix}
              status={statuses[suffix.name] ?? "idle"}
              solBalance={solBalances[suffix.name]}
              tokenBalance={tokenBalances[suffix.name]}
              hasPool={hasPool}
              isControl={suffix.name === controlWalletName}
              isSelected={suffix.name === selectedWalletName}
              onSelect={onSelectWallet}
            />
          )}
        </div>
      )}

      {solos.map((w) => (
        <WalletHalf
          key={w.name}
          wallet={w}
          status={statuses[w.name] ?? "idle"}
          solBalance={solBalances[w.name]}
          tokenBalance={tokenBalances[w.name]}
          hasPool={hasPool}
          isControl={w.name === controlWalletName}
          isSelected={w.name === selectedWalletName}
          onSelect={onSelectWallet}
        />
      ))}
    </div>
  );
}

interface WalletHalfProps {
  wallet: WalletInfo;
  status: WalletStatus;
  solBalance: number | null | undefined;
  tokenBalance: number | null | undefined;
  hasPool: boolean;
  isControl?: boolean;
  isSelected?: boolean;
  onSelect?: (name: string) => void;
}

function WalletHalf({ wallet, status, solBalance, tokenBalance, hasPool, isControl, isSelected, onSelect }: WalletHalfProps) {
  const sol = solBalance != null ? (solBalance / 1e9).toFixed(4) : "—";
  const affixChar = wallet.affix === "prefix" ? "P" : wallet.affix === "suffix" ? "S" : "·";

  return (
    <button
      type="button"
      className={`rwc-half${!wallet.enabled ? " rwc-half-off" : ""}${isControl ? " rwc-half-is-control" : ""}${isSelected ? " rwc-half-selected" : ""}`}
      disabled={!wallet.enabled || isControl || !onSelect}
      onClick={() => onSelect?.(wallet.name)}
      title={onSelect ? `load ${wallet.name} in Quick Swap` : wallet.name}
    >
      <div className="rwc-half-head">
        <StatusDot status={status} />
        <span className="rwc-affix-tag small muted">{affixChar}</span>
        <span className={`rwc-wallet-state ${wallet.enabled ? "on" : "off"}`}>
          {wallet.enabled ? "on" : "off"}
        </span>
      </div>
      <div className="rwc-sol mono">{sol}</div>
      {hasPool && <div className="rwc-tok mono muted">{fmtTokenUi(tokenBalance)}</div>}
    </button>
  );
}
