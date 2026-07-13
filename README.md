# shard-db-agent

[![npm version](https://img.shields.io/npm/v/shard-db-agent)](https://www.npmjs.com/package/shard-db-agent)
[![License](https://img.shields.io/npm/l/shard-db-agent)](LICENSE)

A stateful, schema-agnostic natural-language agent for [shard-db](https://github.com/sayyiditow/shard-db). Describe what you want in plain English; get back a proposed query or write instead of hand-writing JSON or NQL.

## What it does

shard-db-agent translates natural language into structured queries and writes against any shard-db object. It holds conversation state across turns, asks clarifying questions when information is missing, and always proposes writes for explicit confirmation — never executing anything against shard-db itself.

```
User: "I'm at the Simmons property, they want a block retaining wall,
       about 40 feet long, 3 feet high."

Agent → query_request: find retaining_wall_block materials

App runs query, returns price data.

Agent → proposed_write: Add block retaining wall, 120 sqft @ $6.85 = $822.00. Confirm?

User: "Yes"

App executes the insert, tells agent it committed.

Agent → answer: Added to the estimate. Anything else?
```

## Install

```bash
bun add shard-db-agent
```

Or with npm:

```bash
npm install shard-db-agent
```

## Quick start

```typescript
import { Agent, type ObjectSchema } from 'shard-db-agent';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  max_value: 142,
  slot_size: 168,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
  ],
  indexes: ['category'],
  record_count: 0,
};

// Create an agent pointing at a local LLM (OpenAI-compatible endpoint)
const agent = new Agent({
  baseUrl: 'http://localhost:8080/v1',
  model: 'qwen2.5-14b',
});

// First turn — pass the schema since state is null
const turn1 = await agent.turn(
  null,
  "What does Versa-Lok retaining wall block cost per square foot?",
  materialsSchema,
);

// turn1.kind === 'query_request'
// turn1.queries = [{ id: 'call_xxx', query: { mode: 'find', dir: 'landscaping', object: 'materials', ... } }]
```

## How the conversation loop works

shard-db-agent is a **turn-based** library. Each call to `agent.turn()` takes the current state, user text, and any inputs from the previous turn, and returns one of three result kinds:

| Result kind | What it means | Your app does |
|-------------|---------------|---------------|
| `query_request` | Agent wants to read data | Run the queries on your shard-db connection, pass results back via `turnInputs` |
| `proposed_write` | Agent wants to write data | Show the summary to the user, execute the write yourself on confirmation, tell the agent the outcome |
| `answer` | Agent has a text response | Display it to the user |

### Running queries yourself (no executor)

```typescript
// 1. Agent asks for data
const turn1 = await agent.turn(state, "What materials do we have for retaining walls?", materialsSchema);
// turn1.kind === 'query_request'

// 2. You run the queries on your own shard-db connection
const results = await shardDb.query(turn1.queries[0].query);

// 3. Pass results back to the agent
const turn2 = await agent.turn(turn1.state, null, undefined, [
  { kind: 'query_result', id: turn1.queries[0].id, data: results },
]);
// turn2.kind === 'answer' or 'proposed_write'
```

### Auto-executing reads with an executor callback

If you don't mind the agent running reads internally, pass an `executor`:

```typescript
const agent = new Agent({
  baseUrl: 'http://localhost:8080/v1',
  model: 'qwen2.5-14b',
  executor: async (query) => {
    // query is a ReadQuery — pass it straight to your shard-db client
    return await shardDb.query(query);
  },
});

// Now reads auto-run within a single turn() call
const turn = await agent.turn(null, "What's the total for the Simmons estimate?", materialsSchema);
// turn.kind === 'answer' (agent got the data, computed, and answered in one call)
```

**Writes are never auto-executed** — even with an executor, the agent always surfaces `proposed_write` for you to confirm.

### Handling proposed writes

```typescript
const turn = await agent.turn(state, "Add a block retaining wall to the Simmons estimate", lineItemsSchema);
// turn.kind === 'proposed_write'
// turn.summary → "Add: Block retaining wall, 120 sqft @ $6.85 = $822.00"
// turn.body → { mode: 'insert', dir: 'landscaping', object: 'line_items', key: '<minted-uuid>', value: {...} }
// turn.pendingId → 'p1' (use this to track the write)

// 1. Show summary to user, wait for confirmation
// 2. Execute the write yourself:
await shardDb.query(turn.body);

// 3. Tell the agent it was committed:
const followUp = await agent.turn(turn.state, null, undefined, [
  { kind: 'write_outcome', pendingId: turn.pendingId, outcome: 'committed' },
]);
```

For retries and idempotency: the agent mints a deterministic key for inserts. If the user double-confirms or a network retry happens, the same `pendingId` produces the same key, so `if_not_exists` naturally no-ops on duplicates.

## Multi-turn conversation

The `state` string is opaque — treat it as a blob. Pass it back on every subsequent turn:

```typescript
let state: string | null = null;
let schema: ObjectSchema | undefined = materialsSchema; // only needed on first turn

// Turn 1
const t1 = await agent.turn(state, "What's the price of retaining wall blocks?", schema);
state = t1.state;
// ... handle t1 ...

// Turn 2 — schema is optional on subsequent turns (agent remembers)
const t2 = await agent.turn(state, "Add 120 sqft to the Simmons estimate", lineItemsSchema);
state = t2.state;
// ... handle t2 ...

// Turn 3
const t3 = await agent.turn(state, "What's the total so far?");
state = t3.state;
// ...
```

## Full example: landscaping estimate

```typescript
import { Agent, type ObjectSchema, type TurnInput } from 'shard-db-agent';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping', object: 'materials', splits: 8, max_key: 64, max_value: 142, slot_size: 168,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
  ],
  indexes: ['category'], record_count: 0,
};

const lineItemsSchema: ObjectSchema = {
  dir: 'landscaping', object: 'line_items', splits: 8, max_key: 64, max_value: 200, slot_size: 232,
  fields: [
    { name: 'estimate_id', type: 'long' },
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
    { name: 'unit_price', type: 'double' },
    { name: 'total', type: 'double' },
  ],
  indexes: [], record_count: 0,
};

const agent = new Agent({
  baseUrl: 'http://localhost:8080/v1',
  model: 'qwen2.5-14b',
  executor: async (query) => await shardDb.query(query),
});

// --- Turn 1: user describes the job ---
const t1 = await agent.turn(
  null,
  "I'm at the Simmons property, they want a block retaining wall, about 40 feet long, 3 feet high.",
  materialsSchema,
);

if (t1.kind === 'query_request') {
  // Agent is looking up material prices (auto-executed if executor configured)
  // For this example, assume executor ran it — or handle manually:
  // const results = await shardDb.query(t1.queries[0].query);
  // const t1b = await agent.turn(t1.state, null, undefined, [{ kind: 'query_result', id: t1.queries[0].id, data: results }]);
  // t1 = t1b;
}

// --- Turn 2: agent proposes the line item ---
const t2 = t1.kind === 'answer'
  ? await agent.turn(t1.state, "Add that to the estimate", lineItemsSchema)
  : t1;

if (t2.kind === 'proposed_write') {
  console.log(`Agent proposes: ${t2.summary}`);
  // → "Add: Block retaining wall, 120 sqft @ $6.85 = $822.00 to Simmons estimate. Confirm?"

  // User confirms — execute the write yourself:
  await shardDb.query(t2.body);

  // Tell the agent:
  const t3 = await agent.turn(t2.state, null, undefined, [
    { kind: 'write_outcome', pendingId: t2.pendingId, outcome: 'committed' },
  ]);

  if (t3.kind === 'answer') {
    console.log(t3.text);
    // → "Added and confirmed — anything else for the Simmons estimate?"
  }
}
```

## API

### `new Agent(options?)`

| Option | Type | Description |
|--------|------|-------------|
| `llmClient` | `LlmClient` | Custom LLM client (see [LLM client seam](#llm-client-seam)) |
| `baseUrl` | `string` | OpenAI-compatible API base URL (e.g. `http://localhost:8080/v1`) |
| `model` | `string` | Model name (e.g. `qwen2.5-14b`) |
| `apiKey` | `string` | Optional API key for the LLM endpoint |
| `executor` | `(query: ReadQuery) => Promise<unknown>` | Optional callback to auto-run read queries |
| `maxToolIterations` | `number` | Max tool-use loops per turn (default: 8) |
| `maxRetainedToolResults` | `number` | Most-recent tool results kept verbatim; older ones replaced with a stale marker (default: 4) |
| `maxToolResultChars` | `number` | Max characters of a single executor result's JSON before truncation (default: 20000) |

Either `llmClient` or both `baseUrl` + `model` are required.

### `agent.turn(state, text, schema?, turnInputs?)`

| Param | Type | Description |
|-------|------|-------------|
| `state` | `string \| null` | Previous turn's state, or `null` for a new session |
| `text` | `string \| null` | User's utterance, or `null` when only delivering `turnInputs` |
| `schema` | `ObjectSchema \| ObjectSchema[]?` | One or more `describe-object` schemas (required on first turn, optional after). Pass an array to seed multiple object types at once. |
| `turnInputs` | `TurnInput[]?` | Query results and/or write outcomes from the previous turn |

Returns `Promise<AgentTurnResult>` — one of `query_request`, `answer`, or `proposed_write`. All result kinds also include `llmMs: number` — the LLM response time in milliseconds for that turn.

### LLM client seam

Implement the `LlmClient` interface to use any LLM backend:

```typescript
import type { LlmClient, LlmCompleteParams, LlmMessage } from 'shard-db-agent';

const myClient: LlmClient = {
  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    // Your custom LLM integration
    return { role: 'assistant', content: '...' };
  },
};

const agent = new Agent({ llmClient: myClient });
```

### `mintKey(pendingId)`

Deterministic key for idempotent inserts. Maps a `pendingId` to the same key every call, so double-confirms and network retries produce a no-op duplicate.

```typescript
import { mintKey } from 'shard-db-agent';

const key = mintKey('p1'); // → same key every time for 'p1'
```

### Error handling

All failures throw:

- **`Error`** — LLM failure (timeout, bad response), executor failure, or max iterations exceeded
- **`LlmToolCallRejectedError`** — provider rejected a tool call (e.g. invalid arguments). The agent auto-retries, so this usually doesn't reach the host. Contains `providerMessage` for diagnostics.
- **`InvalidStateError`** — corrupted or version-mismatched state blob (start a fresh session)
- **`WriteValidationError`** — agent's proposed write failed schema validation (shouldn't reach host)

```typescript
import { Agent, InvalidStateError, LlmToolCallRejectedError, WriteValidationError } from 'shard-db-agent';

try {
  const result = await agent.turn(state, text, schema);
} catch (err) {
  if (err instanceof InvalidStateError) {
    // State is unrecoverable — start fresh with a new session
    state = null;
  } else if (err instanceof WriteValidationError) {
    // Agent proposed an invalid write — check err.issues
    console.error('Write validation failed:', err.issues);
  } else {
    // LLM or executor error — retry or show error to user
    console.error(err);
  }
}
```

## Design

See [`docs/plans/2026-07-06-shard-db-agent-design.md`](docs/plans/2026-07-06-shard-db-agent-design.md) for the full design spec (architecture, decisions, error handling, testing).

## License

MIT
