# Interactive Example: Ollama + shard-db TCP

**Goal:** Add an interactive REPL example that demonstrates the full agent conversation flow against a real Ollama LLM and a real shard-db TCP instance.

**Prerequisites:**
- Ollama installed with `qwen2.5:14b` pulled (~9GB)
- shard-db running in TCP mode on port 9199

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `examples/README.md` | Create | Setup instructions (Ollama, shard-db, running the example) |
| `examples/tcp-client.ts` | Create | Thin TCP client for shard-db |
| `examples/landscaping.ts` | Create | Interactive REPL |
| `package.json` | Edit | Add `example` script |

---

## `examples/README.md`

Setup instructions:

1. **Ollama**
   ```bash
   ollama serve                    # if not already running
   ollama pull qwen2.5:14b         # ~9GB, one-time download
   ```

2. **shard-db**
   ```bash
   cd ../shard-db
   source db.env
   ./shard-db server                # foreground, port 9199
   ```

3. **Run the example**
   ```bash
   bun run example                  # from the agent repo root
   ```

4. **Env vars** (all have defaults)
   - `LLM_URL` — Ollama OpenAI-compat endpoint (default: `http://localhost:11434/v1`)
   - `LLM_MODEL` — model name (default: `qwen2.5:14b`)
   - `SHARD_DB_HOST` — shard-db host (default: `localhost`)
   - `SHARD_DB_PORT` — shard-db port (default: `9199`)

---

## `examples/tcp-client.ts`

Minimal TCP client matching shard-db's wire protocol:

- Wire format: newline-delimited JSON outbound, `\0\n`-terminated JSON inbound
- `query(request)` — send one JSON request, read until `\0`, parse response
- Uses `net.Socket`, no external deps
- Localhost needs no auth (trusted by default)

```typescript
import net from 'net';

export class ShardDbClient {
  constructor(host: string, port: number)
  async query(request: Record<string, unknown>): Promise<unknown>
  close(): void
}
```

---

## `examples/landscaping.ts`

### Startup sequence

1. Connect to shard-db TCP
2. Create `landscaping/materials` object (if_not_exists: true)
3. Create `landscaping/line_items` object (if_not_exists: true)
4. Seed 3 materials (Versa-Lok Standard, Belgard Sahara, Paver Base Gravel)
5. Create Agent with executor that runs queries via TCP client

### Object creation shapes

```typescript
// materials
{
  mode: 'create-object',
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  fields: [
    'name:varchar:80',
    'unit_price:double',
    'unit:varchar:10',
    'category:varchar:40',
  ],
  indexes: ['category'],
  if_not_exists: true,
}

// line_items
{
  mode: 'create-object',
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  fields: [
    'estimate_id:long',
    'description:varchar:80',
    'qty:double',
    'unit:varchar:10',
    'unit_price:double',
    'total:double',
  ],
  if_not_exists: true,
}
```

### Seeded data

```typescript
{ mode: 'insert', dir: 'landscaping', object: 'materials', key: 'mat_1',
  value: { name: 'Versa-Lok Standard', unit_price: 6.85, unit: 'sqft', category: 'retaining_wall_block' } }
{ mode: 'insert', dir: 'landscaping', object: 'materials', key: 'mat_2',
  value: { name: 'Belgard Sahara', unit_price: 7.20, unit: 'sqft', category: 'retaining_wall_block' } }
{ mode: 'insert', dir: 'landscaping', object: 'materials', key: 'mat_3',
  value: { name: 'Paver Base Gravel', unit_price: 0.45, unit: 'sqft', category: 'base_material' } }
```

### Interactive REPL loop

```
shard-db-agent (landscaping) > [user types here]

Agent is thinking...
[debug: auto-ran find_records → 3 results]

shard-db-agent (landscaping) >
```

Result handling:
- `query_request` — executor auto-runs, prints debug, loops internally
- `proposed_write` — prints summary, pauses for Enter/reject, executes or rejects, feeds outcome back
- `answer` — prints text, prompts for next input
- `exit`/`quit` — exits
- Ctrl+C — exits

### Proposed write pause behavior

```
[Proposed write]
  → Add: Block retaining wall, 120 sqft @ $6.85 = $822.00
  → Object: landscaping/line_items
  → Mode: insert

Press Enter to confirm, or type 'reject' to cancel: _
```

- Enter → execute the write, feed `committed` outcome back
- Type `reject` → feed `rejected` outcome back
- The agent then responds with the acknowledgment

---

## `package.json`

Add to scripts:
```json
"example": "bun run examples/landscaping.ts"
```

---

## `describe-object` handling

The executor returns shard-db's native `describe-object` response. Our `ObjectSchema` type matches this shape exactly — no translation needed:

```typescript
// shard-db returns → our ObjectSchema accepts
{
  dir: string,
  object: string,
  splits: number,
  max_key: number,
  value_size: number,
  fields: FieldDescriptor[],
  indexes: string[],
  counts: { live: number, tombstoned: number }
}
```

---

## Execution order

1. Write plan to `docs/plans/2026-07-09-interactive-example.md`
2. Create `examples/README.md`
3. Create `examples/tcp-client.ts`
4. Create `examples/landscaping.ts`
5. Update `package.json`
6. Test with `bun run example` (requires Ollama + shard-db running)
