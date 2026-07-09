# Write-Outcome Confirmation Phrasing Implementation Plan

> **For agentic workers:** Follow this plan task-by-task, in order. If a
> quoted anchor isn't found exactly, stop and write `PLAN_NOTES.md` in the
> repo root explaining the mismatch — do not guess or reinterpret. If you
> hit a decision this plan doesn't cover, stop and ask — do not improvise.

**Goal:** After a `propose_write` is confirmed or rejected, the agent's
next reply states the outcome as settled fact instead of hedging ("it
looks like the system committed it right away!").

**Architecture:** Two independent, additive changes to the existing
propose-write/confirm flow: (1) the tool-result payload sent back to the
LLM after a `write_outcome` now echoes the actual write body instead of a
bare `{outcome, error}` pair, so the model has concrete facts to report;
(2) the system prompt gets an explicit instruction on how to phrase
committed vs. rejected outcomes, since today it only says not to assume
success early and gives no guidance once the outcome is known.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), no new
dependencies.

## Global Constraints

- Zero shard-db runtime dependency (per this repo's design spec) — these
  changes touch only `src/state.ts` and `src/prompt.ts`, no wire-protocol
  code.
- Build/test commands for this repo: `bun install`; `bun test`; `bun run
  typecheck`.
- Branch off `main`: `git checkout -b fix/write-outcome-confirmation-phrasing`.
- Do tasks in order; each task ends with its own local commit (this
  repo's standing execution exception — do not push, do not open a PR).
- Co-author lines: this plan was written/reviewed by Claude Sonnet 5.
  Confirm the executing model's exact name/version with the human before
  writing the second `Co-Authored-By:` line on each commit — never guess
  it from context.
- Do not touch `examples/README.md`, `examples/landscaping.ts`, or
  `examples/tcp-client.ts` — those have unrelated uncommitted changes
  from prior work already sitting in the working tree. Leave them as-is.

---

### Task 1: Echo the write body in the write_outcome tool-result payload

**Files:**
- Modify: `src/state.ts:92-96`
- Test: `test/state.test.ts:85-98` (update existing assertion)
- Test: `test/agent.test.ts:342` (update existing assertion)

**Interfaces:**
- Consumes: `PendingWrite.body: WriteQuery` (`src/state.ts:8`, already
  stored per pending write — no new field needed).
- Produces: the tool-result JSON content for a resolved `write_outcome`
  input gains a third key, `write`, holding the original `WriteQuery`
  body. Shape becomes `{"outcome":"committed"|"rejected","error":string|null,"write":<WriteQuery>}`.
  Any code reading this tool-result content (there is none elsewhere in
  this repo today — only the LLM reads it) must tolerate the extra key.

- [ ] **Step 1: Update the existing state.ts test to expect the enriched payload (failing first)**

Open `test/state.test.ts`. Find this exact block (currently lines 85-98):

```typescript
  test('applyTurnInputs resolves write_outcome against pendingWrites and removes the entry', () => {
    const data = createInitialSessionData(materialsSchema);
    data.pendingWrites['p1'] = {
      toolCallId: 'call_write_1',
      body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: {} },
    };

    applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'p1', outcome: 'committed' }]);

    expect(data.pendingWrites['p1']).toBeUndefined();
    expect(data.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_write_1', content: JSON.stringify({ outcome: 'committed', error: null }) },
    ]);
  });
```

Replace it with:

```typescript
  test('applyTurnInputs resolves write_outcome against pendingWrites and removes the entry', () => {
    const data = createInitialSessionData(materialsSchema);
    const writeBody = { mode: 'insert' as const, dir: 'landscaping', object: 'line_items', value: {} };
    data.pendingWrites['p1'] = {
      toolCallId: 'call_write_1',
      body: writeBody,
    };

    applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'p1', outcome: 'committed' }]);

    expect(data.pendingWrites['p1']).toBeUndefined();
    expect(data.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_write_1',
        content: JSON.stringify({ outcome: 'committed', error: null, write: writeBody }),
      },
    ]);
  });

  test('applyTurnInputs echoes the write body on a rejected outcome too', () => {
    const data = createInitialSessionData(materialsSchema);
    const writeBody = { mode: 'delete' as const, dir: 'landscaping', object: 'line_items', key: 'li_1' };
    data.pendingWrites['p2'] = {
      toolCallId: 'call_write_2',
      body: writeBody,
    };

    applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'p2', outcome: 'rejected' }]);

    expect(data.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_write_2',
        content: JSON.stringify({ outcome: 'rejected', error: null, write: writeBody }),
      },
    ]);
  });
```

- [ ] **Step 2: Run the state tests and confirm they fail**

Run: `bun test test/state.test.ts`
Expected: FAIL — both new/updated assertions mismatch because the actual
content is still `{"outcome":"committed","error":null}` (no `write` key).

- [ ] **Step 3: Update `src/state.ts` to include the write body**

Find this exact block in `src/state.ts` (currently lines 92-96):

```typescript
    delete data.pendingWrites[input.pendingId];
    data.messages.push({
      role: 'tool',
      tool_call_id: pending.toolCallId,
      content: JSON.stringify({ outcome: input.outcome, error: input.error ?? null }),
    });
```

Replace it with:

```typescript
    delete data.pendingWrites[input.pendingId];
    data.messages.push({
      role: 'tool',
      tool_call_id: pending.toolCallId,
      content: JSON.stringify({ outcome: input.outcome, error: input.error ?? null, write: pending.body }),
    });
```

- [ ] **Step 4: Run the state tests and confirm they pass**

Run: `bun test test/state.test.ts`
Expected: PASS (all tests in the file, including the two above).

- [ ] **Step 5: Fix the now-broken agent-level test**

`test/agent.test.ts` has its own hardcoded assertion of the old payload
shape, in the test `'write_outcome turnInput is folded into the next
turn and clears the pending write'`. Find this exact line (currently
line 342):

```typescript
    expect(toolMessage?.content).toBe(JSON.stringify({ outcome: 'committed', error: null }));
```

Replace it with (using `proposed.body`, the actual `WriteQuery` the agent
proposed earlier in this same test, instead of hand-duplicating it — the
insert mode mints a random key via `mintKey()`, so a literal copy would
not match):

```typescript
    expect(toolMessage?.content).toBe(JSON.stringify({ outcome: 'committed', error: null, write: proposed.body }));
```

- [ ] **Step 6: Run the full suite and confirm everything passes**

Run: `bun test`
Expected: PASS — no failures anywhere (this also catches any other spot
that assumed the old two-key payload shape).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/state.ts test/state.test.ts test/agent.test.ts
git commit -m "$(cat <<'EOF'
fix: echo write body in write_outcome tool-result payload

The LLM previously saw only {"outcome":"committed","error":null} after
a confirmed/rejected write, with no record of what was actually
written. That left it guessing at specifics in its next reply. Echoing
the original WriteQuery body gives it concrete facts to report from.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

### Task 2: Instruct the model to state outcomes as settled fact, not hedge

**Files:**
- Modify: `src/prompt.ts:14-19`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: nothing new — `buildSystemPrompt(schemas)` keeps its existing
  signature.
- Produces: nothing new is exported; this only changes the string content
  `buildSystemPrompt` returns.

- [ ] **Step 1: Write the failing prompt tests**

Open `test/prompt.test.ts`. Find this exact block (the last test in the
file, currently lines 39-41):

```typescript
  test('always includes the confirm-before-write rule', () => {
    expect(buildSystemPrompt({})).toContain('propose_write');
  });
});
```

Replace it with:

```typescript
  test('always includes the confirm-before-write rule', () => {
    expect(buildSystemPrompt({})).toContain('propose_write');
  });

  test('instructs the model to state a committed write as settled fact, not hedge', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('outcome "committed"');
    expect(prompt).toContain('never hedge');
  });

  test('instructs the model on how to respond to a rejected write', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('outcome "rejected"');
    expect(prompt).toContain('write was cancelled');
  });
});
```

- [ ] **Step 2: Run the prompt tests and confirm the two new ones fail**

Run: `bun test test/prompt.test.ts`
Expected: FAIL on the two new tests — today's prompt text contains
neither `outcome "committed"` nor `outcome "rejected"`.

- [ ] **Step 3: Add the phrasing rule to the system prompt**

Find this exact block in `src/prompt.ts` (currently lines 14-19):

```typescript
Rules:
- Only reference fields that are listed for an object below; never invent a field name.
- If an object you need is not listed below, call describe_object for it before reading or writing it.
- For any insert, update, or delete, call propose_write. Never assume a write has happened until you are told its outcome.
- If you are missing information needed to answer or to propose a write, ask a clarifying question in plain text instead of guessing.
- Prefer the fewest tool calls that answer the request.
```

Replace it with:

```typescript
Rules:
- Only reference fields that are listed for an object below; never invent a field name.
- If an object you need is not listed below, call describe_object for it before reading or writing it.
- For any insert, update, or delete, call propose_write. Never assume a write has happened until you are told its outcome.
- Once a tool result reports outcome "committed", state the write as done — a completed, certain fact; never hedge with phrases like "it looks like" or "I think". If a tool result reports outcome "rejected", tell the user the write was cancelled and ask how they would like to proceed.
- If you are missing information needed to answer or to propose a write, ask a clarifying question in plain text instead of guessing.
- Prefer the fewest tool calls that answer the request.
```

- [ ] **Step 4: Run the prompt tests and confirm they pass**

Run: `bun test test/prompt.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test`
Expected: PASS — no failures anywhere.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts test/prompt.test.ts
git commit -m "$(cat <<'EOF'
fix: instruct the model to state write outcomes as settled fact

The system prompt told the model not to assume a write succeeded before
seeing its outcome, but gave no guidance for how to phrase things once
the outcome did arrive. Observed effect: the model hedged ("it looks
like the system committed it right away!") instead of stating a
confirmed write as fact. Add explicit phrasing rules for both the
committed and rejected cases.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

## Manual verification (optional, after both tasks)

If you want to see the effect end-to-end rather than just via unit
tests, rerun the interactive example (`bun run example`, per
`package.json`) against a running shard-db instance, propose a write,
confirm it, and check that the agent's next reply states the write as
done without hedging language.
