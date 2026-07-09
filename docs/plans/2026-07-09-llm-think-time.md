# LLM Think-Time Timing Implementation Plan

> **For agentic workers:** Follow this plan task-by-task, in order. If a
> quoted anchor isn't found exactly, stop and write `PLAN_NOTES.md` in the
> repo root explaining the mismatch — do not guess or reinterpret. If you
> hit a decision this plan doesn't cover, stop and ask — do not improvise.

**Goal:** Every `AgentTurnResult` carries an `llmMs` field: the total
wall-clock time spent waiting on the LLM inside that `turn()` call, summed
across all tool-iteration round trips, and excluding executor/DB time —
so a host app (e.g. the landscaping example) can show "the agent thought
for Nms" without that number being inflated by unrelated DB round-trip
latency.

**Architecture:** `Agent.turn()` already loops calling
`this.llmClient.complete(...)` once per tool-iteration and, when an
executor is configured, calls it synchronously in between LLM calls
within the same loop. Timing only the `complete()` calls and accumulating
into a local `llmMs` total, then attaching that total to whichever of the
three result shapes the loop returns, isolates "the model thinking" from
"the DB responding" with no new abstractions. A test-fixture change
(`FakeLlmClient` gains an optional artificial delay) is needed so the
timing tests have something non-zero and controllable to assert on.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), `performance.now()`
(already available in Bun/Node, no new dependency).

## Global Constraints

