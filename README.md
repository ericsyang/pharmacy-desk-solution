# Pharmacy Desk

A TypeScript service that replaces Sam's manual pharmacy routing: an LLM extracts email changes, code validates them, and deterministic rules route each order using the facts known when it arrives.

Start with the [architecture and design decisions](architecture.md). The original [challenge](docs/challenge.md) and [simulator contract](sim/README.md) are preserved. All exercise data is fictional.

## Implementation

Node.js, Express, Zod, and `tsx` keep the service small: explicit HTTP handling, runtime contracts, and no build step. One process serializes events and holds state in memory.

| Files | Responsibility |
| --- | --- |
| `src/main.ts`, `src/server.ts`, `src/desk.ts` | Startup, webhook transport, event orchestration, and deduplication |
| `src/email.ts`, `src/model-schema.ts`, `src/changes.ts` | Model extraction, provider schema, and authority/evidence validation |
| `src/store.ts`, `src/time.ts`, `src/normalize.ts` | Temporal state, capacity, safety holds, and normalization |
| `src/routing.ts`, `src/pharmacy.ts`, `src/audit.ts` | Deterministic selection, submission, and audit files |
| `src/contracts.ts`, `scripts/`, `tests/` | Shared schemas, model/replay diagnostics, and verification |

Routing priority is **safety → latest matching ops preference → delivery speed → price → pharmacy ID**. An unsafe preferred pharmacy falls back to the best safe candidate; no safe candidate means `MANUAL`. Texas and TX normalize to the same state, then each pharmacy's restrictions are checked separately.

## Run

Requires **Node.js ≥22.18**; environment proxies require **≥24.14**.

```bash
npm install
test -f .env || cp .env.example .env
# Set LLM_API_KEY in .env; review the provider, model, and base URL.
npm start
```

The supplied configuration uses Anthropic's native Messages API: `LLM_PROVIDER=anthropic`, `LLM_BASE_URL=https://api.anthropic.com/v1`, and `LLM_MODEL=claude-sonnet-5-5`. Keep credentials in `.env`, which is ignored by Git. Optional proxy configuration is shown in [.env.example](.env.example); local pharmacy requests bypass it.

The service exposes `POST http://localhost:3000/webhooks` and `GET /health`; `PORT` is configurable. With the service running, use another terminal:

```bash
node sim/sim.mjs --target http://localhost:3000/webhooks --ping
# Restart the service after the ping and before each full manual replay.
node sim/sim.mjs --target http://localhost:3000/webhooks
```

## Verify

```bash
npm run typecheck
npm test
npm run diagnose:model       # Real API/extraction check; submits no orders.
npm run replay -- --runs 1    # One complete model-backed replay.
npm run replay               # Three complete replays; a fresh service per run.
```

The replay script starts its own services. It first checks the real model contract, then compares every order with independently labeled destinations. A clean simulator exit proves delivery completeness; the comparison checks routing correctness. Fixtures are test inputs only and are never read by production routing.

The **64 automated tests** cover routing and capacity; permissions and prompt injection; temporal changes, corrections, and scoped holds; event/order deduplication; model and HTTP contracts; uncertain submissions; audit failures; and complete public-week replay with fixed extractions. Provider calls are mocked in these tests; `diagnose:model` and `replay` exercise the real model.

Recorded validation: typecheck and all 64 tests passed. Three consecutive real replays using `claude-sonnet-5-5` each delivered **52/52 events**, submitted **38/38 orders**, and matched **38/38 expected destinations**, including five `MANUAL` orders. Each run retained two review items: an unauthorized instruction and an invalid dose. See [verification evidence](docs/verification.json). This covers the public week, not unseen weeks or production.

## Output files

Manual runs write to `out/`. Automated replays isolate each run under `out/verification/<timestamp>/run-N/`.

| File | Contents |
| --- | --- |
| `reviews.json` | Sam's current review list: original email, reason, resolution status, and any safety hold |
| `decisions.jsonl` | Per-order candidates, exclusions, applied change IDs, selected destination, and submission status |
| `model-attempts.jsonl` | Model attempts, response status, extracted text, and validation errors; no credentials or request headers |
| `run-log.jsonl` | Simulator record of orders submitted and their destinations |
| `deliveries.jsonl` | Simulator record of event delivery status, duration, and errors |
| `report.json` | Automated run comparison: matches, mismatches, missing/unexpected/duplicate orders, and delivery errors |
| `preflight-model-attempts.jsonl` | Model preflight diagnostics in the first automated run |

Each replay session also has `summary.json`; `out/verification/summary.json` contains the latest summary and session path. Standalone model checks write `out/diagnostics/model-preflight.jsonl`. Failed replays preserve reports and available logs. `AUDIT_DIR` overrides the application's output directory; `out/` is ignored by Git.

## Scope and judgment

The core is complete, with the required `core done` commit. The scope stops at the service, review list, and audit trail. UI, approval actions, reply drafts, model comparisons, and restart recovery were deferred to keep the routing core reviewable.

Ambiguous rules have explicit conventions: “until Wednesday” ends at Wednesday 00:00 Eastern, temporary overrides expire back to earlier valid rules, and ops may update explicitly identified pharmacy facts. Unsupported time expressions go to review. Trusted safety uncertainty holds only the affected scope when identifiable; an unexplained whole-pharmacy hold requires investigation. These choices and their boundaries are detailed in [the design](architecture.md).

An unknown pharmacy submission is never retried or rerouted; its capacity reservation remains. The API has no status query, so recovery cannot safely be automated. Before production, add durable state, authenticated senders/webhooks, remote idempotency and reconciliation, operator approval, and monitoring.

AI assisted design, implementation, and test development. One rejected suggestion was to reject a whole email atomically: that could discard a valid closure alongside an unauthorized instruction. The final design validates independent groups separately and keeps dependent corrections atomic. The [AI-assisted design review](architecture.md#ai-assisted-design-review) records this and the integration decisions that followed real testing.
