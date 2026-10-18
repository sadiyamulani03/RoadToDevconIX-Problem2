import type { GenerationInfo, UnresolvableOutcome } from "@/lib/domain/schema";
import GenerationProvenance from "./GenerationProvenance";

interface UnresolvablePanelProps {
  rejection: UnresolvableOutcome;
  generation: GenerationInfo | null;
  onTryAgain: () => void;
}

export default function UnresolvablePanel({
  rejection,
  generation,
  onTryAgain,
}: UnresolvablePanelProps) {
  return (
    <section
      className="panel panel-rejection"
      aria-labelledby="rejection-heading"
      data-testid="unresolvable-panel"
    >
      <h3 id="rejection-heading">No fair market can be built from this headline</h3>
      <p data-testid="rejection-reason">{rejection.reason}</p>

      {rejection.missingInformation.length > 0 ? (
        <div>
          <h4 style={{ fontSize: 14, margin: "10px 0 4px" }}>Missing information</h4>
          <ul data-testid="rejection-missing">
            {rejection.missingInformation.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {rejection.suggestedRevision ? (
        <div>
          <h4 style={{ fontSize: 14, margin: "10px 0 4px" }}>Suggested revision</h4>
          <p style={{ fontStyle: "italic" }} data-testid="rejection-suggestion">
            {rejection.suggestedRevision}
          </p>
        </div>
      ) : null}

      <div className="panel-actions">
        <button type="button" className="btn btn-primary" onClick={onTryAgain}>
          Edit the headline and try again
        </button>
      </div>

      <GenerationProvenance generation={generation} />
    </section>
  );
}