- Zero shard-db runtime dependency (per this repo's design spec) — these
  changes touch `src/types.ts`, `src/agent.ts`, `test/fixtures/fake-llm-client.ts`,
  `test/agent.test.ts`, and `examples/landscaping.ts` only. No wire-protocol
  code changes.
- Build/test commands for this repo: `bun install`; `bun test`; `bun run
  typecheck`.
- Branch off `main`: `git checkout -b feat/llm-think-time`.
- Do tasks in order; each task ends with its own local commit (this
  repo's standing execution exception — do not push, do not open a PR).
- Co-author lines: this plan was written/reviewed by Claude Sonnet 5.
  Confirm the executing model's exact name/version with the human before
  writing the second `Co-Authored-By:` line on each commit — never guess
  it.
- `llmMs` is a plain `number` of milliseconds, rounded to the nearest
  integer (`Math.round`) — not a float, not a `bigint`, not a duration
  string.

---

### Task 1: Add `llmMs` to `AgentTurnResult` and measure it in `Agent.turn()`

**Files:**
- Modify: `src/types.ts:155-158`
- Modify: `src/agent.ts:52-123`
- Modify: `test/fixtures/fake-llm-client.ts` (whole file)
- Test: `test/agent.test.ts` (append new tests at end of file)

**Interfaces:**
- Consumes: `LlmClient.complete()` (`src/llm-client.ts`, unchanged
  signature) — only the call sites inside `Agent.turn()`'s loop are timed.
- Produces: `AgentTurnResult` (`src/types.ts`) — all three variants gain
  `llmMs: number`. `FakeLlmClient` (`test/fixtures/fake-llm-client.ts`)
  gains an optional second constructor argument
  `options?: { delayMs?: number }` that makes every scripted `complete()`
  call sleep for `delayMs` before resolving — existing call sites
  (`new FakeLlmClient([...])`, no second argument) are unaffected.

- [ ] **Step 1: Write the failing timing tests in `test/agent.test.ts`**

Find this exact block at the end of the file (currently lines 410-427):

```typescript
  test('exceeding max tool iterations throws', async () => {
    const scripted: LlmMessage[] = Array.from({ length: 3 }, (_, i) => ({
      role: 'assistant' as const,
      content: null,
      tool_calls: [findToolCall(`call_${i}`, { dir: 'landscaping', object: 'materials', criteria: [] })],
    }));
    const llm = new FakeLlmClient(scripted);
    const agent = new Agent({
      llmClient: llm,
      executor: async () => [],
      maxToolIterations: 3,
    });

    await expect(agent.turn(null, 'loop forever', materialsSchema)).rejects.toThrow(
      /exceeded max tool-use iterations/,
    );
  });
});
```

Replace it with:

```typescript
  test('exceeding max tool iterations throws', async () => {
    const scripted: LlmMessage[] = Array.from({ length: 3 }, (_, i) => ({
      role: 'assistant' as const,
      content: null,
      tool_calls: [findToolCall(`call_${i}`, { dir: 'landscaping', object: 'materials', criteria: [] })],
    }));
    const llm = new FakeLlmClient(scripted);
    const agent = new Agent({
      llmClient: llm,
      executor: async () => [],
      maxToolIterations: 3,
    });

    await expect(agent.turn(null, 'loop forever', materialsSchema)).rejects.toThrow(
      /exceeded max tool-use iterations/,
    );
  });

  test('llmMs measures only LLM completion time, not executor time', async () => {
    const llm = new FakeLlmClient(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
        },
        { role: 'assistant', content: 'Versa-Lok is $6.85/sqft.' },
      ],
      { delayMs: 30 },
    );
    const agent = new Agent({
      llmClient: llm,
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [{ name: 'Versa-Lok', unit_price: 6.85 }];
      },
    });

    const result = await agent.turn(null, 'What does Versa-Lok cost?', materialsSchema);

    expect(result.kind).toBe('answer');
    // Two LLM calls each delayed ~30ms -> at least ~55ms of llmMs.
    expect(result.llmMs).toBeGreaterThanOrEqual(55);
    // The 150ms executor delay must not be counted -- well under 30+30+150.
    expect(result.llmMs).toBeLessThan(140);
  });

  test('llmMs is a non-negative number on query_request and proposed_write results too', async () => {
    const llmForQuery = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
    ]);
    const queryAgent = new Agent({ llmClient: llmForQuery });
    const queryResult = await queryAgent.turn(null, 'find stuff', materialsSchema);
    expect(queryResult.kind).toBe('query_request');
    expect(typeof queryResult.llmMs).toBe('number');
    expect(queryResult.llmMs).toBeGreaterThanOrEqual(0);

    const llmForWrite = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w1', {
            summary: 'Add a thing',
            body: {
              mode: 'insert',
              dir: 'landscaping',
              object: 'line_items',
              value: { description: 'x', qty: 1, unit_price: 1, total: 1 },
            },
          }),
        ],
      },
    ]);
    const writeAgent = new Agent({ llmClient: llmForWrite });
    const writeResult = await writeAgent.turn(null, 'add it', lineItemsSchema);
    expect(writeResult.kind).toBe('proposed_write');
    expect(typeof writeResult.llmMs).toBe('number');
    expect(writeResult.llmMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun test test/agent.test.ts`
Expected: FAIL on both new tests — `result.llmMs` / `queryResult.llmMs` /
`writeResult.llmMs` are `undefined` today (the field doesn't exist yet),
and `FakeLlmClient` doesn't accept a second constructor argument yet, so
the `{ delayMs: 30 }` option is silently ignored (no error, but no delay
either), which would make the timing assertion fail too either way.

- [ ] **Step 3: Add the optional delay to `FakeLlmClient`**

Open `test/fixtures/fake-llm-client.ts`. Find this exact content (the
whole file):

```typescript
import type { LlmClient, LlmCompleteParams, LlmMessage } from '../../src/llm-client';

export class FakeLlmClient implements LlmClient {
  private readonly scripted: LlmMessage[];
  private readonly calls: LlmCompleteParams[] = [];
  private cursor = 0;

  constructor(scripted: LlmMessage[]) {
    this.scripted = scripted;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    this.calls.push(params);
    if (this.cursor >= this.scripted.length) {
      throw new Error(`FakeLlmClient: no scripted response left for call #${this.cursor + 1}`);
    }
    return this.scripted[this.cursor++];
  }

  get callCount(): number {
    return this.calls.length;
  }

  callAt(index: number): LlmCompleteParams {
    const call = this.calls[index];
    if (!call) throw new Error(`FakeLlmClient: no call recorded at index ${index}`);
    return call;
  }
}
```

Replace it with:

```typescript
import type { LlmClient, LlmCompleteParams, LlmMessage } from '../../src/llm-client';

