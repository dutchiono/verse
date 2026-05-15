import type { PoolView } from "../types";

interface Props {
  pools: PoolView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDeletePool: (poolId: string, name: string) => void;
}

export function PoolsList({ pools, selectedId, onSelect, onDeletePool }: Props) {
  if (pools.length === 0) {
    return <div className="rail-empty muted small">no pools</div>;
  }
  return (
    <ul className="pool-list">
      {pools.map((p) => {
        const sel = p.id === selectedId;
        const seqLen = p.sequencer.queue.length;
        return (
          <li
            key={p.id}
            className={`pool-list-item ${sel ? "selected" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <div className="pli-row">
              <div className="pli-body">
                <div className="pli-head">
                  <span className="pli-name">{p.name}</span>
                  {seqLen > 0 && <span className="pli-tag">{seqLen}</span>}
                </div>
                <div className="pli-meta small muted">
                  <span>{p.type === "meteora-dbc" ? "DBC" : "DAMM"}</span>
                </div>
              </div>
              <button
                type="button"
                className="ghost small danger pli-del"
                title="Delete pool"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeletePool(p.id, p.name);
                }}
              >
                ×
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
