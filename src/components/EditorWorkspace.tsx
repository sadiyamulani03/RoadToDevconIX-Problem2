"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import ErrorPanel from "./ErrorPanel";
import GenerationProvenance from "./GenerationProvenance";
import HeadlineForm from "./HeadlineForm";
import MarketList from "./MarketList";
import { GenerationBadge, StatusBadge } from "./StatusBadge";
import UnresolvablePanel from "./UnresolvablePanel";
import ValidationIssues from "./ValidationIssues";
import {
  approveMarket,
  discardMarket,
  fetchRuntimeConfig,
  getMarket,
  listMarkets,
  requestDraft,
  updateMarket,
} from "@/lib/client/api";
import type { ApiErrorInfo, DraftResponse, RuntimeConfig } from "@/lib/client/types";
import type { MarketFields, MarketRecord } from "@/lib/domain/schema";
import { MAX_HEADLINE_LENGTH } from "@/lib/domain/constants";

const TOKEN_STORAGE_KEY = "headline-to-market:editor-token";

type DialogKind = "approve" | "discard";

function toEditableFields(market: MarketRecord): MarketFields {
  return {
    question: market.market.question,
    closeAt: market.market.closeAt,
    timezone: market.market.timezone,
    resolutionSource: market.market.resolutionSource,
    resolutionSourceUrl: market.market.resolutionSourceUrl,
    yesCriteria: market.market.yesCriteria,
    noCriteria: market.market.noCriteria,
    resolutionRules: [...market.market.resolutionRules],
    reasoning: market.market.reasoning,
  };
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function EditorWorkspace() {
  const [editorToken, setEditorToken] = useState("");
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [headline, setHeadline] = useState("");
  const [snippet, setSnippet] = useState("");
  const [headlineError, setHeadlineError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [draftResult, setDraftResult] = useState<DraftResponse | null>(null);
  const [generationError, setGenerationError] = useState<ApiErrorInfo | null>(null);

  const [markets, setMarkets] = useState<MarketRecord[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketRecord | null>(null);

  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<MarketFields | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiErrorInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let token = "";
    try {
      token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
    } catch {
      token = "";
    }
    setEditorToken(token);
    setTokenLoaded(true);
  }, []);

  const loadMarkets = useCallback(
    async (token: string) => {
      setMarketsLoading(true);
      const result = await listMarkets(token);
      if (result.ok) {
        setMarkets(result.data.markets);
        setListError(null);
      } else {
        setListError(result.error.message);
      }
      setMarketsLoading(false);
    },
    [],
  );

  useEffect(() => {
    if (!tokenLoaded) return;
    let cancelled = false;
    void (async () => {
      const config = await fetchRuntimeConfig(editorToken);
      if (cancelled) return;
      if (config.ok) {
        setRuntimeConfig(config.data);
        setConfigError(null);
      } else {
        setConfigError(config.error.message);
      }
      await loadMarkets(editorToken);
    })();
    return () => {
      cancelled = true;
    };
  }, [editorToken, tokenLoaded, loadMarkets]);

  const updateToken = (value: string) => {
    setEditorToken(value);
    try {
      if (value.trim() === "") {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      } else {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
      }
    } catch {
      // Session storage may be unavailable (private mode); the token still
      // works for this render pass.
    }
  };

  const handleGenerate = async () => {
    const trimmed = headline.trim();
    if (trimmed.length < 8) {
      setHeadlineError("Enter a headline of at least 8 characters.");
      return;
    }
    if (trimmed.length > MAX_HEADLINE_LENGTH) {
      setHeadlineError(`The headline must be at most ${MAX_HEADLINE_LENGTH} characters.`);
      return;
    }
    setHeadlineError(null);
    setGenerating(true);
    setGenerationError(null);
    setActionError(null);
    setNotice(null);
    setEditing(false);
    setDraftResult(null);
    setSelected(null);
    setActiveId(null);

    const result = await requestDraft(
      { headline: trimmed, articleSnippet: snippet.trim() === "" ? null : snippet },
      editorToken,
    );
    setGenerating(false);

    if (!result.ok) {
      setGenerationError(result.error);
      return;
    }

    setDraftResult(result.data);
    if (result.data.outcome === "resolvable") {
      setSelected(result.data.market);
      setActiveId(result.data.market.id);
      await loadMarkets(editorToken);
    }
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  const handleOpen = async (id: string) => {
    setActiveId(id);
    setDraftResult(null);
    setGenerationError(null);
    setActionError(null);
    setNotice(null);
    setEditing(false);
    const result = await getMarket(id, editorToken);
    if (result.ok) {
      setSelected(result.data.market);
    } else {
      setActionError(result.error);
      setSelected(null);
    }
  };

  const handleStartEdit = () => {
    if (!selected) return;
    setEditFields(toEditableFields(selected));
    setEditError(null);
    setEditing(true);
  };

  const setField = <K extends keyof MarketFields>(key: K, value: MarketFields[K]) => {
    setEditFields((current) => (current ? { ...current, [key]: value } : current));
  };

  const setRule = (index: number, value: string) => {
    setEditFields((current) => {
      if (!current) return current;
      const rules = [...current.resolutionRules];
      rules[index] = value;
      return { ...current, resolutionRules: rules };
    });
  };

  const handleSaveEdit = async () => {
    if (!selected || !editFields) return;
    setSaving(true);
    setEditError(null);
    const result = await updateMarket(selected.id, editFields, editorToken);
    setSaving(false);
    if (!result.ok) {
      setEditError(result.error.message);
      return;
    }
    setSelected(result.data.market);
    setEditing(false);
    setNotice("Draft updated. Semantic validation has been re-run server-side.");
    await loadMarkets(editorToken);
  };

  const runDialogAction = async () => {
    if (!selected || !dialog) return;
    setDialogBusy(true);
    setActionError(null);
    const result =
      dialog === "approve"
        ? await approveMarket(selected.id, editorToken)
        : await discardMarket(selected.id, editorToken);
    setDialogBusy(false);
    setDialog(null);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setSelected(result.data.market);
    setEditing(false);
    setNotice(
      dialog === "approve"
        ? "Market approved for publication inside this tool. This build does not publish to any external market or exchange."
        : "Draft discarded. Discarded drafts can no longer be approved or edited.",
    );
    await loadMarkets(editorToken);
  };

  const draftGeneration = draftResult?.generation ?? null;
  const selectedIssues = selected?.semanticIssues ?? [];
  const canApprove = selected?.status === "draft";
  const canDiscard = selected?.status === "draft";

  const dialogCopy = useMemo(() => {
    if (dialog === "approve") {
      return {
        title: "Approve this market draft?",
        description:
          "Approval re-validates the stored draft (schema and semantic checks) and locks its rules. It records approval inside this tool only; no external market is created or published. This action cannot be undone.",
        confirmLabel: "Approve for publication",
        tone: "primary" as const,
      };
    }
    return {
      title: "Discard this draft?",
      description:
        "The draft will be marked discarded, removed from the approval workflow and can no longer be approved or edited. This action cannot be undone.",
      confirmLabel: "Discard draft",
      tone: "danger" as const,
    };
  }, [dialog]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <h1>Headline to Market</h1>
            <p className="tagline">
              Turn a news headline into a fair, editor-settleable prediction-market draft — or get an
              explicit, reasoned rejection. Every draft is validated server-side before an editor can
              approve it.
            </p>
          </div>
          <div className="masthead-side">
            {runtimeConfig ? (
              <GenerationBadge
                mode={runtimeConfig.provider.mode}
                model={runtimeConfig.provider.model}
                fallbackReason={runtimeConfig.provider.fallbackReason}
              />
            ) : null}
            <div className="token-field">
              <label htmlFor="editor-token">Editor token</label>
              <input
                id="editor-token"
                type="password"
                autoComplete="off"
                value={editorToken}
                placeholder={
                  runtimeConfig?.accessControl.editorTokenRequired
                    ? "required"
                    : "not required (local demo)"
                }
                onChange={(event) => updateToken(event.target.value)}
              />
            </div>
          </div>
        </div>
      </header>

      {configError ? (
        <div className="workspace">
          <div className="primary-column">
            <ErrorPanel
              error={{
                code: "network_error",
                message: configError,
                retryable: true,
              }}
              onRetry={() => void loadMarkets(editorToken)}
              showRetry
            />
          </div>
        </div>
      ) : null}

      <main className="workspace" id="main">
        <div className="primary-column">
          <HeadlineForm
            headline={headline}
            snippet={snippet}
            onHeadlineChange={setHeadline}
            onSnippetChange={setSnippet}
            onGenerate={() => void handleGenerate()}
            generating={generating}
            headlineError={headlineError}
          />

          {runtimeConfig?.sourceVerification === "syntactic-only" ? (
            <div className="notice" data-testid="verification-notice">
              Source URLs are checked for syntax only. They are never fetched or independently
              verified, and a syntactically valid URL is not proof that a source is authoritative.
            </div>
          ) : null}

          <div ref={resultRef}>
            {generating ? (
              <section className="card" aria-live="polite">
                <div className="loading-row">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    Generating a draft… the model call has a hard server-side timeout and a bounded
                    number of attempts.
                  </span>
                </div>
              </section>
            ) : null}

            {generationError ? (
              <ErrorPanel
                error={generationError}
                onRetry={() => void handleGenerate()}
                showRetry
              />
            ) : null}

            {draftResult?.outcome === "unresolvable" ? (
              <UnresolvablePanel
                rejection={draftResult.rejection}
                generation={draftResult.generation}
                onTryAgain={() => {
                  setDraftResult(null);
                  document.getElementById("headline-input")?.focus();
                }}
              />
            ) : null}
          </div>

          {actionError ? (
            <ErrorPanel
              error={actionError}
              onRetry={() => setActionError(null)}
              showRetry={false}
            />
          ) : null}

          {notice ? (
            <div className="notice" role="status" data-testid="action-notice">
              {notice}
            </div>
          ) : null}

          {selected ? (
            <section className="card" aria-labelledby="draft-heading" data-testid="market-detail">
              <div className="card-header">
                <h2 id="draft-heading" style={{ fontSize: 18 }}>
                  2 · Market record
                </h2>
                <span className="market-meta">
                  <StatusBadge status={selected.status} />
                  <span>rev {selected.revision}</span>
                  <span>{selected.generationMode === "llm" ? "LLM" : "heuristic fallback"}</span>
                </span>
              </div>

              {selected.status === "approved" ? (
                <p className="readonly-banner notice">
                  This market is approved for publication inside this tool and its rules are locked.
                  This build does not connect to any external market or exchange.
                </p>
              ) : null}
              {selected.status === "discarded" ? (
                <p className="readonly-banner notice">
                  This draft was discarded. It cannot be approved or edited.
                </p>
              ) : null}

              {editing && editFields ? (
                <div>
                  <div className="field">
                    <label htmlFor="edit-question">Question</label>
                    <textarea
                      id="edit-question"
                      value={editFields.question}
                      rows={2}
                      onChange={(event) => setField("question", event.target.value)}
                    />
                  </div>
                  <div className="field-grid">
                    <div className="field">
                      <label htmlFor="edit-close-at">Close time (ISO 8601 with timezone)</label>
                      <input
                        id="edit-close-at"
                        type="text"
                        className="mono"
                        value={editFields.closeAt}
                        onChange={(event) => setField("closeAt", event.target.value)}
                      />
                      <span className="timestamp-preview">
                        {formatInstant(editFields.closeAt)}
                      </span>
                    </div>
                    <div className="field">
                      <label htmlFor="edit-timezone">Timezone label</label>
                      <input
                        id="edit-timezone"
                        type="text"
                        value={editFields.timezone}
                        onChange={(event) => setField("timezone", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="edit-source">Resolution source</label>
                      <input
                        id="edit-source"
                        type="text"
                        value={editFields.resolutionSource}
                        onChange={(event) => setField("resolutionSource", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="edit-source-url">Resolution source URL (optional)</label>
                      <input
                        id="edit-source-url"
                        type="text"
                        className="mono"
                        value={editFields.resolutionSourceUrl ?? ""}
                        onChange={(event) =>
                          setField(
                            "resolutionSourceUrl",
                            event.target.value.trim() === "" ? null : event.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="field full">
                      <label htmlFor="edit-yes">YES criteria</label>
                      <textarea
                        id="edit-yes"
                        value={editFields.yesCriteria}
                        rows={2}
                        onChange={(event) => setField("yesCriteria", event.target.value)}
                      />
                    </div>
                    <div className="field full">
                      <label htmlFor="edit-no">NO criteria</label>
                      <textarea
                        id="edit-no"
                        value={editFields.noCriteria}
                        rows={2}
                        onChange={(event) => setField("noCriteria", event.target.value)}
                      />
                    </div>
                    <div className="field full">
                      <div className="rules-header">
                        <label>Resolution rules</label>
                        <span className="card-subtle">3–8 rules</span>
                      </div>
                      {editFields.resolutionRules.map((rule, index) => (
                        <div className="rule-item" key={index}>
                          <textarea
                            aria-label={`Resolution rule ${index + 1}`}
                            value={rule}
                            rows={2}
                            onChange={(event) => setRule(index, event.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="field full">
                      <label htmlFor="edit-reasoning">Reasoning</label>
                      <textarea
                        id="edit-reasoning"
                        value={editFields.reasoning}
                        rows={3}
                        onChange={(event) => setField("reasoning", event.target.value)}
                      />
                    </div>
                  </div>

                  {editError ? (
                    <p className="error-text" role="alert">
                      {editError}
                    </p>
                  ) : null}

                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void handleSaveEdit()}
                      disabled={saving}
                    >
                      {saving ? "Saving…" : "Save draft changes"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setEditing(false)}
                      disabled={saving}
                    >
                      Cancel editing
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="draft-question" data-testid="draft-question">
                    {selected.market.question}
                  </p>

                  <dl className="field-grid">
                    <div className="field">
                      <dt>
                        <strong>Closes</strong>
                      </dt>
                      <dd>
                        {formatInstant(selected.market.closeAt)}{" "}
                        <span className="card-subtle">({selected.market.timezone})</span>
                      </dd>
                    </div>
                    <div className="field">
                      <dt>
                        <strong>Resolution source</strong>
                      </dt>
                      <dd>
                        {selected.market.resolutionSource}
                        {selected.market.resolutionSourceUrl ? (
                          <>
                            {" "}
                            <span className="card-subtle">
                              ({selected.market.resolutionSourceUrl})
                            </span>
                          </>
                        ) : null}
                      </dd>
                    </div>
                    <div className="field full">
                      <dt>
                        <strong>YES criteria</strong>
                      </dt>
                      <dd>{selected.market.yesCriteria}</dd>
                    </div>
                    <div className="field full">
                      <dt>
                        <strong>NO criteria</strong>
                      </dt>
                      <dd>{selected.market.noCriteria}</dd>
                    </div>
                    <div className="field full">
                      <dt>
                        <strong>Resolution rules</strong>
                      </dt>
                      <dd>
                        <ol>
                          {selected.market.resolutionRules.map((rule, index) => (
                            <li key={index}>{rule}</li>
                          ))}
                        </ol>
                      </dd>
                    </div>
                    <div className="field full">
                      <dt>
                        <strong>Reasoning</strong>
                      </dt>
                      <dd>{selected.market.reasoning}</dd>
                    </div>
                  </dl>

                  <h3 style={{ fontSize: 15, marginTop: 10 }}>Semantic validation</h3>
                  <ValidationIssues issues={selectedIssues} />

                  <div className="btn-row" style={{ marginTop: 14 }}>
                    <button
                      type="button"
                      className={`btn ${canApprove ? "btn-accent" : "btn-outline"}`}
                      onClick={() => setDialog("approve")}
                      disabled={!canApprove}
                      data-testid="approve-button"
                    >
                      Approve for publication
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleStartEdit}
                      disabled={selected.status !== "draft"}
                    >
                      Edit draft
                    </button>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => setDialog("discard")}
                      disabled={!canDiscard}
                      data-testid="discard-button"
                    >
                      Discard draft
                    </button>
                  </div>

                  <GenerationProvenance generation={draftGeneration} />
                </div>
              )}
            </section>
          ) : null}
        </div>

        <aside className="sidebar">
          {listError ? (
            <div className="card">
              <p className="error-text" role="alert">
                {listError}
              </p>
            </div>
          ) : (
            <MarketList
              markets={markets}
              activeId={activeId}
              onOpen={(id) => void handleOpen(id)}
              loading={marketsLoading}
            />
          )}
        </aside>
      </main>

      <footer className="footer">
        <p>
          Local editorial tool · drafts are stored in a local SQLite database · model output is
          runtime-validated with Zod and re-validated semantically before approval · approval does not
          publish to any external market.
        </p>
      </footer>

      {dialog && selected ? (
        <ConfirmDialog
          title={dialogCopy.title}
          description={dialogCopy.description}
          confirmLabel={dialogCopy.confirmLabel}
          tone={dialogCopy.tone}
          busy={dialogBusy}
          onConfirm={() => void runDialogAction()}
          onCancel={() => {
            if (!dialogBusy) setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}
