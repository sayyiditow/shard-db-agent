import { Agent, type ObjectSchema } from '../src/index';
import { ShardDbClient } from './tcp-client';
import * as readline from 'readline';

const LLM_URL = process.env.LLM_URL ?? 'http://localhost:11434/v1';
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen2.5:14b';
const LLM_API_KEY = process.env.LLM_API_KEY;
const SHARD_DB_HOST = process.env.SHARD_DB_HOST ?? 'localhost';
const SHARD_DB_PORT = parseInt(process.env.SHARD_DB_PORT ?? '9199', 10);

const MATERIALS_SCHEMA: ObjectSchema = {
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
    { name: 'category', type: 'varchar', size: 40 },
  ],
  indexes: ['category'],
  record_count: 0,
};

const LINE_ITEMS_SCHEMA: ObjectSchema = {
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  max_value: 200,
  slot_size: 232,
  fields: [
    { name: 'estimate_id', type: 'long' },
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit', type: 'varchar', size: 10 },
    { name: 'unit_price', type: 'double' },
    { name: 'total', type: 'double' },
  ],
  indexes: [],
  record_count: 0,
};

async function ensureObject(client: ShardDbClient, schema: ObjectSchema) {
  const fields = schema.fields.map((f) => {
    const parts = [f.name, f.type];
    if (f.size) parts.push(String(f.size));
    if (f.precision && f.scale) parts.push(`${f.precision},${f.scale}`);
    return parts.join(':');
  });

  await client.query({
    mode: 'create-object',
    dir: schema.dir,
    object: schema.object,
    splits: schema.splits,
    max_key: schema.max_key,
    fields,
    indexes: schema.indexes,
    if_not_exists: true,
  });
}

async function seedMaterials(client: ShardDbClient) {
  const materials = [
    { key: 'mat_1', name: 'Versa-Lok Standard', unit_price: 6.85, unit: 'sqft', category: 'retaining_wall_block' },
    { key: 'mat_2', name: 'Belgard Sahara', unit_price: 7.20, unit: 'sqft', category: 'retaining_wall_block' },
    { key: 'mat_3', name: 'Paver Base Gravel', unit_price: 0.45, unit: 'sqft', category: 'base_material' },
  ];

  for (const m of materials) {
    await client.query({
      mode: 'insert',
      dir: 'landscaping',
      object: 'materials',
      key: m.key,
      value: { name: m.name, unit_price: m.unit_price, unit: m.unit, category: m.category },
      if_not_exists: true,
    });
  }
}

function buildExecutor(client: ShardDbClient) {
  return async (query: Record<string, unknown>): Promise<unknown> => {
    const result = await client.query(query);
    return result;
  };
}

async function main() {
  console.log('shard-db-agent — landscaping example');
  console.log('─'.repeat(50));
  console.log(`LLM:    ${LLM_MODEL} @ ${LLM_URL}`);
  console.log(`Auth:   ${LLM_API_KEY ? 'API key provided' : 'no API key (local LLM)'}`);
  console.log(`DB:     ${SHARD_DB_HOST}:${SHARD_DB_PORT}`);
  console.log('─'.repeat(50));
  console.log();

  // Connect to shard-db
  const client = new ShardDbClient(SHARD_DB_HOST, SHARD_DB_PORT);
  try {
    await client.query({ mode: 'count', dir: 'default', object: 'x', criteria: [] });
  } catch (err) {
    console.error('Cannot connect to shard-db. Is it running?');
    console.error(`  cd ../shard-db && source db.env && ./shard-db server`);
    process.exit(1);
  }

  // Create objects
  console.log('Setting up objects...');
  await ensureObject(client, MATERIALS_SCHEMA);
  await ensureObject(client, LINE_ITEMS_SCHEMA);

  // Seed data
  console.log('Seeding materials...');
  await seedMaterials(client);
  console.log();

  // Create agent
  const agent = new Agent({
    baseUrl: LLM_URL,
    model: LLM_MODEL,
    apiKey: LLM_API_KEY,
    executor: buildExecutor(client),
  });

  // Interactive REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let state: string | null = null;
  const schemas: Record<string, ObjectSchema> = {
    'landscaping/materials': MATERIALS_SCHEMA,
    'landscaping/line_items': LINE_ITEMS_SCHEMA,
  };

  const prompt = () => new Promise<string>((resolve) => rl.question('shard-db-agent (landscaping) > ', resolve));

  console.log('Type a message to start. Type "exit" to quit.');
  console.log();

  try {
    while (true) {
      const input = (await prompt()).trim();

      if (!input) continue;
      if (input === 'exit' || input === 'quit') break;

      console.log();
      console.log('Agent is thinking...');

      // Collect schemas to pass on first turn
      const schemaValues = Object.values(schemas);

      const turn = await agent.turn(state, input, schemaValues[0]);

      // Update state
      state = turn.state;

      console.log(`(thought for ${turn.llmMs}ms)`);

      // Log the result kind for debugging
      if (turn.kind === 'query_request') {
        console.log(`[query_request: ${turn.queries.length} query/ies]`);
      }

      // Handle answer
      if (turn.kind === 'answer') {
        console.log();
        console.log(`Agent: ${turn.text}`);
        console.log();
        continue;
      }

      // Handle proposed_write — pause for confirmation
      if (turn.kind === 'proposed_write') {
        console.log();
        console.log('[Proposed write]');
        console.log(`  → ${turn.summary}`);
        console.log(`  → Object: ${turn.body.dir}/${turn.body.object}`);
        console.log(`  → Mode: ${turn.body.mode}`);
        if (turn.body.mode === 'insert' || turn.body.mode === 'update') {
          console.log(`  → Key: ${turn.body.key ?? '(generated on commit)'}`);
          console.log(`  → Value: ${JSON.stringify(turn.body.value)}`);
        } else {
          console.log(`  → Key: ${turn.body.key}`);
        }
        console.log();

        const confirm = await new Promise<string>((resolve) =>
          rl.question('Type "yes" to confirm, or anything else to cancel: ', resolve),
        );

        const outcome = confirm.trim().toLowerCase() === 'yes' ? 'committed' : 'rejected';

        // Execute the write if confirmed
        if (outcome === 'committed') {
          await client.query(turn.body as Record<string, unknown>);
        }

        // Feed outcome back to agent
        const followUp = await agent.turn(state, null, undefined, [
          { kind: 'write_outcome', pendingId: turn.pendingId, outcome },
        ]);

        state = followUp.state;

        console.log(`(thought for ${followUp.llmMs}ms)`);
        console.log();
        if (followUp.kind === 'answer') {
          console.log(`Agent: ${followUp.text}`);
        } else {
          console.log(`[Agent returned ${followUp.kind} — unexpected at this point]`);
        }
        console.log();
        continue;
      }
    }
  } finally {
    rl.close();
    client.close();
    console.log('Goodbye.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
