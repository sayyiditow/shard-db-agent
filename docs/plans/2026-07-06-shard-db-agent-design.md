# shard-db-agent — design spec

**Status: DESIGN COMPLETE.** Ready for user review, then transition to an implementation plan.

## Motivation

shard-db-agent gives any shard-db consumer app natural-language access to their data — describe what you want in plain English (typed or transcribed from speech), get back a proposed query or write instead of hand-writing JSON or NQL. It's a schema-agnostic, stateful conversational agent: it holds conversation state across turns, asks clarifying questions when information is missing, and always proposes writes for explicit confirmation rather than executing them silently.

It's positioned as a shard-db ecosystem companion, not a feature baked into any one app — the same relationship `shard-cli` has to the daemon (separate thing, usable by any shard-db consumer).

## Decisions made (in order)

1. **Schema-agnostic, not domain-specific.** The module works with any shard-db object via `describe-object`, not hardcoded knowledge of any particular data shape. Domain logic belongs in the app layer, not this module.

2. **Text-in only.** The module accepts English text, not audio. Speech-to-text (Whisper, browser Web Speech API, etc.) is the host app's concern, called before handing text to this module.

3. **Stateful conversational agent, not a one-shot translator.** Real usage requires holding conversation state across many turns (building something up incrementally, asking clarifying questions, catching missing info) — a stateless "sentence in → query out" translator would be a much worse building block underneath that experience.

