# shard-db-agent Core Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the schema-agnostic `Agent.turn()` state machine and its supporting types, state serialization, LLM client seam, tool/prompt rendering, write validation, and key minting — the core library only, with zero shard-db runtime dependency, per `docs/plans/2026-07-06-shard-db-agent-design.md`.

**Architecture:** A single TypeScript package (`src/`) exposing one public entry point, `Agent`, whose `turn(state, text, schema?, turnInputs?)` method runs a bounded tool-use loop against an injected `LlmClient`. Reads (find/count/aggregate/describe-object) surface to the host as `query_request` unless an `executor` callback is configured, in which case the agent runs them itself and loops. Writes always surface as `proposed_write` after being validated against the target object's schema; the agent never executes a write itself. Session memory is an opaque base64-encoded JSON blob (`SessionState`) round-tripped by the caller.

**Tech Stack:** Bun (>=1.1) + TypeScript (strict, ESM), `bun:test` as the test runner, the `uuid` npm package for deterministic key minting, native `fetch` for the OpenAI-compatible LLM client. No shard-db npm package, no shard-db daemon, no shard-db test binary anywhere in `src/` or `test/`.

## Global Constraints

- Zero shard-db dependency: nothing in `src/` or `test/` may `import` the `shard-db` npm package or spawn/require the shard-db daemon or CLI.
- `SessionState` is always an opaque `string` to callers (base64 of a versioned JSON blob). No internal shape (`SessionData`) is ever exported from `src/index.ts`.
- All failure modes throw. There is no error-result kind on `AgentTurnResult`. `InvalidStateError` is a distinct subclass of `AgentError`, used only for corrupted/unparseable state blobs. `WriteValidationError` is a distinct subclass, used only for a `propose_write` tool call whose body fails schema validation.
- `executor`, when configured, is reads-only (`(query: ReadQuery) => Promise<unknown>`). Writes always surface as `proposed_write` regardless of whether `executor` is configured.
- Deterministic key minting: `mintKey(pendingId)` is a pure function — same `pendingId` always yields the same key. Used only for insert-shaped writes that omit a `key`.
- Test runner is `bun test`; every task ends with `bun test` passing before commit. Do not use `git push` — commit locally per task only.
- `QueryBody` (and its `ReadQuery`/`WriteQuery` split) mirrors shard-db's actual JSON query protocol shapes (`find`, `count`, `aggregate`, `describe-object`, `insert`, `update`, `delete`) exactly, so a host app can pass `query.query` straight into its existing shard-db client with zero translation glue.
- Out of scope for this plan: `bin/serve` (HTTP wrapper), the eval harness, and any real LLM integration test that requires a live model endpoint. These are separate follow-up plans.

---

## Execution Rules

- Branch off `main` before Task 1: `git checkout -b feat/core-library`.
- Do tasks in strict order — later tasks import from earlier ones.
- Every step that runs a command must show the actual output before moving to the next step. Never claim a step passed without pasting the real command output.
- If a quoted anchor (a string this plan tells you to find) is not present verbatim in the target file, stop and write `PLAN_NOTES.md` at the repo root describing exactly what you searched for and what you found instead. Do not guess or reinterpret.
- Commit after each task's final step, locally only (no `git push`).

---

### Task 1: Project scaffolding + core protocol/domain types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Produces: `CriterionOp`, `Criterion`, `CriteriaOr`, `CriteriaAnd`, `CriteriaNode`, `FindQuery`, `CountQuery`, `AggregateSpec`, `AggregateQuery`, `DescribeObjectQuery`, `ReadQuery`, `InsertQuery`, `UpdateQuery`, `DeleteQuery`, `WriteQuery`, `QueryBody`, `isReadQuery(q): q is ReadQuery`, `isWriteQuery(q): q is WriteQuery`, `FieldDescriptor`, `ObjectSchema`, `SessionState` (= `string`), `QueryRequestItem`, `AgentTurnResult`, `TurnInput` — all from `src/types.ts`.

- [ ] **Step 1: Create the project scaffold**

Run:
```bash
ls
```
Expected: shows `README.md` and `docs/` only (confirms no prior scaffold to clobber).

Create `package.json`:
```json
{
  "name": "shard-db-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "typescript": "^5.5.0"
  }
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["@types/bun"]
  },
  "include": ["src", "test"]
}
```

Create `.gitignore`:
```
node_modules/
*.log
```

Run:
```bash
bun install
```
Expected: installs `uuid`, `typescript`, `@types/bun` with no errors.

- [ ] **Step 2: Write the failing test**

Create `test/types.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { isReadQuery, isWriteQuery, type QueryBody } from '../src/types';

describe('isReadQuery / isWriteQuery', () => {
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

  test('insert/update/delete are write queries', () => {
    const insert: QueryBody = { mode: 'insert', dir: 'd', object: 'o', value: {} };
    const update: QueryBody = { mode: 'update', dir: 'd', object: 'o', key: 'k', value: {} };
    const del: QueryBody = { mode: 'delete', dir: 'd', object: 'o', key: 'k' };

    for (const q of [insert, update, del]) {
      expect(isWriteQuery(q)).toBe(true);
      expect(isReadQuery(q)).toBe(false);
    }
  });

  test('criteria nodes compose AND/OR trees', () => {
    const tree: QueryBody = {
      mode: 'find',
      dir: 'd',
      object: 'o',
      criteria: [
        {
          or: [
            { field: 'status', op: 'eq', value: 'open' },
            { and: [{ field: 'status', op: 'eq', value: 'pending' }, { field: 'age', op: 'gt', value: '5' }] },
          ],
        },
      ],
    };
    expect(isReadQuery(tree)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/types.test.ts`
Expected: FAIL — `src/types.ts` does not exist (module not found).

- [ ] **Step 4: Write the implementation**

