# List-Objects Tool Implementation Plan

> **For agentic workers:** Follow this plan task-by-task, in order. If a
> quoted anchor isn't found exactly, stop and write `PLAN_NOTES.md` in the
> repo root explaining the mismatch — do not guess or reinterpret. If you
> hit a decision this plan doesn't cover, stop and ask — do not improvise.

**Goal:** Give the agent a way to discover an object's real name when the
user's wording doesn't match anything it already knows, by wiring up
shard-db's `list-objects` mode (`{"mode":"list-objects","dir":"<dir>"}` →
`["customers","invoices",...]`, per
`docs/query-protocol/diagnostics.md` in the shard-db repo) as a new read
tool, called only as a fallback.

**Architecture:** This follows the exact same pattern already used for
`find_records` / `count_records` / `aggregate_records` / `describe_object`:
a new `ReadQuery` variant (`ListObjectsQuery`), a new `LlmToolDef`
(`list_objects`), a `toolCallToReadQuery` branch, and a system-prompt rule
telling the model when to reach for it. No new concepts, no changes to
`Agent.turn()`'s control flow — a `list_objects` call is just another
read tool call that flows through the existing `executor` /
`query_request` paths unchanged, since neither path special-cases read
modes except `describe-object` (for schema caching), and `list-objects`
doesn't need caching.

**Tech Stack:** TypeScript, Bun test runner (`bun:test`), no new
dependencies.

## Global Constraints