export interface FakeLlmClientOptions {
  /** Artificial delay (ms) applied before every scripted complete() call resolves. */
  delayMs?: number;
}

export class FakeLlmClient implements LlmClient {
  private readonly scripted: LlmMessage[];
  private readonly delayMs: number;
  private readonly calls: LlmCompleteParams[] = [];
  private cursor = 0;

  constructor(scripted: LlmMessage[], options: FakeLlmClientOptions = {}) {
    this.scripted = scripted;
    this.delayMs = options.delayMs ?? 0;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    this.calls.push(params);
    if (this.cursor >= this.scripted.length) {
      throw new Error(`FakeLlmClient: no scripted response left for call #${this.cursor + 1}`);
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.scripted[this.cursor++];
  }

  get callCount(): number {
    return this.calls.length;
  }

  callAt(index: number): LlmCompleteParams {
    const call = this.calls[index];
    if (!call) throw new Error(`FakeLlmClient: no call recorded at index ${index}`);
    return call;
  }
}
```

- [ ] **Step 4: Add `llmMs` to `AgentTurnResult`**

Find this exact block in `src/types.ts` (currently lines 155-158):

```typescript
export type AgentTurnResult =
  | { kind: 'query_request'; queries: QueryRequestItem[]; state: SessionState }
  | { kind: 'answer'; text: string; state: SessionState }
  | { kind: 'proposed_write'; body: WriteQuery; summary: string; pendingId: string; state: SessionState };
```

Replace it with:

```typescript
export type AgentTurnResult =
  | { kind: 'query_request'; queries: QueryRequestItem[]; state: SessionState; llmMs: number }
  | { kind: 'answer'; text: string; state: SessionState; llmMs: number }
  | {
      kind: 'proposed_write';
      body: WriteQuery;
      summary: string;
      pendingId: string;
      state: SessionState;
      llmMs: number;
    };
```

- [ ] **Step 5: Instrument `Agent.turn()` to accumulate `llmMs`**

Find this exact block in `src/agent.ts` (currently lines 57-77):

```typescript
  ): Promise<AgentTurnResult> {
    const data = this.loadSessionData(state, schema);

    if (turnInputs && turnInputs.length > 0) {
      applyTurnInputs(data, turnInputs);
    }

    if (text !== null) {
      data.messages.push({ role: 'user', content: text });
    }

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const systemPrompt = buildSystemPrompt(data.schemas);
      const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }, ...data.messages];

      const assistantMessage = await this.llmClient.complete({ messages, tools: ALL_TOOL_DEFS });
      data.messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return { kind: 'answer', text: assistantMessage.content ?? '', state: serializeState(data) };
      }
```

Replace it with:

```typescript
  ): Promise<AgentTurnResult> {
    const data = this.loadSessionData(state, schema);

    if (turnInputs && turnInputs.length > 0) {
      applyTurnInputs(data, turnInputs);
    }

    if (text !== null) {
      data.messages.push({ role: 'user', content: text });
    }

    let llmMs = 0;

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const systemPrompt = buildSystemPrompt(data.schemas);
      const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }, ...data.messages];

      const llmStart = performance.now();
      const assistantMessage = await this.llmClient.complete({ messages, tools: ALL_TOOL_DEFS });
      llmMs += performance.now() - llmStart;
      data.messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return { kind: 'answer', text: assistantMessage.content ?? '', state: serializeState(data), llmMs: Math.round(llmMs) };
      }
```

- [ ] **Step 6: Attach `llmMs` to the remaining two return statements**

Find this exact line in `src/agent.ts` (currently line 97):

```typescript
        return { kind: 'proposed_write', body: finalBody, summary, pendingId, state: serializeState(data) };
```

Replace it with:

```typescript
        return {
          kind: 'proposed_write',
          body: finalBody,
          summary,
          pendingId,
          state: serializeState(data),
          llmMs: Math.round(llmMs),
        };
```

Find this exact line in `src/agent.ts` (currently line 117):

```typescript
      return { kind: 'query_request', queries, state: serializeState(data) };