Create `src/types.ts`:
```typescript
export type CriterionOp =
  | 'eq' | 'equal' | 'neq' | 'not_equal'
  | 'lt' | 'less' | 'gt' | 'greater' | 'lte' | 'less_eq' | 'gte' | 'greater_eq'
  | 'between'
  | 'in' | 'nin' | 'not_in'
  | 'exists' | 'nexists' | 'not_exists'
  | 'like' | 'nlike' | 'not_like'
  | 'contains' | 'ncontains' | 'not_contains'
  | 'starts' | 'starts_with' | 'ends' | 'ends_with'
  | 'ilike' | 'not_ilike' | 'icontains' | 'not_icontains' | 'istarts' | 'iends'
  | 'len_eq' | 'len_neq' | 'len_lt' | 'len_gt' | 'len_lte' | 'len_gte' | 'len_between'
  | 'eq_field' | 'neq_field' | 'lt_field' | 'gt_field' | 'lte_field' | 'gte_field'
  | 'regex' | 'not_regex';

export interface Criterion {
  field: string;
  op: CriterionOp;
  value: string;
  value2?: string;
}

export interface CriteriaOr {
  or: CriteriaNode[];
}

export interface CriteriaAnd {
  and: CriteriaNode[];
}

export type CriteriaNode = Criterion | CriteriaOr | CriteriaAnd;

export interface FindQuery {
  mode: 'find';
  dir: string;
  object: string;
  criteria: CriteriaNode[];
  offset?: number;
  limit?: number;
  fields?: string[];
  order_by?: string;
  order?: 'asc' | 'desc';
}

export interface CountQuery {
  mode: 'count';
  dir: string;
  object: string;
  criteria: CriteriaNode[];
}

export interface AggregateSpec {
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  alias: string;
}

export interface AggregateQuery {
  mode: 'aggregate';
  dir: string;
  object: string;
  criteria?: CriteriaNode[];
  group_by?: string[];
  aggregates: AggregateSpec[];
  having?: CriteriaNode[];
  order_by?: string;
  order?: 'asc' | 'desc';
  limit?: number;
}

export interface DescribeObjectQuery {
  mode: 'describe-object';
  dir: string;
  object: string;
}

export type ReadQuery = FindQuery | CountQuery | AggregateQuery | DescribeObjectQuery;

export interface InsertQuery {
  mode: 'insert';
  dir: string;
  object: string;
  key?: string;
  value: Record<string, unknown>;
  if_not_exists?: boolean;
}

export interface UpdateQuery {
  mode: 'update';
  dir: string;
  object: string;
  key: string;
  value: Record<string, unknown>;
  if?: CriteriaNode[];
}

export interface DeleteQuery {
  mode: 'delete';
  dir: string;
  object: string;
  key: string;
  if?: CriteriaNode[];
}

export type WriteQuery = InsertQuery | UpdateQuery | DeleteQuery;

export type QueryBody = ReadQuery | WriteQuery;

export function isReadQuery(q: QueryBody): q is ReadQuery {
  return q.mode === 'find' || q.mode === 'count' || q.mode === 'aggregate' || q.mode === 'describe-object';
}

export function isWriteQuery(q: QueryBody): q is WriteQuery {
  return q.mode === 'insert' || q.mode === 'update' || q.mode === 'delete';
}

export interface FieldDescriptor {
  name: string;
  type: string;
  size?: number;
  precision?: number;
  scale?: number;
  removed?: boolean;
}

export interface ObjectSchema {
  dir: string;
  object: string;
  splits: number;
  max_key: number;
  value_size: number;
  fields: FieldDescriptor[];
  indexes: string[];
  counts: { live: number; tombstoned: number };
}

export type SessionState = string;

export interface QueryRequestItem {
  id: string;
  query: ReadQuery;
}

export type AgentTurnResult =
  | { kind: 'query_request'; queries: QueryRequestItem[]; state: SessionState }
  | { kind: 'answer'; text: string; state: SessionState }
  | { kind: 'proposed_write'; body: WriteQuery; summary: string; pendingId: string; state: SessionState };

export type TurnInput =
  | { kind: 'query_result'; id: string; data: unknown }
  | { kind: 'write_outcome'; pendingId: string; outcome: 'committed' | 'rejected'; error?: string };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/types.test.ts`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore src/types.ts test/types.test.ts bun.lockb
git commit -m "feat: scaffold project and define core protocol/domain types"
```

---

### Task 2: Error types

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing (no dependency on Task 1's types).
- Produces: `AgentError` (extends `Error`), `InvalidStateError` (extends `AgentError`), `WriteValidationError` (extends `AgentError`, carries `readonly issues: string[]`).

- [ ] **Step 1: Write the failing test**

Create `test/errors.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { AgentError, InvalidStateError, WriteValidationError } from '../src/errors';