4. **Local, self-hosted LLM — not a hosted API (Claude/OpenAI/etc).** Everything runs locally. Recommended: a mid-size open model (Qwen family, ~14B class) rather than the smallest variants — small models handle grammar-constrained JSON generation fine, but the harder "agentic judgment" (when to ask a clarifying question, proactively noticing what's missing) needs more parameters.

5. **Confirm-before-write.** The agent never silently commits a write — it always proposes and requires explicit confirmation before anything is persisted.

6. **Positioning: a shard-db ecosystem companion, not an app-specific feature.** Usable by any shard-db consumer app that wants natural-language access instead of hand-writing JSON/NQL.

7. **Zero hard shard-db dependency in the core library.** The agent does **not** hold its own `IShardDbClient`, does not care about embedded vs TCP, and — critically — **never executes anything against shard-db itself**, reads or writes. Its only job is to consume (English text + schema description + conversation state + optionally prior query results/write outcomes) and produce (more queries to run, a final answer, or a proposed write). The calling app executes everything, on whatever transport it already uses. This holds for the library's runtime dependencies *and* its test suite (see Testing).

    If a host app is a PWA backed by shard-db in **embedded mode**, note that embedded mode runs server-side only (native library linked into the Bun/Node process via napi) — it can't run inside the browser sandbox. A PWA host is the installable/offline-capable UI shell, while shard-db itself lives on the one server process the PWA talks to when online. True offline writes (queueing writes with zero connectivity, syncing later) require a separate client-side store (e.g. IndexedDB) with its own sync-back logic — this module has no opinion on that, it's a host-app concern.

8. **Optional `executor` callback for reads only.** To reduce round-trip pain for hosts who don't mind it: an optional plain function `(query: QueryBody) => Promise<result>` can be passed in; if present, the agent auto-runs *read* tool calls (`find`/`count`/`aggregate`/`describe-object`) internally instead of stopping to ask the app. **Writes are never affected by this — `proposed_write` always surfaces regardless of executor config, no exceptions.**

9. **Confirmation is bookkeeping, not execution.** There is no `agent.confirm()` method that runs the write. The app executes the write itself (its own connection), then tells the agent the outcome (committed/rejected) so the agent's session memory stays accurate for follow-up turns in the same conversation.

10. **Naming: `shard-db-agent`** (not `shard-agent`, not `shard-db-nl`, not anything with "ai" in it). "nl" collides with the existing NQL grammar name; "ai" is vague marketing-speak inconsistent with the project's plain naming style (`shard-db`, `shard-cli`, `NQL`). "agent" precisely describes the mechanism (stateful, tool-use).

11. **Why not write it in C:** considered and rejected. The bottleneck is LLM token generation (already C++/CUDA under llama.cpp/vLLM) and network round-trips — not this orchestration layer, which is pure I/O-bound glue. Build the glue in Bun/TypeScript.

12. **Write validation happens inside the library, before `proposed_write` is ever returned.** The agent already holds the `describe-object` schema (from turn 1 or the executor). Before emitting a `proposed_write`, it self-checks the payload's fields/types against that schema; malformed proposals never reach the host. Hosts still apply their own normal write-path safety (auth, CAS) — they don't need agent-specific validation code on top.

    *Considered and rejected: using shard-db's real `dry_run`.* shard-db supports `dry_run` for single-record `update`/`delete` and for criteria-driven `bulk-update`/`bulk-delete`, but **not** for single-record `insert` ("single-record CAS writes always execute — the check is the atomic part, not a preview," per `docs/cas.md`) — which is the most common `proposed_write` shape (adding a new record). Since insert can never get this extra check, and extending the executor to run writes-as-preview would break the clean "executor is reads-only" contract (decision 8) for an inconsistent benefit, schema self-validation stays the single, uniform path for all write kinds (insert/update/delete alike). The `if_not_exists` CAS guard at execute time (decision 13) already covers the staleness/duplicate case dry_run would otherwise help with.

13. **For insert-shaped writes, the key is agent-generated, derived from `pendingId`.** The agent mints a deterministic key (e.g. UUID) once, when the `proposed_write` is first created, and stores it in `state`. Every retry of the same `pendingId` (double-confirm, network retry) carries the identical key, so the host's insert with `if_not_exists` naturally no-ops on a duplicate — no extra coordination needed on the host side. This decision is scoped to `insert`: `update`/`delete` proposals target an *existing* record's key (not agent-minted) and don't need the same mechanism — re-applying the same absolute-value `update` or the same `delete` twice is already a no-op/harmless, so no extra idempotency handling is required for those kinds.

14. **Latency budget: ~5-10s per turn is acceptable; CPU-only hosting stays on the table.** This is a walkie-talkie cadence (speak, wait, hear response), not fluid real-time conversation. Keeps the GPU-vs-CPU hosting decision open pending real-world feedback rather than committing to GPU cost upfront.

15. **No distinct "clarify" result kind.** A clarifying question from the agent ("what's the wall height?") comes back as `kind: 'answer'`, same as any other text response — the app's handling is identical either way (show text, wait for next input), so a 4th kind would be a label with no behavioral difference.

16. **Session store: recommended pattern is a shard-db object, but the library stays storage-agnostic.** Since every host already has a shard-db connection, the natural default is a `sessions` object (e.g. `dir:agent`, `object:sessions`, `key: session_id`, `value: {state_blob, updated_at}`) — free persistence, survives restarts, no new infra. This is documented as the recommended pattern for host apps; the library itself only ever sees `state` as an opaque string in/out and has no opinion on how it's stored.

## Architecture

```
  app (embedded OR TCP shard-db — agent doesn't care)      shard-db-agent (library)        local LLM
        │ turn(state, text, schema, [turnInputs])                 │                     (Qwen, OpenAI-compat
        ├──────────────────────────────────────────────────────►│◄───────────────────►  endpoint — llama.cpp
        │                                                         │  tool-use loop        server / vLLM, or
        │ ◄── query_request[] | answer | proposed_write ─────────┤                     in-process via
        │                                                         │                     node-llama-cpp)
        │ (if query_request: app runs the query itself, on its
        │  own db connection, then calls turn() again with the
        │  results — OR this round-trip is skipped for reads if
        │  an optional `executor` callback was configured)
        │
        │ app executes any confirmed write itself, then informs
        │ the agent of the outcome via turnInputs so session
        │ memory stays accurate
```

### Components

- **Core turn loop** — `agent.turn(state: SessionState | null, text: string | null, schema?: ObjectSchema, turnInputs?: TurnInput[]) → AgentTurnResult`, where:
  ```ts
  type SessionState = string; // opaque to callers — treat as a blob, never parse it

  type AgentTurnResult =
    | { kind: 'query_request'; queries: { id: string; query: QueryBody }[]; state: SessionState }
    | { kind: 'answer'; text: string; state: SessionState }
    | { kind: 'proposed_write'; body: QueryBody; summary: string; pendingId: string; state: SessionState };

  type TurnInput =
    | { kind: 'query_result'; id: string; data: unknown }
    | { kind: 'write_outcome'; pendingId: string; outcome: 'committed' | 'rejected'; error?: string };
  ```
  `state` is `null` only on the very first call of a brand-new session (nothing to resume yet); every call after that passes back whatever `state` the previous `AgentTurnResult` returned. `text` is `string | null` — a real human utterance on turns where the user spoke, or `null` on turns that exist purely to deliver `turnInputs` (e.g. handing back query results or a write outcome with no new speech, as in step 5 of the data-flow example below). `schema` (the `describe-object` output) is only required on the *first* turn of a session; the agent folds it into `state` for subsequent turns. `turnInputs` is a single discriminated-union channel carrying everything that happened since the last turn — query results the app fetched, and/or the outcome of a previously confirmed write — mirroring the discriminated-union style already used for `AgentTurnResult`.

- **`query_request` / `proposed_write` contract** — reads (`find`/`count`/`aggregate`/`describe-object`) come back as `query_request`, batchable (an array, mirroring parallel tool-use). Writes always come back as `proposed_write` (pre-validated against schema per decision 12) and are never auto-executed regardless of executor config.

- **`query.query` is literally the app's existing `QueryBody` type** — the same type any shard-db client's `.query()` method already accepts. Zero translation/dispatch glue needed on the app side beyond `shardDb.query(q.query)`.

- **Optional `executor` callback** — `(query: QueryBody) => Promise<result>`. If supplied, the agent auto-runs read tool calls (including `describe-object`) and skips the round-trip for those. Writes are unaffected. If the executor throws, the exception propagates unchanged out of `agent.turn()` (see Error handling).

- **Write acknowledgment** — after the app executes a confirmed write, it informs the agent via `turnInputs: [{ kind: 'write_outcome', pendingId, outcome, error? }]` on the next `turn()` call.

- **`bin/serve`** — optional thin HTTP wrapper in the same repo, for non-JS/Bun consumers or hosts who want the agent decoupled from their own process. Instantiates the same core library, exposes `POST /turn` / equivalent. Whether it auto-executes reads depends on whether it's configured with its own shard-db connection (opt-in via config).

- **Prompt/schema layer** — renders whatever schema description is available into the system prompt so the LLM has ground truth for valid fields/operators on whatever object it's working against.

- **LLM client seam** — the library takes an LLM client (object/function) as a constructor param, defaulting to a real OpenAI-compat HTTP client. This is both the production configuration point (pointing at a local llama.cpp/vLLM endpoint) and the test seam (see Testing).

## Concrete data flow example (landscaping estimate)

1. User (voice→text via app's own STT): *"I'm at the Simmons property, they want a block retaining wall, about 40 feet long, 3 feet high."*
2. App calls `agent.turn(state, text, schema)` (schema only needed this first time).
3. Agent needs a unit price before it can size the line item. Returns:
   ```json
   { "kind": "query_request",
     "queries": [{ "id": "q1", "query": { "mode": "find", "dir": "landscaping", "object": "materials",
                    "criteria": { "category": "retaining_wall_block" } } }],
     "state": "<opaque>" }
   ```
4. App runs `q1` on its own connection, gets `[{ "name": "Versa-Lok Standard", "unit_price": 6.85, "unit": "sqft" }]`.
5. App calls `agent.turn(state, null, undefined, [{ "kind": "query_result", "id": "q1", "data": [...] }])`.
6. Agent computes 40×3 = 120 sqft × $6.85 = $822, mints a deterministic key from a new `pendingId`, self-validates the payload against the `line_items` schema, and returns:
   ```json
   { "kind": "proposed_write",
     "body": { "mode": "insert", "dir": "landscaping", "object": "line_items", "key": "<agent-minted-uuid>",
               "value": { "estimate_id": 1042, "description": "Block retaining wall",
               "qty": 120, "unit": "sqft", "unit_price": 6.85, "total": 822.00 } },
     "summary": "Add: Block retaining wall, 120 sqft @ $6.85 = $822.00 to Simmons estimate #1042. Confirm?",
     "pendingId": "p1", "state": "<opaque>" }
   ```
7. App shows/speaks the summary; user confirms.
8. App executes the insert itself, on its own connection, using `if_not_exists` with the agent-provided key — safe against duplicate confirms/retries.
9. App calls `agent.turn(state, null, undefined, [{ "kind": "write_outcome", "pendingId": "p1", "outcome": "committed" }])` so later turns in the same conversation (e.g. "also add the excavation for that same wall") have accurate memory of what's actually been persisted.

## Error handling

All failure modes surface as **thrown errors** out of `agent.turn()`, not as a result kind — keeping the `AgentTurnResult` union limited to the three success cases and matching normal async JS/TS error-handling idioms. On any throw, session `state` is left untouched (as if the failed turn never happened), so the simplest recovery is always "app catches it, shows a retry affordance, user re-speaks or the app re-issues the same call."

- **LLM failure** (timeout, crash, or tool-use output the parser can't handle): `turn()` throws. No internal retry — the app decides whether/how to retry.
- **Executor failure** (host's `executor` callback throws while the agent is auto-running a read): the exception propagates unchanged out of `turn()`, same handling path as an LLM failure. One error pattern for the whole library, not a special recovery loop.
- **Corrupted/invalid state blob** (app hands back a blob that fails to deserialize — truncated, tampered, wrong version): `turn()` throws a **distinct error type** (e.g. `InvalidStateError`), separate from LLM/executor failures. This lets the app tell "retry the sentence" apart from "the session is unrecoverable, start a fresh one (re-supply schema)" — retrying with the same broken blob would otherwise loop forever.

## Testing

Consistent with decision 7 (zero shard-db dependency), the agent's own test suite has **no shard-db dependency anywhere** — runtime or test-time.

- **Unit tests (turn-loop state machine)** — the LLM client is injected (constructor param, defaults to the real HTTP client per the "LLM client seam" above). Tests supply a fake client that returns scripted tool-use responses, giving fully deterministic coverage of state transitions, the `query_request`/`answer`/`proposed_write` branching, and `turnInputs` handling (query results, write outcomes) — no network or model required.
- **Eval harness (translation accuracy)** — a fixed set of realistic conversation fixtures, each turn annotated with the expected `AgentTurnResult` (query shape or write payload). Scoring is **exact structural match** against actual output (ignoring generated IDs like `pendingId`/minted keys). Deterministic, no extra LLM judge cost. Lives in-repo (e.g. `eval/fixtures/*.json`) and runs via an explicit script (`bun run eval`) against a live local LLM endpoint — **not** part of normal CI (CI has no GPU/model to run against). Run manually when swapping models/quantizations or before releases, to compare accuracy objectively and catch regressions.
- **No execute-against-real-shard-db layer.** Verifying that a fixture's expected query is actually valid against a real schema (dir/object/field names that exist) is intentionally left to the *consuming app's* own test suite, not the agent repo — adding even a throwaway embedded shard-db as a devDependency here would blur the zero-dependency boundary the whole design is built around. Fixture staleness (schema drift) is a fixture-maintenance concern caught when a host integrates and fixtures fail to reflect its real schema, not something the agent library needs to self-verify.

## Next steps

- [x] Error handling section
- [x] Testing section
- [x] Resolve all open gaps
- [x] Spec self-review (placeholder scan, internal consistency, scope check, ambiguity check)
- [ ] User review of this spec
- [ ] Create the `shard-db-agent` GitHub repo (public), push this doc, commit
- [ ] Transition to `writing-plans` skill for the task-by-task implementation plan