- Zero shard-db runtime dependency (per this repo's design spec) — this
  only adds a client-side type/tool/prompt-rule; it does not talk to
  shard-db directly.
- Build/test commands for this repo: `bun install`; `bun test`; `bun run
  typecheck`.
- Branch off `main`: `git checkout -b feat/list-objects-tool`.
- Do tasks in order; each task ends with its own local commit (this
  repo's standing execution exception — do not push, do not open a PR).
- Co-author lines: this plan was written/reviewed by Claude Sonnet 5.
  Confirm the executing model's exact name/version with the human before
  writing the second `Co-Authored-By:` line on each commit — never guess
  it from context.
- Do not touch `examples/README.md`, `examples/landscaping.ts`, or
  `examples/tcp-client.ts` — those have unrelated uncommitted changes
  from prior work already sitting in the working tree. Leave them as-is.
- **Out of scope for this plan:** any per-`dir` authorization/allowlist
  enforcement. Cross-tenant isolation is an application + shard-db
  token-scoping concern (shard-db already supports per-`dir`
  `tokens.conf` entries), not something this library should reimplement —
  the human explicitly decided this stays out of the agent library for
  now. Do not add an `allowedDirs` option or any `dir` validation as part
  of this work.

---

### Task 1: Add `ListObjectsQuery` to the `ReadQuery` union

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ListObjectsQuery { mode: 'list-objects'; dir: string }`,
  added to the `ReadQuery` union and recognized by `isReadQuery`. Task 2
  and Task 4 depend on this type existing and being exported from
  `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Open `test/types.test.ts`. Find this exact block (currently lines 5-15):

```typescript
  test('find/count/aggregate/describe-object are read queries', () => {
    const find: QueryBody = { mode: 'find', dir: 'd', object: 'o', criteria: [] };
    const count: QueryBody = { mode: 'count', dir: 'd', object: 'o', criteria: [] };
    const agg: QueryBody = { mode: 'aggregate', dir: 'd', object: 'o', aggregates: [{ fn: 'count', alias: 'n' }] };
    const desc: QueryBody = { mode: 'describe-object', dir: 'd', object: 'o' };

    for (const q of [find, count, agg, desc]) {
      expect(isReadQuery(q)).toBe(true);
      expect(isWriteQuery(q)).toBe(false);
    }
  });
```

Replace it with:

```typescript
  test('find/count/aggregate/describe-object/list-objects are read queries', () => {
    const find: QueryBody = { mode: 'find', dir: 'd', object: 'o', criteria: [] };
    const count: QueryBody = { mode: 'count', dir: 'd', object: 'o', criteria: [] };
    const agg: QueryBody = { mode: 'aggregate', dir: 'd', object: 'o', aggregates: [{ fn: 'count', alias: 'n' }] };
    const desc: QueryBody = { mode: 'describe-object', dir: 'd', object: 'o' };
    const list: QueryBody = { mode: 'list-objects', dir: 'd' };

    for (const q of [find, count, agg, desc, list]) {
      expect(isReadQuery(q)).toBe(true);
      expect(isWriteQuery(q)).toBe(false);
    }
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/types.test.ts`
Expected: FAIL — `isReadQuery(list)` returns `false` because `'list-objects'`
isn't recognized yet.

- [ ] **Step 3: Add the `ListObjectsQuery` type**

Find this exact block in `src/types.ts` (currently lines 70-76):

```typescript
export interface DescribeObjectQuery {
  mode: 'describe-object';
  dir: string;
  object: string;
}

export type ReadQuery = FindQuery | CountQuery | AggregateQuery | DescribeObjectQuery;
```

Replace it with:

```typescript
export interface DescribeObjectQuery {
  mode: 'describe-object';
  dir: string;
  object: string;
}

export interface ListObjectsQuery {
  mode: 'list-objects';
  dir: string;
}

export type ReadQuery = FindQuery | CountQuery | AggregateQuery | DescribeObjectQuery | ListObjectsQuery;
```

- [ ] **Step 4: Update `isReadQuery`**

Find this exact block in `src/types.ts` (currently lines 108-110):

```typescript
export function isReadQuery(q: QueryBody): q is ReadQuery {
  return q.mode === 'find' || q.mode === 'count' || q.mode === 'aggregate' || q.mode === 'describe-object';
}
```

Replace it with:

```typescript
export function isReadQuery(q: QueryBody): q is ReadQuery {
  return (
    q.mode === 'find' ||
    q.mode === 'count' ||
    q.mode === 'aggregate' ||
    q.mode === 'describe-object' ||
    q.mode === 'list-objects'
  );
}
```

- [ ] **Step 5: Export the new type from `src/index.ts`**

Find this exact line in `src/index.ts` (currently line 11):

```typescript
  DescribeObjectQuery,
```

Replace it with:

```typescript
  DescribeObjectQuery,
  ListObjectsQuery,
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `bun test test/types.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck**

Run: `bun test`
Expected: PASS.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/index.ts test/types.test.ts
git commit -m "$(cat <<'EOF'
feat: add ListObjectsQuery to the read-query union

Groundwork for a list_objects tool: lets the agent enumerate an
object's real names within a dir (mirrors shard-db's
{"mode":"list-objects","dir":"..."} protocol) instead of only being
able to look up an object it's already been told the exact name of.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

### Task 2: Add the `list_objects` tool definition and wire it into `toolCallToReadQuery`

**Files:**
- Modify: `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `ListObjectsQuery` from `src/types.ts` (Task 1).
- Produces: `LIST_OBJECTS_TOOL: LlmToolDef` (name `list_objects`), added to
  `READ_TOOL_DEFS` / `ALL_TOOL_DEFS`. `toolCallToReadQuery` now handles
  the `'list_objects'` function name. Task 4's agent-level tests depend
  on this tool name and its `{mode: 'list-objects', dir}` output shape.

- [ ] **Step 1: Write the failing tests**

Open `test/tools.test.ts`. Find this exact block (currently lines 17-20):

```typescript
  test('ALL_TOOL_DEFS has exactly 5 tools with unique names', () => {
    expect(ALL_TOOL_DEFS).toHaveLength(5);
    const names = new Set(ALL_TOOL_DEFS.map((t) => t.function.name));
    expect(names.size).toBe(5);
  });
```

Replace it with:

```typescript
  test('ALL_TOOL_DEFS has exactly 6 tools with unique names', () => {
    expect(ALL_TOOL_DEFS).toHaveLength(6);
    const names = new Set(ALL_TOOL_DEFS.map((t) => t.function.name));
    expect(names.size).toBe(6);
  });

  test('READ_TOOL_DEFS includes list_objects', () => {
    expect(READ_TOOL_DEFS.some((t) => t.function.name === 'list_objects')).toBe(true);
  });
```

Now find this exact block further down (currently lines 49-53):

```typescript
  test('toolCallToReadQuery maps describe_object to a DescribeObjectQuery', () => {
    const call = toolCall('describe_object', { dir: 'landscaping', object: 'materials' });
    expect(toolCallToReadQuery(call)).toEqual({ mode: 'describe-object', dir: 'landscaping', object: 'materials' });
  });
```

Immediately after it, insert:

```typescript
  test('toolCallToReadQuery maps list_objects to a ListObjectsQuery', () => {
    const call = toolCall('list_objects', { dir: 'landscaping' });
    expect(toolCallToReadQuery(call)).toEqual({ mode: 'list-objects', dir: 'landscaping' });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test test/tools.test.ts`
Expected: FAIL — `ALL_TOOL_DEFS` still has 5 entries, `list_objects` isn't
in `READ_TOOL_DEFS`, and `toolCallToReadQuery` throws
`"list_objects" is not a read tool` for the new test.

- [ ] **Step 3: Add the `LIST_OBJECTS_TOOL` definition**

Find this exact block in `src/tools.ts` (currently lines 85-100):

```typescript
export const DESCRIBE_OBJECT_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'describe_object',
    description:
      "Fetch an object's field schema and indexes. Call this before reading or writing an object you haven't seen yet.",
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
      },
      required: ['dir', 'object'],
    },
  },
};
```

Immediately after it, insert:

```typescript
export const LIST_OBJECTS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'list_objects',
    description:
      "List every object name that exists inside a tenant directory. Only call this when you can't find the object the user means — e.g. describe_object came back with an error, or the name they gave doesn't match anything in the known schemas below — so you can match the closest real name before asking the user to clarify. Don't call it otherwise.",
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
      },
      required: ['dir'],
    },
  },
};
```

- [ ] **Step 4: Add it to `READ_TOOL_DEFS` and import the new type**

Find this exact line in `src/tools.ts` (currently line 2):

```typescript
import type { AggregateQuery, CountQuery, DescribeObjectQuery, FindQuery, ReadQuery, WriteQuery } from './types';
```

Replace it with:

```typescript
import type {
  AggregateQuery,
  CountQuery,
  DescribeObjectQuery,
  FindQuery,
  ListObjectsQuery,
  ReadQuery,
  WriteQuery,
} from './types';
```

Find this exact block (currently lines 138-143):

```typescript
export const READ_TOOL_DEFS: LlmToolDef[] = [
  FIND_RECORDS_TOOL,
  COUNT_RECORDS_TOOL,
  AGGREGATE_RECORDS_TOOL,
  DESCRIBE_OBJECT_TOOL,
];
```

Replace it with:

```typescript
export const READ_TOOL_DEFS: LlmToolDef[] = [
  FIND_RECORDS_TOOL,
  COUNT_RECORDS_TOOL,
  AGGREGATE_RECORDS_TOOL,
  DESCRIBE_OBJECT_TOOL,
  LIST_OBJECTS_TOOL,
];
```

- [ ] **Step 5: Handle `list_objects` in `toolCallToReadQuery`**

Find this exact block in `src/tools.ts` (currently lines 157-171):

```typescript
export function toolCallToReadQuery(call: LlmToolCall): ReadQuery {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  switch (call.function.name) {
    case 'find_records':
      return { mode: 'find', ...(args as object) } as FindQuery;
    case 'count_records':
      return { mode: 'count', ...(args as object) } as CountQuery;
    case 'aggregate_records':
      return { mode: 'aggregate', ...(args as object) } as AggregateQuery;
    case 'describe_object':
      return { mode: 'describe-object', ...(args as object) } as DescribeObjectQuery;
    default:
      throw new Error(`shard-db-agent: "${call.function.name}" is not a read tool`);
  }
}
```

Replace it with:

```typescript
export function toolCallToReadQuery(call: LlmToolCall): ReadQuery {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  switch (call.function.name) {
    case 'find_records':
      return { mode: 'find', ...(args as object) } as FindQuery;
    case 'count_records':
      return { mode: 'count', ...(args as object) } as CountQuery;
    case 'aggregate_records':
      return { mode: 'aggregate', ...(args as object) } as AggregateQuery;
    case 'describe_object':
      return { mode: 'describe-object', ...(args as object) } as DescribeObjectQuery;
    case 'list_objects':
      return { mode: 'list-objects', ...(args as object) } as ListObjectsQuery;
    default:
      throw new Error(`shard-db-agent: "${call.function.name}" is not a read tool`);
  }
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun test test/tools.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Full suite + typecheck**

Run: `bun test`
Expected: PASS.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "$(cat <<'EOF'
feat: add list_objects tool definition

Wires shard-db's list-objects mode up as a 6th tool the model can
call, following the same LlmToolDef + toolCallToReadQuery pattern as
find_records/count_records/aggregate_records/describe_object. The
tool description itself instructs the model to reach for this only as
a fallback, not on every turn — reinforced by a system-prompt rule in
a follow-up commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

### Task 3: Tell the model, in the system prompt, to use `list_objects` only as a fallback

**Files:**
- Modify: `src/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: nothing new — `buildSystemPrompt(schemas)` keeps its existing
  signature.
- Produces: nothing new is exported; this only changes the string content
  `buildSystemPrompt` returns.

- [ ] **Step 1: Write the failing test**

Open `test/prompt.test.ts`. Find this exact block (currently lines 39-42,
the last test in the file):

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

  test('instructs the model to use list_objects only as a fallback when it cannot find the object', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('list_objects');
    expect(prompt).toContain("don't call list_objects otherwise");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/prompt.test.ts`
Expected: FAIL — today's prompt text contains neither `list_objects` nor
`don't call list_objects otherwise`.

- [ ] **Step 3: Add the rule to the system prompt**

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
- If describe_object fails, or the object name the user gave doesn't match anything you know, call list_objects for that dir to see what actually exists and match the closest real name before asking the user — don't call list_objects otherwise, and don't guess a name that describe_object or list_objects hasn't confirmed.
- For any insert, update, or delete, call propose_write. Never assume a write has happened until you are told its outcome.
- If you are missing information needed to answer or to propose a write, ask a clarifying question in plain text instead of guessing.
- Prefer the fewest tool calls that answer the request.
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/prompt.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Full suite + typecheck**

Run: `bun test`
Expected: PASS.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts test/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat: instruct the model to use list_objects only as a fallback

Without explicit guidance the model might reach for list_objects on
every turn instead of only when it's actually stuck on an unknown
object name, burning an extra tool round-trip for no benefit. State
the fallback condition explicitly: try describe_object first, and
only enumerate the dir's objects when that fails or the name doesn't
match anything known.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

### Task 4: Agent-level round-trip tests for `list_objects`

**Files:**
- Modify: `test/agent.test.ts`

**Interfaces:**
- Consumes: `Agent.turn()` (`src/agent.ts`, unchanged by this task),
  `ListObjectsQuery` (Task 1), `list_objects` tool name (Task 2).
- Produces: nothing new — this task is pure test coverage confirming
  `list_objects` flows through `Agent.turn()`'s existing `query_request`
  and `executor` paths exactly like the other read tools, with no special
  handling required (unlike `describe_object`, `list-objects` results are
  a bare string array, not an `ObjectSchema`, so nothing needs caching).

- [ ] **Step 1: Add a `listObjectsToolCall` helper**

Find this exact block in `test/agent.test.ts` (currently lines 40-46):

```typescript
function findToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'find_records', arguments: JSON.stringify(args) } };
}

function writeToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'propose_write', arguments: JSON.stringify(args) } };
}
```

Replace it with:

```typescript
function findToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'find_records', arguments: JSON.stringify(args) } };
}

function listObjectsToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'list_objects', arguments: JSON.stringify(args) } };
}

function writeToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'propose_write', arguments: JSON.stringify(args) } };
}
```

- [ ] **Step 2: Write the failing `query_request` test**

Find this exact block in `test/agent.test.ts` (currently lines 67-98, the
`'a read tool call with no executor returns kind: query_request'` test —
insert the new test immediately after its closing `});`):

```typescript
  test('a read tool call with no executor returns kind: query_request', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          findToolCall('call_1', {
            dir: 'landscaping',
            object: 'materials',
            criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'Price up a block retaining wall', materialsSchema);

    expect(result.kind).toBe('query_request');
    if (result.kind === 'query_request') {
      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toEqual({
        id: 'call_1',
        query: {
          mode: 'find',
          dir: 'landscaping',
          object: 'materials',
          criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
        },
      });
    }
  });
```

Insert this new test directly after it:

```typescript
  test('a list_objects tool call with no executor returns kind: query_request', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [listObjectsToolCall('call_1', { dir: 'landscaping' })],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, "I can't find the widgets object", materialsSchema);

    expect(result.kind).toBe('query_request');
    if (result.kind === 'query_request') {
      expect(result.queries).toHaveLength(1);
      expect(result.queries[0]).toEqual({
        id: 'call_1',
        query: { mode: 'list-objects', dir: 'landscaping' },
      });
    }
  });
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun test test/agent.test.ts`
Expected: FAIL on the new test — `toolCallToReadQuery` doesn't handle
`list_objects` until Task 2 lands. (If Task 2 was already completed
earlier in this branch, this step will instead PASS immediately; if so,
skip to Step 5 and just confirm, don't treat it as an error.)

- [ ] **Step 4: Write the failing executor round-trip test**

Find this exact block in `test/agent.test.ts` (currently lines 229-262,
the `describe_object` caching test — insert the new test immediately
after its closing `});`):

```typescript
  test('with an executor, a describe_object tool call caches the returned schema for later turns', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_d1',
            type: 'function',
            function: {
              name: 'describe_object',
              arguments: JSON.stringify({ dir: 'landscaping', object: 'line_items' }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'line_items has description, qty, unit_price, total.' },
    ]);
    const agent = new Agent({
      llmClient: llm,
      executor: async (query) => {
        if (query.mode === 'describe-object') return lineItemsSchema;
        throw new Error(`unexpected query mode: ${query.mode}`);
      },
    });

    const result = await agent.turn(null, 'What fields does line_items have?', materialsSchema);

    expect(result.kind).toBe('answer');
    const secondCallMessages = llm.callAt(1).messages;
    const systemMessage = secondCallMessages.find((m) => m.role === 'system');
    expect(systemMessage?.content).toContain('landscaping/line_items');
    expect(systemMessage?.content).toContain('description: varchar(80)');
  });
```

Insert this new test directly after it:

```typescript
  test('with an executor, a list_objects tool call round-trips the object-name array back to the model', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [listObjectsToolCall('call_l1', { dir: 'landscaping' })],
      },
      { role: 'assistant', content: 'landscaping has materials and line_items.' },
    ]);
    const agent = new Agent({
      llmClient: llm,
      executor: async (query) => {
        if (query.mode === 'list-objects') return ['line_items', 'materials'];
        throw new Error(`unexpected query mode: ${query.mode}`);
      },
    });

    const result = await agent.turn(null, "I can't find the widgets object, what do we actually have?", materialsSchema);

    expect(result.kind).toBe('answer');
    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.tool_call_id === 'call_l1');
    expect(toolMessage?.content).toBe(JSON.stringify(['line_items', 'materials']));
  });
```

- [ ] **Step 5: Run the full file and confirm everything passes**

Run: `bun test test/agent.test.ts`
Expected: PASS (all tests in the file, including both new ones).

- [ ] **Step 6: Full suite + typecheck**

Run: `bun test`
Expected: PASS — no failures anywhere.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add test/agent.test.ts
git commit -m "$(cat <<'EOF'
test: cover list_objects through Agent.turn()'s read-tool paths

Confirms list_objects needs no special-casing in Agent.turn() —
it flows through the same query_request and executor round-trip
paths as the other read tools, unlike describe_object which caches
its result as a schema.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Co-Authored-By: <CONFIRM WITH HUMAN — do not guess>
EOF
)"
```

---

## Manual verification (optional, after all four tasks)

Rerun the interactive example (`bun run example`, per `package.json`)
against a running shard-db instance, and ask about an object using a
wrong/fuzzy name (e.g. "what do we have in the widgets table?" when the
real object is `materials`). Confirm the agent calls `describe_object`
first, then falls back to `list_objects` for the `dir` and corrects
itself, rather than either guessing a name or immediately asking you to
spell it out.