describe('error types', () => {
  test('InvalidStateError is an AgentError and an Error', () => {
    const err = new InvalidStateError('bad state');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(InvalidStateError);
    expect(err.name).toBe('InvalidStateError');
    expect(err.message).toBe('bad state');
  });

  test('WriteValidationError carries an issues array', () => {
    const err = new WriteValidationError('invalid write', ['unknown field: foo', 'missing key']);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.issues).toEqual(['unknown field: foo', 'missing key']);
  });

  test('a plain AgentError is not an InvalidStateError', () => {
    const err = new AgentError('generic failure');
    expect(err).toBeInstanceOf(AgentError);
    expect(err).not.toBeInstanceOf(InvalidStateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/errors.test.ts`
Expected: FAIL — `src/errors.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/errors.ts`:
```typescript
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export class InvalidStateError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export class WriteValidationError extends AgentError {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'WriteValidationError';
    this.issues = issues;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/errors.test.ts`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: add AgentError, InvalidStateError, WriteValidationError"
```

---

### Task 3: LLM client seam + OpenAI-compatible implementation

**Files:**
- Create: `src/llm-client.ts`
- Test: `test/llm-client.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `LlmToolCall` (`{ id: string; type: 'function'; function: { name: string; arguments: string } }`), `LlmMessage` (`{ role: 'system'|'user'|'assistant'|'tool'; content: string | null; tool_calls?: LlmToolCall[]; tool_call_id?: string }`), `LlmToolDef` (`{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }`), `LlmCompleteParams` (`{ messages: LlmMessage[]; tools: LlmToolDef[] }`), `LlmClient` interface (`complete(params: LlmCompleteParams): Promise<LlmMessage>`), `OpenAICompatLlmClientOptions`, `OpenAICompatLlmClient implements LlmClient`.

- [ ] **Step 1: Write the failing test**

Create `test/llm-client.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { OpenAICompatLlmClient } from '../src/llm-client';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('OpenAICompatLlmClient', () => {
  test('posts model/messages/tools to <baseUrl>/chat/completions and returns the first choice message', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1/', model: 'qwen2.5-14b', fetchImpl });
    const result = await client.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [] });

    expect(result).toEqual({ role: 'assistant', content: 'hi' });
    expect(capturedUrl).toBe('http://localhost:8080/v1/chat/completions');
    const sentBody = JSON.parse((capturedInit?.body as string) ?? '{}');
    expect(sentBody.model).toBe('qwen2.5-14b');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(sentBody.tools).toBeUndefined();
  });

  test('includes an Authorization header when apiKey is set', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', apiKey: 'secret', fetchImpl });
    await client.complete({ messages: [], tools: [] });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  test('throws when the response is not ok', async () => {
    const fetchImpl = fakeFetch(500, { error: 'boom' });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/500/);
  });

  test('throws when the response has no choices', async () => {
    const fetchImpl = fakeFetch(200, { choices: [] });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/no choices/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/llm-client.test.ts`
Expected: FAIL — `src/llm-client.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/llm-client.ts`:
```typescript
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompleteParams {
  messages: LlmMessage[];
  tools: LlmToolDef[];
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<LlmMessage>;
}

export interface OpenAICompatLlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiChatCompletionResponse {
  choices: { message: LlmMessage }[];
}

export class OpenAICompatLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: params.messages,
        tools: params.tools.length > 0 ? params.tools : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`shard-db-agent: LLM endpoint returned ${response.status} ${response.statusText}: ${body}`);
    }

    const json = (await response.json()) as OpenAiChatCompletionResponse;
    const choice = json.choices?.[0];
    if (!choice) {
      throw new Error('shard-db-agent: LLM response had no choices');
    }
    return choice.message;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/llm-client.test.ts`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/llm-client.ts test/llm-client.test.ts
git commit -m "feat: add LlmClient seam and OpenAI-compatible client"
```

---

### Task 4: Deterministic key minting

**Files:**
- Create: `src/key-mint.ts`
- Test: `test/key-mint.test.ts`

**Interfaces:**
- Consumes: `uuid` package (`v5` export).
- Produces: `mintKey(pendingId: string): string`.

- [ ] **Step 1: Write the failing test**

Create `test/key-mint.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { mintKey } from '../src/key-mint';

describe('mintKey', () => {
  test('is deterministic for the same pendingId', () => {
    expect(mintKey('p1')).toBe(mintKey('p1'));
  });

  test('differs across pendingIds', () => {
    expect(mintKey('p1')).not.toBe(mintKey('p2'));
  });

  test('returns a well-formed UUIDv5 string', () => {
    const key = mintKey('p1');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/key-mint.test.ts`
Expected: FAIL — `src/key-mint.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/key-mint.ts`:
```typescript
import { v5 as uuidv5 } from 'uuid';

const KEY_MINT_NAMESPACE = '6f6a1f2e-6b7a-4b8e-9a9a-2f8e4b6a1c3d';

export function mintKey(pendingId: string): string {
  return uuidv5(pendingId, KEY_MINT_NAMESPACE);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/key-mint.test.ts`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/key-mint.ts test/key-mint.test.ts
git commit -m "feat: add deterministic key minting from pendingId"
```

---

### Task 5: Session state serialization

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `ObjectSchema`, `TurnInput`, `WriteQuery` from `src/types.ts`; `InvalidStateError` from `src/errors.ts`; `LlmMessage` from `src/llm-client.ts`.
- Produces: `PendingWrite` (`{ body: WriteQuery; toolCallId: string }`), `SessionData` (`{ version: number; schemas: Record<string, ObjectSchema>; messages: LlmMessage[]; pendingWrites: Record<string, PendingWrite> }`), `createInitialSessionData(schema: ObjectSchema): SessionData`, `cacheSchema(data: SessionData, schema: ObjectSchema): void`, `getSchema(data: SessionData, dir: string, object: string): ObjectSchema | undefined`, `serializeState(data: SessionData): string`, `deserializeState(state: string): SessionData` (throws `InvalidStateError`), `applyTurnInputs(data: SessionData, turnInputs: TurnInput[]): void` (throws `InvalidStateError` on an unresolvable `id`/`pendingId`).

- [ ] **Step 1: Write the failing test**

Create `test/state.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import {
  createInitialSessionData,
  cacheSchema,
  getSchema,
  serializeState,
  deserializeState,
  applyTurnInputs,
} from '../src/state';
import { InvalidStateError } from '../src/errors';
import type { ObjectSchema } from '../src/types';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  value_size: 100,
  fields: [{ name: 'name', type: 'varchar', size: 80 }],
  indexes: [],
  counts: { live: 10, tombstoned: 0 },
};

const lineItemsSchema: ObjectSchema = { ...materialsSchema, object: 'line_items' };

describe('state', () => {
  test('createInitialSessionData seeds schemas with the bootstrap schema', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(data.version).toBe(1);
    expect(data.messages).toEqual([]);
    expect(data.pendingWrites).toEqual({});
    expect(getSchema(data, 'landscaping', 'materials')).toEqual(materialsSchema);
  });

  test('cacheSchema adds additional object schemas without clobbering existing ones', () => {
    const data = createInitialSessionData(materialsSchema);
    cacheSchema(data, lineItemsSchema);
    expect(getSchema(data, 'landscaping', 'materials')).toEqual(materialsSchema);
    expect(getSchema(data, 'landscaping', 'line_items')).toEqual(lineItemsSchema);
  });

  test('getSchema returns undefined for an object never described', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(getSchema(data, 'landscaping', 'unknown_object')).toBeUndefined();
  });

  test('serializeState / deserializeState round-trips', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push({ role: 'user', content: 'hello' });
    const state = serializeState(data);
    expect(deserializeState(state)).toEqual(data);
  });

  test('deserializeState throws InvalidStateError on non-base64 garbage', () => {
    expect(() => deserializeState('!!!not base64!!!')).toThrow(InvalidStateError);
  });

  test('deserializeState throws InvalidStateError on base64 that is not JSON', () => {
    const notJson = Buffer.from('not json', 'utf-8').toString('base64');
    expect(() => deserializeState(notJson)).toThrow(InvalidStateError);
  });

  test('deserializeState throws InvalidStateError on well-formed JSON missing required fields', () => {
    const badShape = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf-8').toString('base64');
    expect(() => deserializeState(badShape)).toThrow(InvalidStateError);
  });

  test('deserializeState throws InvalidStateError on an unsupported version', () => {
    const wrongVersion = Buffer.from(
      JSON.stringify({ version: 999, schemas: {}, messages: [], pendingWrites: {} }),
      'utf-8',
    ).toString('base64');
    expect(() => deserializeState(wrongVersion)).toThrow(InvalidStateError);
  });

  test('applyTurnInputs appends a tool message for query_result keyed by the query id', () => {
    const data = createInitialSessionData(materialsSchema);
    applyTurnInputs(data, [{ kind: 'query_result', id: 'call_abc', data: [{ name: 'Versa-Lok' }] }]);
    expect(data.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_abc', content: JSON.stringify([{ name: 'Versa-Lok' }]) },
    ]);
  });

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

  test('applyTurnInputs throws InvalidStateError for an unknown pendingId', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(() =>
      applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'does-not-exist', outcome: 'committed' }]),
    ).toThrow(InvalidStateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/state.test.ts`
Expected: FAIL — `src/state.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/state.ts`:
```typescript
import type { ObjectSchema, TurnInput, WriteQuery } from './types';
import { InvalidStateError } from './errors';
import type { LlmMessage } from './llm-client';

const STATE_VERSION = 1;

export interface PendingWrite {
  body: WriteQuery;
  toolCallId: string;
}

export interface SessionData {
  version: number;
  schemas: Record<string, ObjectSchema>;
  messages: LlmMessage[];
  pendingWrites: Record<string, PendingWrite>;
}

function schemaKey(dir: string, object: string): string {
  return `${dir}/${object}`;
}

export function createInitialSessionData(schema: ObjectSchema): SessionData {
  return {
    version: STATE_VERSION,
    schemas: { [schemaKey(schema.dir, schema.object)]: schema },
    messages: [],
    pendingWrites: {},
  };
}

export function cacheSchema(data: SessionData, schema: ObjectSchema): void {
  data.schemas[schemaKey(schema.dir, schema.object)] = schema;
}

export function getSchema(data: SessionData, dir: string, object: string): ObjectSchema | undefined {
  return data.schemas[schemaKey(dir, object)];
}

export function serializeState(data: SessionData): string {
  return Buffer.from(JSON.stringify(data), 'utf-8').toString('base64');
}

export function deserializeState(state: string): SessionData {
  let json: string;
  try {
    json = Buffer.from(state, 'base64').toString('utf-8');
  } catch {
    throw new InvalidStateError('shard-db-agent: state is not valid base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidStateError('shard-db-agent: state does not decode to valid JSON');
  }

  const candidate = parsed as Partial<SessionData> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.version !== STATE_VERSION ||
    typeof candidate.schemas !== 'object' ||
    !Array.isArray(candidate.messages) ||
    typeof candidate.pendingWrites !== 'object'
  ) {
    throw new InvalidStateError('shard-db-agent: state is missing required fields or has an unsupported version');
  }

  return candidate as SessionData;
}

export function applyTurnInputs(data: SessionData, turnInputs: TurnInput[]): void {
  for (const input of turnInputs) {
    if (input.kind === 'query_result') {
      data.messages.push({
        role: 'tool',
        tool_call_id: input.id,
        content: JSON.stringify(input.data),
      });
      continue;
    }

    const pending = data.pendingWrites[input.pendingId];
    if (!pending) {
      throw new InvalidStateError(
        `shard-db-agent: write_outcome pendingId "${input.pendingId}" does not match any pending write from this session`,
      );
    }
    delete data.pendingWrites[input.pendingId];
    data.messages.push({
      role: 'tool',
      tool_call_id: pending.toolCallId,
      content: JSON.stringify({ outcome: input.outcome, error: input.error ?? null }),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/state.test.ts`
Expected: PASS — 10 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: add session state serialization and turnInputs folding"
```

---

### Task 6: Tool definitions

**Files:**
- Create: `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `LlmToolDef`, `LlmToolCall` from `src/llm-client.ts`; `ReadQuery`, `WriteQuery`, `FindQuery`, `CountQuery`, `AggregateQuery`, `DescribeObjectQuery` from `src/types.ts`.
- Produces: `FIND_RECORDS_TOOL`, `COUNT_RECORDS_TOOL`, `AGGREGATE_RECORDS_TOOL`, `DESCRIBE_OBJECT_TOOL`, `PROPOSE_WRITE_TOOL` (all `LlmToolDef`), `READ_TOOL_DEFS: LlmToolDef[]`, `ALL_TOOL_DEFS: LlmToolDef[]`, `isReadToolCall(call: LlmToolCall): boolean`, `isProposeWriteToolCall(call: LlmToolCall): boolean`, `toolCallToReadQuery(call: LlmToolCall): ReadQuery`, `ProposeWriteArgs` (`{ summary: string; body: WriteQuery }`), `parseProposeWriteArgs(call: LlmToolCall): ProposeWriteArgs`.

- [ ] **Step 1: Write the failing test**

Create `test/tools.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import {
  ALL_TOOL_DEFS,
  READ_TOOL_DEFS,
  isReadToolCall,
  isProposeWriteToolCall,
  toolCallToReadQuery,
  parseProposeWriteArgs,
} from '../src/tools';
import type { LlmToolCall } from '../src/llm-client';

function toolCall(name: string, args: unknown): LlmToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('tool definitions', () => {
  test('ALL_TOOL_DEFS has exactly 5 tools with unique names', () => {
    expect(ALL_TOOL_DEFS).toHaveLength(5);
    const names = new Set(ALL_TOOL_DEFS.map((t) => t.function.name));
    expect(names.size).toBe(5);
  });

  test('READ_TOOL_DEFS excludes propose_write', () => {
    expect(READ_TOOL_DEFS.some((t) => t.function.name === 'propose_write')).toBe(false);
  });

  test('isReadToolCall / isProposeWriteToolCall classify correctly', () => {
    const find = toolCall('find_records', { dir: 'd', object: 'o', criteria: [] });
    const write = toolCall('propose_write', { summary: 's', body: {} });
    expect(isReadToolCall(find)).toBe(true);
    expect(isProposeWriteToolCall(find)).toBe(false);
    expect(isReadToolCall(write)).toBe(false);
    expect(isProposeWriteToolCall(write)).toBe(true);
  });

  test('toolCallToReadQuery maps find_records to a FindQuery', () => {
    const call = toolCall('find_records', {
      dir: 'landscaping',
      object: 'materials',
      criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
    });
    expect(toolCallToReadQuery(call)).toEqual({
      mode: 'find',
      dir: 'landscaping',
      object: 'materials',
      criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
    });
  });

  test('toolCallToReadQuery maps describe_object to a DescribeObjectQuery', () => {
    const call = toolCall('describe_object', { dir: 'landscaping', object: 'materials' });
    expect(toolCallToReadQuery(call)).toEqual({ mode: 'describe-object', dir: 'landscaping', object: 'materials' });
  });

  test('toolCallToReadQuery throws for propose_write', () => {
    const call = toolCall('propose_write', { summary: 's', body: {} });
    expect(() => toolCallToReadQuery(call)).toThrow();
  });

  test('parseProposeWriteArgs parses summary and body', () => {
    const call = toolCall('propose_write', {
      summary: 'Add: Block retaining wall',
      body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { qty: 120 } },
    });
    expect(parseProposeWriteArgs(call)).toEqual({
      summary: 'Add: Block retaining wall',
      body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { qty: 120 } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/tools.test.ts`
Expected: FAIL — `src/tools.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/tools.ts`:
```typescript
import type { LlmToolDef, LlmToolCall } from './llm-client';
import type { AggregateQuery, CountQuery, DescribeObjectQuery, FindQuery, ReadQuery, WriteQuery } from './types';

export const FIND_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'find_records',
    description: 'Find records matching criteria. Returns an array of {key, value} records.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: {
          type: 'array',
          items: {},
          description: 'AND-combined criteria; pass [] to match every record.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional field projection.',
        },
        order_by: { type: 'string' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
      required: ['dir', 'object', 'criteria'],
    },
  },
};

export const COUNT_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'count_records',
    description: 'Count records matching criteria, without fetching their values.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: { type: 'array', items: {} },
      },
      required: ['dir', 'object', 'criteria'],
    },
  },
};

export const AGGREGATE_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'aggregate_records',
    description: 'Group-by aggregation (count/sum/avg/min/max) over records matching criteria.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: { type: 'array', items: {} },
        group_by: { type: 'array', items: { type: 'string' } },
        aggregates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
              field: { type: 'string' },
              alias: { type: 'string' },
            },
            required: ['fn', 'alias'],
          },
        },
        having: { type: 'array', items: {} },
        order_by: { type: 'string' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
      },
      required: ['dir', 'object', 'aggregates'],
    },
  },
};

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

