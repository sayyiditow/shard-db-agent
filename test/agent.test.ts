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
  max_value: 100,
  slot_size: 128,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
  ],
  indexes: ['category'],
  record_count: 10,
};

const lineItemsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'line_items',
  splits: 8,
  max_key: 64,
  max_value: 200,
  slot_size: 232,
  fields: [
    { name: 'description', type: 'varchar', size: 80 },
    { name: 'qty', type: 'double' },
    { name: 'unit_price', type: 'double' },
    { name: 'total', type: 'double' },
  ],
  indexes: [],
  record_count: 0,
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
    expect(toolMessage?.content).toBe(JSON.stringify({ outcome: 'committed', error: null, write: proposed.body }));
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
