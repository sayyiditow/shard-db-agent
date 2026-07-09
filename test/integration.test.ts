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