export const PROPOSE_WRITE_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'propose_write',
    description:
      'Propose an insert, update, or delete for the user to confirm. Never assume a write happened until you are told it was committed.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One-line human-readable summary of the write, shown to the user for confirmation.',
        },
        body: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['insert', 'update', 'delete'] },
            dir: { type: 'string' },
            object: { type: 'string' },
            key: {
              type: 'string',
              description: 'Required for update/delete. Optional for insert — omit to have one generated.',
            },
            value: {
              type: 'object',
              description: 'Required for insert/update. Field values matching the object schema.',
            },
          },
          required: ['mode', 'dir', 'object'],
        },
      },
      required: ['summary', 'body'],
    },
  },
};

export const READ_TOOL_DEFS: LlmToolDef[] = [
  FIND_RECORDS_TOOL,
  COUNT_RECORDS_TOOL,
  AGGREGATE_RECORDS_TOOL,
  DESCRIBE_OBJECT_TOOL,
];

export const ALL_TOOL_DEFS: LlmToolDef[] = [...READ_TOOL_DEFS, PROPOSE_WRITE_TOOL];

const READ_TOOL_NAMES = new Set(READ_TOOL_DEFS.map((t) => t.function.name));

export function isReadToolCall(call: LlmToolCall): boolean {
  return READ_TOOL_NAMES.has(call.function.name);
}

export function isProposeWriteToolCall(call: LlmToolCall): boolean {
  return call.function.name === 'propose_write';
}

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

export interface ProposeWriteArgs {
  summary: string;
  body: WriteQuery;
}

