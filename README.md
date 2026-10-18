# Headline to Market

RoadToDevcon IX — Problem 2. Turn a news headline (plus optional snippet) into a
**structured, editor-settleable prediction-market draft** — or explicitly reject it
when the headline cannot become a fair, resolvable market.

The result is never auto-published. Every draft stays `draft` until a human editor
explicitly approves it through the UI/API.

---

## What it does

1. **Generate** — paste a headline (and optional article snippet). The app asks an
   OpenAI-compatible model for a strict JSON object that either:
   - **resolvable**: `question`, `deadline`, `resolutionRules`, `outcomes`,
     `sourceName` — a complete draft, or
   - **unresolvable**: `reason`, `missingInformation[]`, `suggestedRevision` —
     an explanation of why the headline cannot be turned into a market.
2. **Validate** — the model output is parsed with a Zod discriminated union, then
   re-checked semantically with the app's own clock and rules (future deadline with
   minimum lead time, binary outcomes, deadline mentioned in the rules, …).
3. **Edit** — drafts are listed in the editor workspace; fields can be corrected
   by hand. Every correction is re-validated server-side.
4. **Approve / discard** — approval requires an explicit confirmation (and the
   editor token when one is configured) and re-validates the stored draft against
   the current time, so an expired draft cannot slip through.
5. **Fallback** — if the model is unreachable, times out, or returns invalid JSON,
   the user sees a clear, retryable error instead of a broken draft.

Example headlines:

| Headline | Expected outcome |
| --- | --- |
| "OpenAI releases GPT-5 before December 31, 2026, company says" | resolvable draft |
| "Bitcoin closes above $150,000 on December 31, 2026, Binance data shows" | resolvable draft |
| "India completes its first crewed space station module by 2028, ISRO confirms" | resolvable draft |
| "Bengaluru traffic will improve next year" | rejected: no measurable outcome/deadline |
| "Will AI be good for humanity?" | rejected: subjective |
| "The best phone ever will be released soon" | rejected: subjective / no deadline |

---

## Quick start

```bash
npm ci                     # install dependencies (Node >= 20.9)
cp .env.example .env       # then edit .env (see configuration below)
npm run dev                # http://localhost:3000
```

No API key? Leave `LLM_API_KEY` empty: the app then runs a clearly labelled
**heuristic provider** that generates drafts offline from the headline text. It is
useful for demos and tests, but it is not a language model — set a key for real
generation.

```bash
npm run build && npm start # production build on http://localhost:3000
```

---

## Architecture

```
src/
  app/                          Next.js App Router pages + thin route handlers
    page.tsx                    renders <EditorWorkspace/>
    api/…                       parse request → domain handler → JSON response
  components/                   React UI (editor workspace, dialogs, panels)
  lib/
    domain/schema.ts            Zod: ModelOutputSchema, MarketRecordSchema, requests
    domain/semantic-validation.ts  clock-aware deadline/question/rules checks
    llm/prompt.ts               static SYSTEM_INSTRUCTIONS + untrusted-data framing
    llm/openai-provider.ts      fetch + AbortSignal.timeout + bounded retries
    llm/heuristic-provider.ts   offline fallback for keyless demos/tests
    llm/config.ts               env parsing with clamps (timeout, attempts)
    market-service.ts           draft → approve/discard lifecycle, re-validation
    db.ts                       better-sqlite3 storage; re-validates every record
    http.ts                     HttpError → status mapping, guarded JSON body read
    api-auth.ts                 optional x-editor-token, timing-safe comparison
    api/handlers.ts             framework-agnostic request handlers
tests/
  unit/          schema, deadline, semantic validation, prompt, providers, auth
  integration/   service + handlers + database against real SQLite
  golden/        17-case golden set executed deterministically
  e2e/           Playwright: generate → approve, and rejection flow
scripts/
  eval-golden.ts          CLI golden-set runner (exit code for CI)
  audit-acceptance.ts     behavioural audit of the 10 acceptance checks
  scan-secrets.ts         credential scanner (works on working-tree files)
```

Request path: `route handler` → `lib/api/handlers.ts` → `MarketService` →
(provider → schema → semantic validation) → `db.ts`. All validation errors become
typed HTTP errors (`400/401/404/409/422/500/502/504`), never stack traces.

---

## API

| Method & path | Purpose |
| --- | --- |
| `POST /api/draft` | Generate + validate a new draft (or rejection). Body: `{ headline, snippet? }` |
| `GET /api/markets` | List markets (newest first) |
| `GET /api/markets/:id` | Fetch one market |
| `PATCH /api/markets/:id` | Edit a draft's fields; re-validated server-side |
| `POST /api/markets/:id/approve` | Approve a draft. Body: `{ confirm: true }` |
| `POST /api/markets/:id/discard` | Discard a draft (`confirm: true`) |
| `GET /api/config` | Runtime capabilities (provider mode, structured-output mode) |

