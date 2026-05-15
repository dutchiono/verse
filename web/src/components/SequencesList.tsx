import type { SavedSequence, WalletInfo } from "../types";

interface Props {
  sequences: SavedSequence[];
  selectedId: string | null;
  wallets: WalletInfo[];
  onSelect: (id: string) => void;
}

export function SequencesList({ sequences, selectedId, wallets, onSelect }: Props) {
  if (sequences.length === 0) {
    return <div className="rail-empty muted small">no sequences</div>;
  }
  return (
    <ul className="pool-list">
      {sequences.map((s) => {
        const sel = s.id === selectedId;
        return (
          <li
            key={s.id}
            className={`pool-list-item ${sel ? "selected" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="pli-row">
              <div className="pli-body">
                <div className="pli-head">
                  <span className="pli-name">{s.name}</span>
                </div>
                <div className="pli-meta small muted">
                  <span>{s.queue.length} step{s.queue.length === 1 ? "" : "s"}</span>
                  <span>· {preview(s, wallets) || "empty"}</span>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function preview(s: SavedSequence, wallets: WalletInfo[]): string {
  return s.queue
    .map((q) => wallets.find((w) => w.name === q.walletName)?.label || q.walletName)
    .join(" ");
}
