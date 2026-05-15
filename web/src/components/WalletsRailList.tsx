import type { WalletInfo } from "../types";

interface Props {
  wallets: WalletInfo[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

export function WalletsRailList({ wallets, selectedName, onSelect }: Props) {
  if (wallets.length === 0) {
    return <div className="rail-empty muted small">no wallets</div>;
  }
  return (
    <ul className="pool-list">
      {wallets.map((w) => {
        const sel = w.name === selectedName;
        return (
          <li
            key={w.name}
            className={`pool-list-item ${sel ? "selected" : ""}`}
            onClick={() => onSelect(w.name)}
          >
            <div className="pli-row">
              <div className="pli-body">
                <div className="pli-head">
                  <span className="pli-name" title={w.name}>{w.label || w.name}</span>
                </div>
                <div className="pli-meta small muted">
                  <span>{w.affix !== "none" ? w.affix : "—"}</span>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