```

Replace it with:

```typescript
      return { kind: 'query_request', queries, state: serializeState(data), llmMs: Math.round(llmMs) };
```

- [ ] **Step 7: Run the agent tests and confirm they pass**

Run: `bun test test/agent.test.ts`
Expected: PASS — all tests in the file, including the two new ones. Note
the two new timing-sensitive tests use real wall-clock delays (`setTimeout`,
not fake timers); if `llmMs measures only LLM completion time...` is
occasionally flaky on a very slow CI box, that's a sign the thresholds
need loosening (e.g. raise the lower bound tolerance), not that the
feature is wrong — do not delete or weaken the test to hide a real
timing-accumulation bug.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `bun test`
Expected: PASS — no failures anywhere.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/agent.ts test/fixtures/fake-llm-client.ts test/agent.test.ts
git commit -m "$(cat <<'EOF'
feat: add llmMs timing field to AgentTurnResult

Times only the LLM completion calls inside Agent.turn()'s tool-iteration
loop (excluding executor/DB round-trip time) and attaches the summed
total to every result kind, so a host app can show how long the model
itself took to think.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

### Task 2: Display think-time in the interactive example

**Files:**
- Modify: `examples/landscaping.ts:160-211`

**Interfaces:**
- Consumes: `AgentTurnResult.llmMs` (Task 1).
- Produces: nothing new is exported — this only changes console output in
  a standalone example script. No automated test; verified manually per
  this repo's existing precedent for example scripts (see
  `docs/plans/2026-07-09-interactive-example.md`).

- [ ] **Step 1: Print think-time after the first `agent.turn()` call**

Find this exact block in `examples/landscaping.ts` (currently lines
160-167):

```typescript
      const turn = await agent.turn(state, input, schemaValues[0]);

      // Update state
      state = turn.state;

      // Log the result kind for debugging
      if (turn.kind === 'query_request') {
        console.log(`[query_request: ${turn.queries.length} query/ies]`);
      }
```

Replace it with:

```typescript
      const turn = await agent.turn(state, input, schemaValues[0]);

      // Update state
      state = turn.state;

      console.log(`(thought for ${turn.llmMs}ms)`);

      // Log the result kind for debugging
      if (turn.kind === 'query_request') {
        console.log(`[query_request: ${turn.queries.length} query/ies]`);
      }
```

- [ ] **Step 2: Print think-time after the write-outcome follow-up `agent.turn()` call**

Find this exact block in `examples/landscaping.ts` (currently lines
198-205):

```typescript
        // Feed outcome back to agent
        const followUp = await agent.turn(state, null, undefined, [
          { kind: 'write_outcome', pendingId: turn.pendingId, outcome },
        ]);

        state = followUp.state;

        console.log();
```

Replace it with:

```typescript
        // Feed outcome back to agent
        const followUp = await agent.turn(state, null, undefined, [
          { kind: 'write_outcome', pendingId: turn.pendingId, outcome },
        ]);

        state = followUp.state;

        console.log(`(thought for ${followUp.llmMs}ms)`);
        console.log();
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `bun run example` (per `package.json`, requires a running shard-db
instance and a reachable LLM endpoint — see the script's own connection
error message if shard-db isn't up). Send a message, and confirm a line
like `(thought for 842ms)` appears after "Agent is thinking..." and
before the agent's reply. Propose a write, confirm it, and confirm a
second `(thought for ...ms)` line appears after the outcome is fed back.

- [ ] **Step 5: Commit**

```bash
git add examples/landscaping.ts
git commit -m "$(cat <<'EOF'
feat: display LLM think-time in the landscaping example

Surfaces AgentTurnResult.llmMs after each turn so it's visible how much
of the wait was the model thinking vs. DB round-trip time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

## Manual verification (optional, after both tasks)

Compare `llmMs` against a stopwatch estimate of the full turn while
running against the real local Ollama endpoint: with a slow model like
`qwen2.5:14b` on CPU, `llmMs` should account for nearly all of the
perceived "Agent is thinking..." wait, since the example's own DB queries
are fast in comparison — confirming the field is measuring the right
thing in practice, not just in the mocked tests.