export function parseProposeWriteArgs(call: LlmToolCall): ProposeWriteArgs {
  return JSON.parse(call.function.arguments) as ProposeWriteArgs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/tools.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: add LLM tool definitions and tool-call parsing"
```

---

### Task 7: System prompt builder

**Files:**
- Create: `src/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: `ObjectSchema` from `src/types.ts`.
- Produces: `buildSystemPrompt(schemas: Record<string, ObjectSchema>): string`.

- [ ] **Step 1: Write the failing test**

Create `test/prompt.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { buildSystemPrompt } from '../src/prompt';
import type { ObjectSchema } from '../src/types';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  value_size: 100,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
    { name: 'old_field', type: 'varchar', size: 10, removed: true },
  ],
  indexes: ['category'],
  counts: { live: 10, tombstoned: 0 },
};

describe('buildSystemPrompt', () => {
  test('lists known fields and indexes for a described object', () => {
    const prompt = buildSystemPrompt({ 'landscaping/materials': materialsSchema });
    expect(prompt).toContain('landscaping/materials');
    expect(prompt).toContain('name: varchar(80)');
    expect(prompt).toContain('unit_price: double');
    expect(prompt).toContain('Indexed: category');
  });

  test('excludes removed fields', () => {
    const prompt = buildSystemPrompt({ 'landscaping/materials': materialsSchema });
    expect(prompt).not.toContain('old_field');
  });

  test('says no schemas are known yet when the map is empty', () => {
    expect(buildSystemPrompt({})).toContain('none yet');
  });

  test('always includes the confirm-before-write rule', () => {
    expect(buildSystemPrompt({})).toContain('propose_write');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prompt.test.ts`
Expected: FAIL — `src/prompt.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/prompt.ts`:
```typescript
import type { ObjectSchema } from './types';

export function buildSystemPrompt(schemas: Record<string, ObjectSchema>): string {
  const schemaEntries = Object.values(schemas);
  const schemaBlock =
    schemaEntries.length > 0
      ? schemaEntries.map(describeSchemaForPrompt).join('\n\n')
      : '(none yet — call describe_object to learn a schema before reading or writing that object)';

  return `You are a natural-language interface to a shard-db database. You translate the user's plain-English requests into tool calls against known object schemas.

Rules:
- Only reference fields that are listed for an object below; never invent a field name.
- If an object you need is not listed below, call describe_object for it before reading or writing it.
- For any insert, update, or delete, call propose_write. Never assume a write has happened until you are told its outcome.
- If you are missing information needed to answer or to propose a write, ask a clarifying question in plain text instead of guessing.
- Prefer the fewest tool calls that answer the request.

Known object schemas:
${schemaBlock}`;
}

function describeSchemaForPrompt(schema: ObjectSchema): string {
  const fieldLines = schema.fields
    .filter((f) => !f.removed)
    .map((f) => `  - ${f.name}: ${f.type}${f.size ? `(${f.size})` : ''}`)
    .join('\n');
  const indexLine = schema.indexes.length > 0 ? schema.indexes.join(', ') : 'none';

  return `### ${schema.dir}/${schema.object}\nFields:\n${fieldLines}\nIndexed: ${indexLine}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/prompt.test.ts`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts test/prompt.test.ts
git commit -m "feat: add system prompt builder from known object schemas"
```

---

### Task 8: Write validation

**Files:**
- Create: `src/write-validate.ts`
- Test: `test/write-validate.test.ts`

**Interfaces:**
- Consumes: `ObjectSchema`, `FieldDescriptor`, `InsertQuery`, `UpdateQuery`, `DeleteQuery` from `src/types.ts`; `WriteValidationError` from `src/errors.ts`.
- Produces: `validateWriteAgainstSchema(schema: ObjectSchema, body: InsertQuery | UpdateQuery | DeleteQuery): void` (throws `WriteValidationError` on any violation; returns normally otherwise).

- [ ] **Step 1: Write the failing test**

Create `test/write-validate.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { validateWriteAgainstSchema } from '../src/write-validate';
import { WriteValidationError } from '../src/errors';
import type { ObjectSchema } from '../src/types';

const lineItemsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  value_size: 200,
  fields: [
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit_price', type: 'numeric', precision: 12, scale: 2 },
    { name: 'shipped', type: 'bool' },
    { name: 'old_note', type: 'varchar', size: 40, removed: true },
  ],
  indexes: [],
  counts: { live: 0, tombstoned: 0 },
};

