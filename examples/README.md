# shard-db-agent Examples

## Prerequisites

### 1. Ollama (LLM runtime)

Install Ollama from [ollama.com](https://ollama.com), then pull the recommended model:

```bash
ollama serve                    # start the server (if not already running)
ollama pull qwen2.5:14b         # ~9GB, one-time download
```

The agent talks to Ollama via its OpenAI-compatible endpoint at `http://localhost:11434/v1`.

### 2. shard-db (database)

Start shard-db in TCP mode:

```bash
cd ../shard-db                  # navigate to your shard-db install
source db.env                   # load environment (PORT, DB_ROOT, etc.)
./shard-db server               # foreground — port 9199 by default
```

Verify it's running:

```bash
echo '{"mode":"count","dir":"default","object":"anything","criteria":[]}' | nc -q1 localhost 9199
```

### 3. Run the example

From the shard-db-agent repo root:

```bash
bun run example
```

Or directly:

```bash
bun run examples/landscaping.ts
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_URL` | `http://localhost:11434/v1` | LLM endpoint (OpenAI-compatible) |
| `LLM_MODEL` | `qwen2.5:14b` | Model to use |
| `LLM_API_KEY` | _(none)_ | API key for remote LLM endpoints |
| `SHARD_DB_HOST` | `localhost` | shard-db TCP host |
| `SHARD_DB_PORT` | `9199` | shard-db TCP port |

### Remote LLM (OpenCode Zen)

Use OpenCode's hosted endpoint for faster responses without running a local LLM:

```bash
LLM_URL=https://opencode.ai/zen/v1 LLM_MODEL=mimo-v2.5-free LLM_API_KEY=your-key bun run example
```

Available free models: `mimo-v2.5-free`, `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, `north-mini-code-free`.

### MiMo (Xiaomi)

```bash
LLM_URL=https://api.xiaomimimo.com/v1 LLM_MODEL=mimo-v2.5 LLM_API_KEY=your-mimo-key bun run example
```

### Local Ollama

```bash
LLM_MODEL=qwen2.5:14b bun run example
```

## What the example does

The landscaping example walks through a realistic conversation:

1. **Creates objects** — `landscaping/materials` and `landscaping/line_items` in shard-db
2. **Seeds data** — 3 materials (retaining wall blocks, gravel)
3. **Starts an interactive REPL** — you type natural language, the agent responds

### REPL commands

- Type any message to talk to the agent
- When the agent proposes a write, press **Enter** to confirm or type **reject** to cancel
- Type **exit** or **quit** to stop
- **Ctrl+C** to exit

### Example session

```
shard-db-agent (landscaping) > What materials do we have for retaining walls?

Agent is thinking...
[Auto-ran: find_records landscaping/materials where category = retaining_wall_block]
[Found 2 results]

Agent: We have two retaining wall block options:
  1. Versa-Lok Standard — $6.85/sqft
  2. Belgard Sahara — $7.20/sqft

shard-db-agent (landscaping) > Add 120 sqft of Versa-Lok to the Simmons estimate

Agent is thinking...

[Proposed write]
  → Add: Block retaining wall, 120 sqft @ $6.85 = $822.00
  → Object: landscaping/line_items
  → Mode: insert

Press Enter to confirm, or type 'reject' to cancel:

[Committed]
Agent: Added to the Simmons estimate — anything else?

shard-db-agent (landscaping) > exit
```

## TCP vs Embedded mode

The example uses **TCP mode** (connecting to shard-db over the network). The agent works identically with **embedded mode** — only the `executor` callback changes:

```typescript
// TCP (this example)
const client = new ShardDbClient('localhost', 9199);
executor: async (query) => client.query(query)

// Embedded (alternative)
import ShardDb from 'shard-db';
const db = new ShardDb('/path/to/data');
executor: async (query) => JSON.parse(await db.query(query))
```

The agent code is identical. The `executor` abstracts the transport.
