import type { MarketRecord } from "@/lib/domain/schema";
import { StatusBadge } from "./StatusBadge";

interface MarketListProps {
  markets: MarketRecord[];
  activeId: string | null;
  onOpen: (id: string) => void;
  loading: boolean;
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MarketList({ markets, activeId, onOpen, loading }: MarketListProps) {
  return (
    <section className="card" aria-labelledby="list-heading" data-testid="market-list">
      <div className="card-header">
        <h2 id="list-heading" style={{ fontSize: 17 }}>
          Market records
        </h2>
        <span className="card-subtle">{markets.length} total</span>
      </div>

      {loading ? (
        <p className="card-subtle">Loading…</p>
      ) : markets.length === 0 ? (
        <p className="empty-state" data-testid="market-list-empty">
          No drafts yet. Paste a headline and generate the first draft. Approved and discarded records
          will appear here.
        </p>
      ) : (
        <ul className="market-list">
          {markets.map((market) => (
            <li key={market.id}>
              <button
                type="button"
                className="market-item"
                aria-current={market.id === activeId}
                onClick={() => onOpen(market.id)}
              >
                <span className="market-question">{market.market.question}</span>
                <span className="market-meta">
                  <StatusBadge status={market.status} />
                  <span>{formatCreatedAt(market.createdAt)}</span>
                  <span>
                    {market.generationMode === "llm" ? "LLM" : "heuristic fallback"} · rev{" "}
                    {market.revision}
                  </span>
                  {market.semanticIssues.some((issue) => issue.severity === "error") ? (
                    <span className="badge badge-error">needs attention</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
