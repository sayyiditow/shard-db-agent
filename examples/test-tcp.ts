import { ShardDbClient } from './tcp-client';

const host = process.env.SHARD_DB_HOST ?? 'localhost';
const port = parseInt(process.env.SHARD_DB_PORT ?? '9199', 10);

async function main() {
  console.log(`Connecting to shard-db at ${host}:${port}...`);
  const client = new ShardDbClient(host, port);

  try {
    // Test 1: describe-object
    console.log('\n--- describe-object ---');
    const schema = await client.query({
      mode: 'describe-object',
      dir: 'landscaping',
      object: 'materials',
    });
    console.log(JSON.stringify(schema, null, 2));

    // Test 2: find_records
    console.log('\n--- find_records ---');
    const results = await client.query({
      mode: 'find',
      dir: 'landscaping',
      object: 'materials',
      criteria: [],
    });
    console.log(JSON.stringify(results, null, 2));

    // Test 3: count
    console.log('\n--- count ---');
    const count = await client.query({
      mode: 'count',
      dir: 'landscaping',
      object: 'materials',
      criteria: [],
    });
    console.log(JSON.stringify(count, null, 2));

    console.log('\nAll tests passed.');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