When `EDITOR_ACCESS_TOKEN` is set, every mutating call must send
`x-editor-token: <token>`; wrong/missing tokens return `401`.

---

## Validation pipeline

1. **Transport** — `AbortSignal.timeout(LLM_TIMEOUT_MS)` on every model request;
   retries are bounded by `LLM_MAX_ATTEMPTS` and only retried for transient
   errors (5xx/network) — `401`/`400` never retried.
2. **Shape** — `ModelOutputSchema.safeParse` (Zod discriminated union). Unknown
   status values are impossible: the schema only accepts the `draft` literal on
   market output.
3. **Semantics** — clock-injected checks: deadline must be in the future with a
   minimum lead time, be a real calendar instant, appear in the resolution rules,
   and outcomes may not contradict rules (see `validateMarketSemantics`).
4. **Storage** — records are re-parsed with `MarketRecordSchema` on read and
   write, so corrupt rows cannot leak into the API.
5. **Approval** — `approve()` reloads the record, re-runs schema + semantic
   validation with the current clock, and refuses expired drafts with `422`.

If generation fails all steps, the service performs up to
`maxCorrectionPasses` (default 1) of model-guided correction before returning
`502 llm_invalid_response` — and no draft is stored.

---

## LLM safety

- The headline/snippet are **untrusted data**: `SYSTEM_INSTRUCTIONS` is a static
  constant and user text is always sent as a single user-role message inside
  `<headline>`/`<article_snippet>` delimiters, with `</…>` breakouts neutralised.
- Prompt-injection attempts ("ignore previous instructions…") are covered by the
  golden set; the schema still forces a valid draft or an explicit rejection.
- No secret is ever sent to the model beyond the API key header required by the
  configured endpoint.
- Approval is **in-tool only**: the UI states explicitly that approving does not
  publish to any external platform.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_API_KEY` | *(empty)* | Empty ⇒ offline heuristic provider (clearly labelled) |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `LLM_MODEL` | `gpt-4o-mini` | Model name for the endpoint |
| `LLM_PROVIDER` | `auto` | `auto` honours the key; `heuristic` forces offline |
| `LLM_STRUCTURED_OUTPUT` | `json_schema` | `json_schema` \| `json_object` \| `none` |
| `LLM_TIMEOUT_MS` | `30000` | Per-request hard timeout, clamped 1 000–120 000 |
| `LLM_MAX_ATTEMPTS` | `3` | Total attempts, clamped 1–5 |
| `DATABASE_PATH` | `./.data/markets.db` | SQLite file (directory must be writable) |
| `EDITOR_ACCESS_TOKEN` | *(empty)* | Optional header token for mutating endpoints |

---

## Testing & verification

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm test              # vitest: 156 tests (unit + integration + golden)
npm run test:golden   # 17-case golden set only
npm run eval:golden   # CLI golden runner (17/17 expected, non-zero exit on fail)
npm run audit         # 10-check acceptance audit (80 pts; prints PASS/FAIL table)
npm run scan:secrets  # credential scan of tracked + untracked-not-ignored files
npm run e2e           # production build + Playwright editor flows
npm run verify        # typecheck → lint → test → audit → scan → build
```

The **golden set** (`tests/fixtures/golden-set.json`) contains 17 labelled cases:
valid headlines, expected rejections (subjective, ambiguous, missing details,
impossible deadlines, weak sourcing, contradictory context, bundled events) and
prompt-injection attempts. It runs deterministically against the heuristic
provider, so it needs no API key and no network.

---

## Design decisions & limitations

- **Heuristic fallback is not an LLM.** It is text-pattern based, exists so the
  app (and the test suite) works without credentials, and is always labelled in
  the `/api/config` response and the UI.
- **Approval is local.** The tool manages a review workflow; it does not publish
  to any prediction-market platform, exchange, or external API.
- **Settlement is out of scope.** The output is a draft with rules an editor
  could settle manually; no automated oracle or payout logic exists.
- **Single-editor model.** One optional shared token, intended for local/demo
  use — not multi-tenant auth.
- **SQLite storage.** Fine for local use and review; not tuned for concurrent
  production traffic.
- The semantic checks are deliberately conservative (e.g. deadline mention in
  rules, minimum lead time); some legitimate headlines may need an edit pass.

## License

MIT — see `package.json`. Built for RoadToDevcon IX, Problem 2.