describe('validateWriteAgainstSchema', () => {
  test('passes a well-formed insert', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { description: 'Block retaining wall', qty: 120, unit_price: 6.85, shipped: false },
      }),
    ).not.toThrow();
  });

  test('rejects an unknown field', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { made_up_field: 'x' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a removed field', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { old_note: 'x' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a type mismatch', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { qty: '120' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a varchar value exceeding max length', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { description: 'x'.repeat(81) },
      }),
    ).toThrow(WriteValidationError);
  });

  test('update without a key is rejected', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'update',
        dir: 'landscaping',
        object: 'line_items',
        key: '',
        value: { qty: 5 },
      }),
    ).toThrow(WriteValidationError);
  });

  test('delete requires only a non-empty key, not a value', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'delete',
        dir: 'landscaping',
        object: 'line_items',
        key: 'li_1',
      }),
    ).not.toThrow();
  });

  test('delete without a key is rejected', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'delete',
        dir: 'landscaping',
        object: 'line_items',
        key: '',
      }),
    ).toThrow(WriteValidationError);
  });

  test('collects multiple issues in a single error', () => {
    try {
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { made_up: 'x', qty: 'not a number' },
      });
      throw new Error('expected validateWriteAgainstSchema to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WriteValidationError);
      expect((err as WriteValidationError).issues).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/write-validate.test.ts`
Expected: FAIL — `src/write-validate.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/write-validate.ts`:
```typescript
import type { ObjectSchema, InsertQuery, UpdateQuery, DeleteQuery, FieldDescriptor } from './types';
import { WriteValidationError } from './errors';

type ExpectedJsType = 'string' | 'number' | 'boolean';

const NUMERIC_TYPES = new Set(['int', 'long', 'short', 'byte', 'double', 'numeric']);
const STRING_TYPES = new Set(['varchar', 'date', 'datetime', 'datetimems', 'timestamp', 'ipv4', 'ipv6']);

function expectedJsType(fieldType: string): ExpectedJsType | undefined {
  if (NUMERIC_TYPES.has(fieldType)) return 'number';
  if (STRING_TYPES.has(fieldType)) return 'string';
  if (fieldType === 'bool') return 'boolean';
  return undefined;
}

function findField(schema: ObjectSchema, name: string): FieldDescriptor | undefined {
  return schema.fields.find((f) => f.name === name && !f.removed);
}

export function validateWriteAgainstSchema(
  schema: ObjectSchema,
  body: InsertQuery | UpdateQuery | DeleteQuery,
): void {
  const issues: string[] = [];

  if (body.mode === 'delete') {
    if (!body.key || body.key.length === 0) {
      issues.push('delete requires a non-empty key');
    }
    if (issues.length > 0) {
      throw new WriteValidationError(`shard-db-agent: invalid delete write for ${schema.dir}/${schema.object}`, issues);
    }
    return;
  }

  if (body.mode === 'update' && (!body.key || body.key.length === 0)) {
    issues.push('update requires a non-empty key');
  }

  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${body.mode} requires a "value" object`);
    throw new WriteValidationError(`shard-db-agent: invalid ${body.mode} write for ${schema.dir}/${schema.object}`, issues);
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    const field = findField(schema, fieldName);
    if (!field) {
      issues.push(`unknown field: ${fieldName}`);
      continue;
    }
    const expected = expectedJsType(field.type);
    if (expected && typeof fieldValue !== expected) {
      issues.push(`field "${fieldName}" expects ${expected} for type ${field.type}, got ${typeof fieldValue}`);
      continue;
    }
    if (field.type === 'varchar' && typeof fieldValue === 'string' && field.size && fieldValue.length > field.size) {
      issues.push(`field "${fieldName}" exceeds max length ${field.size} (got ${fieldValue.length})`);
    }
  }

  if (issues.length > 0) {
    throw new WriteValidationError(`shard-db-agent: invalid ${body.mode} write for ${schema.dir}/${schema.object}`, issues);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/write-validate.test.ts`
Expected: PASS — 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/write-validate.ts test/write-validate.test.ts
git commit -m "feat: add schema-based write payload validation"
```

---

### Task 9: Core turn loop (`Agent`)

**Files:**
- Create: `src/agent.ts`
- Create: `test/fixtures/fake-llm-client.ts`
- Test: `test/agent.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–8 (`types.ts`, `errors.ts`, `llm-client.ts`, `key-mint.ts`, `state.ts`, `tools.ts`, `prompt.ts`, `write-validate.ts`).
- Produces: `AgentOptions` (`{ llmClient?: LlmClient; executor?: (query: ReadQuery) => Promise<unknown>; baseUrl?: string; apiKey?: string; model?: string; maxToolIterations?: number }`), `Agent` class with `constructor(options?: AgentOptions)` and `turn(state: SessionState | null, text: string | null, schema?: ObjectSchema, turnInputs?: TurnInput[]): Promise<AgentTurnResult>`.

**Design note for this task (binding on the implementer — do not deviate):** a `propose_write` tool call whose `body.dir`/`body.object` has no cached schema in this session (i.e. `getSchema` returns `undefined`) is treated as a validation failure: throw `WriteValidationError` with a single issue string `unknown object: <dir>/<object>`. This keeps "malformed proposals never reach the host" true even when the LLM skips calling `describe_object` first.

- [ ] **Step 1: Create the fake LLM client test fixture**

Create `test/fixtures/fake-llm-client.ts`:
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

This fixture has no test of its own — it is exercised transitively by `test/agent.test.ts` in Step 3 below.

- [ ] **Step 2: Write the failing test**

Create `test/agent.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { Agent } from '../src/agent';
import { FakeLlmClient } from './fixtures/fake-llm-client';
import { InvalidStateError, WriteValidationError } from '../src/errors';
import type { ObjectSchema } from '../src/types';
import type { LlmMessage, LlmToolCall } from '../src/llm-client';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  value_size: 100,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
  ],
  indexes: ['category'],
  counts: { live: 10, tombstoned: 0 },
};

const lineItemsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  value_size: 200,
  fields: [
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit_price', type: 'double' },
    { name: 'total', type: 'double' },
  ],
  indexes: [],
  counts: { live: 0, tombstoned: 0 },
};

function findToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'find_records', arguments: JSON.stringify(args) } };
}

function writeToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'propose_write', arguments: JSON.stringify(args) } };
}

describe('Agent.turn', () => {
  test('throws when state is null and no schema is provided', async () => {
    const agent = new Agent({ llmClient: new FakeLlmClient([]) });
    await expect(agent.turn(null, 'hello')).rejects.toThrow(/schema is required/);
  });

  test('a plain assistant reply with no tool calls returns kind: answer', async () => {
    const llm = new FakeLlmClient([{ role: 'assistant', content: 'The wall needs a permit above 4 feet.' }]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'Do I need a permit?', materialsSchema);

    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      expect(result.text).toBe('The wall needs a permit above 4 feet.');
      expect(typeof result.state).toBe('string');
    }
  });

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

  test('query_result turnInput feeds back into the next LLM call', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
      { role: 'assistant', content: 'Versa-Lok is $6.85/sqft.' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const first = await agent.turn(null, 'What does Versa-Lok cost?', materialsSchema);
    expect(first.kind).toBe('query_request');
    if (first.kind !== 'query_request') throw new Error('expected query_request');

    const second = await agent.turn(first.state, null, undefined, [
      { kind: 'query_result', id: 'call_1', data: [{ name: 'Versa-Lok', unit_price: 6.85 }] },
    ]);

    expect(second.kind).toBe('answer');
    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_1');
    expect(toolMessage?.content).toBe(JSON.stringify([{ name: 'Versa-Lok', unit_price: 6.85 }]));
  });

  test('propose_write validates against the target schema, mints a key for insert, and returns proposed_write', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w1', {
            summary: 'Add: Block retaining wall, 120 sqft @ $6.85 = $822.00',
            body: {
              mode: 'insert',
              dir: 'landscaping',
              object: 'line_items',
              value: { description: 'Block retaining wall', qty: 120, unit_price: 6.85, total: 822 },
            },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'Add that to the estimate', lineItemsSchema);

    expect(result.kind).toBe('proposed_write');
    if (result.kind !== 'proposed_write') throw new Error('expected proposed_write');
    expect(result.summary).toBe('Add: Block retaining wall, 120 sqft @ $6.85 = $822.00');
    expect(result.body.mode).toBe('insert');
    expect(result.body.dir).toBe('landscaping');
    expect(result.body.object).toBe('line_items');
    if (result.body.mode === 'insert') {
      expect(typeof result.body.key).toBe('string');
      expect((result.body.key ?? '').length).toBeGreaterThan(0);
      expect(result.body.value).toEqual({
        description: 'Block retaining wall',
        qty: 120,
        unit_price: 6.85,
        total: 822,
      });
    }
    expect(typeof result.pendingId).toBe('string');
  });

  test('propose_write for an object with no known schema throws WriteValidationError', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w1', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'never_described', value: {} },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    await expect(agent.turn(null, 'add it', lineItemsSchema)).rejects.toThrow(WriteValidationError);
  });

  test('propose_write with an invalid field is rejected before reaching the host', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w1', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { made_up_field: 'x' } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    await expect(agent.turn(null, 'add it', lineItemsSchema)).rejects.toThrow(WriteValidationError);
  });

  test('with an executor, read tool calls auto-run within a single turn() call', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
      { role: 'assistant', content: 'Versa-Lok is $6.85/sqft.' },
    ]);
    const executorCalls: unknown[] = [];
    const agent = new Agent({
      llmClient: llm,
      executor: async (query) => {
        executorCalls.push(query);
        return [{ name: 'Versa-Lok', unit_price: 6.85 }];
      },
    });

    const result = await agent.turn(null, 'What does Versa-Lok cost?', materialsSchema);

    expect(result.kind).toBe('answer');
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toEqual({ mode: 'find', dir: 'landscaping', object: 'materials', criteria: [] });
    expect(llm.callCount).toBe(2);
  });

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

  test('executor failure propagates unchanged out of turn()', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
    ]);
    const boom = new Error('executor exploded');
    const agent = new Agent({
      llmClient: llm,
      executor: async () => {
        throw boom;
      },
    });

    await expect(agent.turn(null, 'anything', materialsSchema)).rejects.toBe(boom);
  });

  test('LLM failure propagates out of turn() and leaves state usable for a retry', async () => {
    const workingLlm = new FakeLlmClient([
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'retry answer' },
    ]);
    const agent = new Agent({ llmClient: workingLlm });

    const first = await agent.turn(null, 'hello', materialsSchema);
    expect(first.kind).toBe('answer');

    const failingLlm = new FakeLlmClient([]);
    const brokenAgent = new Agent({ llmClient: failingLlm });
    await expect(brokenAgent.turn(first.state, 'this will fail')).rejects.toThrow();

    const retry = await agent.turn(first.state, 'try again');
    expect(retry.kind).toBe('answer');
    if (retry.kind === 'answer') expect(retry.text).toBe('retry answer');
  });

  test('a corrupted state blob throws InvalidStateError without calling the LLM', async () => {
    const llm = new FakeLlmClient([{ role: 'assistant', content: 'should not be reached' }]);
    const agent = new Agent({ llmClient: llm });

    await expect(agent.turn('not a valid state blob', 'hello')).rejects.toThrow(InvalidStateError);
    expect(llm.callCount).toBe(0);
  });

  test('write_outcome turnInput is folded into the next turn and clears the pending write', async () => {
    const llm = new FakeLlmClient([
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
      { role: 'assistant', content: 'Got it, noted as added.' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const proposed = await agent.turn(null, 'add it', lineItemsSchema);
    expect(proposed.kind).toBe('proposed_write');
    if (proposed.kind !== 'proposed_write') throw new Error('expected proposed_write');

    const followUp = await agent.turn(proposed.state, null, undefined, [
      { kind: 'write_outcome', pendingId: proposed.pendingId, outcome: 'committed' },
    ]);

    expect(followUp.kind).toBe('answer');
    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.tool_call_id === 'call_w1');
    expect(toolMessage?.content).toBe(JSON.stringify({ outcome: 'committed', error: null }));
  });

  test('an unknown write_outcome pendingId throws InvalidStateError', async () => {
    const llm = new FakeLlmClient([{ role: 'assistant', content: 'hi' }]);
    const agent = new Agent({ llmClient: llm });
    const first = await agent.turn(null, 'hello', materialsSchema);
    expect(first.kind).toBe('answer');
    if (first.kind !== 'answer') throw new Error('expected answer');

    await expect(
      agent.turn(first.state, null, undefined, [
        { kind: 'write_outcome', pendingId: 'does-not-exist', outcome: 'committed' },
      ]),
    ).rejects.toThrow(InvalidStateError);
  });

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

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/agent.test.ts`
Expected: FAIL — `src/agent.ts` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/agent.ts`:
```typescript
import type { AgentTurnResult, ObjectSchema, QueryRequestItem, ReadQuery, SessionState, TurnInput, WriteQuery } from './types';
import type { LlmClient, LlmMessage } from './llm-client';
import { OpenAICompatLlmClient } from './llm-client';
import {
  applyTurnInputs,
  cacheSchema,
  createInitialSessionData,
  deserializeState,
  getSchema,
  serializeState,
  type SessionData,
} from './state';
import { ALL_TOOL_DEFS, isProposeWriteToolCall, isReadToolCall, parseProposeWriteArgs, toolCallToReadQuery } from './tools';
import { buildSystemPrompt } from './prompt';
import { validateWriteAgainstSchema } from './write-validate';
import { mintKey } from './key-mint';
import { WriteValidationError } from './errors';

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface AgentOptions {
  llmClient?: LlmClient;
  executor?: (query: ReadQuery) => Promise<unknown>;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxToolIterations?: number;
}

export class Agent {
  private readonly llmClient: LlmClient;
  private readonly executor?: (query: ReadQuery) => Promise<unknown>;
  private readonly maxToolIterations: number;

  constructor(options: AgentOptions = {}) {
    if (options.llmClient) {
      this.llmClient = options.llmClient;
    } else {
      if (!options.baseUrl || !options.model) {
        throw new Error('shard-db-agent: Agent requires either an llmClient or both baseUrl and model');
      }
      this.llmClient = new OpenAICompatLlmClient({
        baseUrl: options.baseUrl,
        model: options.model,
        apiKey: options.apiKey,
      });
    }
    this.executor = options.executor;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

  async turn(
    state: SessionState | null,
    text: string | null,
    schema?: ObjectSchema,
    turnInputs?: TurnInput[],
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

      const writeCall = toolCalls.find(isProposeWriteToolCall);
      if (writeCall) {
        const { summary, body } = parseProposeWriteArgs(writeCall);
        const objSchema = getSchema(data, body.dir, body.object);
        if (!objSchema) {
          throw new WriteValidationError(
            `shard-db-agent: propose_write targeted ${body.dir}/${body.object}, which has not been described in this session`,
            [`unknown object: ${body.dir}/${body.object}`],
          );
        }
        validateWriteAgainstSchema(objSchema, body);

        const pendingId = crypto.randomUUID();
        const finalBody: WriteQuery = body.mode === 'insert' && !body.key ? { ...body, key: mintKey(pendingId) } : body;

        data.pendingWrites[pendingId] = { body: finalBody, toolCallId: writeCall.id };
        data.messages.push({
          role: 'tool',
          tool_call_id: writeCall.id,
          content: JSON.stringify({ status: 'pending_confirmation', pendingId }),
        });

        return { kind: 'proposed_write', body: finalBody, summary, pendingId, state: serializeState(data) };
      }

      const readCalls = toolCalls.filter(isReadToolCall);
      const readQueries = readCalls.map(toolCallToReadQuery);

      if (this.executor) {
        for (let i = 0; i < readCalls.length; i++) {
          const call = readCalls[i];
          const query = readQueries[i];
          const result = await this.executor(query);
          if (query.mode === 'describe-object') {
            cacheSchema(data, result as ObjectSchema);
          }
          data.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }

      const queries: QueryRequestItem[] = readCalls.map((call, i) => ({ id: call.id, query: readQueries[i] }));
      return { kind: 'query_request', queries, state: serializeState(data) };
    }

    throw new Error(
      `shard-db-agent: exceeded max tool-use iterations (${this.maxToolIterations}) without producing a result`,
    );
  }

  private loadSessionData(state: SessionState | null, schema?: ObjectSchema): SessionData {
    if (state === null) {
      if (!schema) {
        throw new Error('shard-db-agent: schema is required on the first turn of a new session (state is null)');
      }
      return createInitialSessionData(schema);
    }
    const data = deserializeState(state);
    if (schema) {
      cacheSchema(data, schema);
    }
    return data;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/agent.test.ts`
Expected: PASS — 15 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts test/fixtures/fake-llm-client.ts test/agent.test.ts
git commit -m "feat: implement Agent.turn() tool-use state machine"
```

---

### Task 10: Public exports + end-to-end integration test

**Files:**
- Create: `src/index.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: all public symbols from Tasks 1–9.
- Produces: the package's public API surface (`src/index.ts`), re-exporting exactly the symbols listed in Step 3 below. No new runtime logic.

- [ ] **Step 1: Write the failing test**

Create `test/integration.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { Agent, type ObjectSchema, type TurnInput } from '../src/index';
import { FakeLlmClient } from './fixtures/fake-llm-client';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  value_size: 100,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
  ],
  indexes: ['category'],
  counts: { live: 1, tombstoned: 0 },
};

const lineItemsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  value_size: 200,
  fields: [
    { name: 'estimate_id', type: 'long' },
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
    { name: 'unit_price', type: 'double' },
    { name: 'total', type: 'double' },
  ],
  indexes: [],
  counts: { live: 0, tombstoned: 0 },
};

describe('end-to-end conversation (landscaping estimate example)', () => {
  test('find -> price -> propose_write -> confirm', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_find_materials',
            type: 'function',
            function: {
              name: 'find_records',
              arguments: JSON.stringify({
                dir: 'landscaping',
                object: 'materials',
                criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
              }),
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_propose_line_item',
            type: 'function',
            function: {
              name: 'propose_write',
              arguments: JSON.stringify({
                summary: 'Add: Block retaining wall, 120 sqft @ $6.85 = $822.00 to Simmons estimate. Confirm?',
                body: {
                  mode: 'insert',
                  dir: 'landscaping',
                  object: 'line_items',
                  value: {
                    estimate_id: 1042,
                    description: 'Block retaining wall',
                    qty: 120,
                    unit: 'sqft',
                    unit_price: 6.85,
                    total: 822,
                  },
                },
              }),
            },
          },
        ],
      },
      { role: 'assistant', content: 'Added and confirmed — anything else for the Simmons estimate?' },
    ]);

    const agent = new Agent({ llmClient: llm });

    const turn1 = await agent.turn(
      null,
      "I'm at the Simmons property, they want a block retaining wall, about 40 feet long, 3 feet high.",
      materialsSchema,
    );
    expect(turn1.kind).toBe('query_request');
    if (turn1.kind !== 'query_request') throw new Error('expected query_request');
    expect(turn1.queries[0].query).toEqual({
      mode: 'find',
      dir: 'landscaping',
      object: 'materials',
      criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
    });

    const queryResultInput: TurnInput = {
      kind: 'query_result',
      id: turn1.queries[0].id,
      data: [{ name: 'Versa-Lok Standard', unit_price: 6.85, unit: 'sqft' }],
    };
    const turn2 = await agent.turn(turn1.state, null, lineItemsSchema, [queryResultInput]);
    expect(turn2.kind).toBe('proposed_write');
    if (turn2.kind !== 'proposed_write') throw new Error('expected proposed_write');
    expect(turn2.body.mode).toBe('insert');
    expect(turn2.summary).toContain('822.00');
    const mintedKey = turn2.body.mode === 'insert' ? turn2.body.key : undefined;
    expect(mintedKey).toBeTruthy();

    const writeOutcomeInput: TurnInput = { kind: 'write_outcome', pendingId: turn2.pendingId, outcome: 'committed' };
    const turn3 = await agent.turn(turn2.state, null, undefined, [writeOutcomeInput]);
    expect(turn3.kind).toBe('answer');
    if (turn3.kind === 'answer') {
      expect(turn3.text).toContain('confirmed');
    }

    expect(llm.callCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integration.test.ts`
Expected: FAIL — `src/index.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/index.ts`:
```typescript
export type {
  Criterion,
  CriteriaNode,
  CriteriaOr,
  CriteriaAnd,
  CriterionOp,
  FindQuery,
  CountQuery,
  AggregateQuery,
  AggregateSpec,
  DescribeObjectQuery,
  ReadQuery,
  InsertQuery,
  UpdateQuery,
  DeleteQuery,
  WriteQuery,
  QueryBody,
  FieldDescriptor,
  ObjectSchema,
  SessionState,
  QueryRequestItem,
  AgentTurnResult,
  TurnInput,
} from './types';
export { isReadQuery, isWriteQuery } from './types';

export { AgentError, InvalidStateError, WriteValidationError } from './errors';

export type {
  LlmClient,
  LlmMessage,
  LlmToolCall,
  LlmToolDef,
  LlmCompleteParams,
  OpenAICompatLlmClientOptions,
} from './llm-client';
export { OpenAICompatLlmClient } from './llm-client';

export { Agent, type AgentOptions } from './agent';

export { mintKey } from './key-mint';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/integration.test.ts`
Expected: PASS — 1 test, 0 failures.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test`
Expected: PASS — all test files across Tasks 1–10 pass, 0 failures.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/integration.test.ts
git commit -m "feat: add public entry point and end-to-end integration test"
```

---

## Self-Review

**1. Spec coverage** (against `docs/plans/2026-07-06-shard-db-agent-design.md`, scoped to "Core library only" per the user's explicit choice):

- `turn(state, text, schema?, turnInputs?)` signature, null-safe on `state`/`text`/`schema`/`turnInputs` → Task 9 (`src/agent.ts`).
- Opaque `SessionState` string, versioned JSON blob under the hood → Task 5 (`src/state.ts`), Task 1 (`SessionState` type alias).
- `AgentTurnResult` three kinds (`query_request`, `answer`, `proposed_write`) → Task 1 (type), Task 9 (production logic), Task 9/10 tests cover all three.
- `TurnInput` two kinds (`query_result`, `write_outcome`) folded into session memory → Task 5 (`applyTurnInputs`), Task 9 (wiring), Task 9/10 tests.
- Reads (find/count/aggregate/describe-object) as LLM tool calls → Task 6 (`src/tools.ts`).
- `executor` auto-runs reads within one `turn()` call when configured; otherwise surfaces `query_request` → Task 9, both branches tested.
- Writes always surface as `proposed_write`, regardless of `executor` → Task 9 (write branch checked before the executor branch, unconditionally).
- Schema self-validation of write payloads before returning `proposed_write` → Task 8 (`validateWriteAgainstSchema`), wired in Task 9.
- Deterministic key minting for insert-shaped writes, pure function of `pendingId` → Task 4 (`mintKey`), wired in Task 9.
- Thrown-error failure model; `InvalidStateError` distinct for corrupted state → Task 2 (types), Task 5 (`deserializeState`/`applyTurnInputs` throw sites), Task 9 tests (`InvalidStateError` cases, LLM/executor failure propagation).
- Zero shard-db runtime/test dependency → enforced throughout; no task imports `shard-db` or spawns any daemon/CLI.
- `QueryBody` matching shard-db's real JSON protocol shapes exactly (find/count/aggregate/describe-object/insert/update/delete, criteria trees, CAS fields) → Task 1, grounded directly in `find.md`, `aggregate.md`, `cas.md`, `diagnostics.md`, `count.md`.
- LLM client seam + real OpenAI-compat implementation → Task 3.
- System-prompt rendering from known schemas → Task 7.

No gaps found against the "core library only" scope. `bin/serve` and the eval harness are explicitly out of scope per Global Constraints and are not covered here.

**2. Placeholder scan:** no `TBD`/`TODO`/"add error handling"/"similar to Task N" patterns present; every step has complete, real code.

**3. Type consistency:** verified `SessionData`/`PendingWrite` (Task 5) match how Task 9 constructs and reads `pendingWrites`; `LlmMessage`/`LlmToolCall`/`LlmToolDef` (Task 3) match usage in Tasks 5, 6, 9; `ReadQuery`/`WriteQuery`/`ObjectSchema` (Task 1) match usage across Tasks 6–9; `AgentTurnResult`/`TurnInput` (Task 1) match production/consumption in Task 9 and the Task 10 integration test.

---

**Plan complete and saved to `docs/plans/2026-07-09-core-library-implementation.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
