import { describe, test, expect } from 'bun:test';
import { Agent } from '../src/agent';
import { FakeLlmClient } from './fixtures/fake-llm-client';
import { InvalidStateError, LlmToolCallRejectedError } from '../src/errors';
import { deserializeState, getSchema, STALE_TOOL_RESULT_MARKER } from '../src/state';
import type { ObjectSchema } from '../src/types';
import type { LlmClient, LlmCompleteParams, LlmMessage, LlmToolCall } from '../src/llm-client';

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

function listObjectsToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'list_objects', arguments: JSON.stringify(args) } };
}

function writeToolCall(id: string, args: unknown): LlmToolCall {
  return { id, type: 'function', function: { name: 'propose_write', arguments: JSON.stringify(args) } };
}

describe('Agent.turn', () => {
  test('throws when state is null and no schema is provided', async () => {
    const agent = new Agent({ llmClient: new FakeLlmClient([]) });
    await expect(agent.turn(null, 'hello')).rejects.toThrow(/schema is required/);
  });

  test('turn() accepts an array of schemas on the bootstrap call and caches all of them', async () => {
    const llm = new FakeLlmClient([{ role: 'assistant', content: 'ok' }]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'hi', [materialsSchema, lineItemsSchema]);

    const data = deserializeState((result as { state: string }).state);
    expect(getSchema(data, 'landscaping', 'materials')).toEqual(materialsSchema);
    expect(getSchema(data, 'landscaping', 'line_items')).toEqual(lineItemsSchema);
  });

  test('turn() accepts an array of schemas on a later call and merges them into existing state', async () => {
    const llm = new FakeLlmClient([
      { role: 'assistant', content: 'ok' },
      { role: 'assistant', content: 'ok2' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const turn1 = await agent.turn(null, 'hi', materialsSchema);
    const turn2 = await agent.turn((turn1 as { state: string }).state, 'more', [lineItemsSchema]);

    const data = deserializeState((turn2 as { state: string }).state);
    expect(getSchema(data, 'landscaping', 'materials')).toEqual(materialsSchema);
    expect(getSchema(data, 'landscaping', 'line_items')).toEqual(lineItemsSchema);
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

  test('propose_write for an unknown object retries; model recovers on next attempt', async () => {
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
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w2', {
            summary: 'Add a line item',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });
    const result = await agent.turn(null, 'add it', lineItemsSchema);

    expect(result.kind).toBe('proposed_write');
    if (result.kind !== 'proposed_write') throw new Error('expected proposed_write');
    expect(result.body.dir).toBe('landscaping');
    expect(result.body.object).toBe('line_items');
    expect(llm.callCount).toBe(2);
  });

  test('propose_write with an invalid field retries; model recovers on next attempt', async () => {
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
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w2', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });
    const result = await agent.turn(null, 'add it', lineItemsSchema);

    expect(result.kind).toBe('proposed_write');
    if (result.kind !== 'proposed_write') throw new Error('expected proposed_write');
    expect(result.body.dir).toBe('landscaping');
    expect(result.body.object).toBe('line_items');
    expect(llm.callCount).toBe(2);
  });

  test('propose_write that never becomes valid exhausts iterations and throws', async () => {
    const bad: LlmMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: 'assistant' as const,
      content: null,
      tool_calls: [writeToolCall(`call_${i}`, {
        summary: 'bad',
        body: { mode: 'insert', dir: 'landscaping', object: 'never_described', value: {} },
      })],
    }));
    const llm = new FakeLlmClient(bad);
    const agent = new Agent({
      llmClient: llm,
      maxToolIterations: 5,
    });

    await expect(agent.turn(null, 'add it', lineItemsSchema)).rejects.toThrow(
      /exceeded max tool-use iterations/,
    );
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

  test('llmMs measures only LLM completion time, not executor time', async () => {
    const llm = new FakeLlmClient(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
        },
        { role: 'assistant', content: 'Versa-Lok is $6.85/sqft.' },
      ],
      { delayMs: 30 },
    );
    const agent = new Agent({
      llmClient: llm,
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [{ name: 'Versa-Lok', unit_price: 6.85 }];
      },
    });

    const result = await agent.turn(null, 'What does Versa-Lok cost?', materialsSchema);

    expect(result.kind).toBe('answer');
    // Two LLM calls each delayed ~30ms -> at least ~55ms of llmMs.
    expect(result.llmMs).toBeGreaterThanOrEqual(55);
    // The 150ms executor delay must not be counted -- well under 30+30+150.
    expect(result.llmMs).toBeLessThan(140);
  });

  test('a very large executor result is truncated before entering the conversation', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
      { role: 'assistant', content: 'done' },
    ]);
    const bigResult = Array.from({ length: 5000 }, (_, i) => ({ name: `item_${i}`, unit_price: i }));
    const agent = new Agent({ llmClient: llm, executor: async () => bigResult, maxToolResultChars: 500 });

    await agent.turn(null, 'find everything', materialsSchema);

    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.tool_call_id === 'call_1');
    expect(toolMessage?.content).toBeDefined();
    expect((toolMessage?.content as string).length).toBeLessThan(700);
    expect(toolMessage?.content).toContain('truncated');
  });

  test('pruneStaleToolResults runs every iteration, not just once before the first', async () => {
    const llm = new FakeLlmClient([
      { role: 'assistant', content: null, tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })] },
      { role: 'assistant', content: null, tool_calls: [findToolCall('call_2', { dir: 'landscaping', object: 'materials', criteria: [] })] },
      { role: 'assistant', content: null, tool_calls: [findToolCall('call_3', { dir: 'landscaping', object: 'materials', criteria: [] })] },
      { role: 'assistant', content: 'done' },
    ]);
    const agent = new Agent({ llmClient: llm, executor: async () => [{ name: 'x' }], maxRetainedToolResults: 1 });

    await agent.turn(null, 'find repeatedly', materialsSchema);

    const finalMessages = llm.callAt(3).messages;
    const toolMessages = finalMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0].content).toBe(STALE_TOOL_RESULT_MARKER);
    expect(toolMessages[1].content).toBe(STALE_TOOL_RESULT_MARKER);
    expect(toolMessages[2].content).not.toBe(STALE_TOOL_RESULT_MARKER);
  });

  test('with an executor, multiple read tool calls in the same message run concurrently, not serially', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] }),
          findToolCall('call_2', { dir: 'landscaping', object: 'materials', criteria: [] }),
        ],
      },
      { role: 'assistant', content: 'done' },
    ]);
    const agent = new Agent({
      llmClient: llm,
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [];
      },
    });

    const start = Date.now();
    await agent.turn(null, 'find twice', materialsSchema);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(250);
  });

  test('a describe_object result that resolves to a plain string does not crash the turn', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_describe', type: 'function', function: { name: 'describe_object', arguments: JSON.stringify({ dir: 'landscaping', object: 'ghost' }) } },
        ],
      },
      { role: 'assistant', content: 'that object does not exist' },
    ]);
    const agent = new Agent({ llmClient: llm, executor: async () => 'object not found' });

    const result = await agent.turn(null, 'describe ghost', materialsSchema);
    expect(result.kind).toBe('answer');
  });

  test('a describe_object result missing required schema fields is not cached, leaving the real schema untouched', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_describe', type: 'function', function: { name: 'describe_object', arguments: JSON.stringify({ dir: 'landscaping', object: 'materials' }) } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ]);
    const agent = new Agent({ llmClient: llm, executor: async () => ({ dir: 'landscaping', object: 'materials' }) });

    const result = await agent.turn(null, 'describe materials', materialsSchema);
    expect(result.kind).toBe('answer');
    const data = deserializeState((result as { state: string }).state);
    expect(getSchema(data, 'landscaping', 'materials')).toEqual(materialsSchema);
  });

  test('in host-execution mode (no executor), a describe_object query_result caches the schema for the next turn', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_describe', type: 'function', function: { name: 'describe_object', arguments: JSON.stringify({ dir: 'landscaping', object: 'line_items' }) } },
        ],
      },
      { role: 'assistant', content: 'ok, I know line_items now' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const turn1 = await agent.turn(null, 'tell me about line_items', materialsSchema);
    expect(turn1.kind).toBe('query_request');
    if (turn1.kind !== 'query_request') throw new Error('expected query_request');

    const turn2 = await agent.turn(turn1.state, null, undefined, [
      { kind: 'query_result', id: turn1.queries[0].id, data: lineItemsSchema },
    ]);
    expect(turn2.kind).toBe('answer');

    const data = deserializeState(turn2.state);
    expect(getSchema(data, 'landscaping', 'line_items')).toEqual(lineItemsSchema);
  });

  test('a propose_write call alongside a sibling read call still answers the read call instead of leaving it dangling', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_write', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
          findToolCall('call_extra_read', { dir: 'landscaping', object: 'materials', criteria: [] }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'add it', lineItemsSchema);
    expect(result.kind).toBe('proposed_write');

    const data = deserializeState((result as { state: string }).state);
    const extraReadAnswer = data.messages.find((m) => m.tool_call_id === 'call_extra_read');
    expect(extraReadAnswer).toBeDefined();
    expect(extraReadAnswer?.content).toContain('not executed');
  });

  test('a second propose_write call in the same message is answered with an error, not silently dropped', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_write_1', {
            summary: 'first',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
          writeToolCall('call_write_2', {
            summary: 'second',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'y', qty: 1, unit_price: 1, total: 1 } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'add two things', lineItemsSchema);
    expect(result.kind).toBe('proposed_write');

    const data = deserializeState((result as { state: string }).state);
    const secondAnswer = data.messages.find((m) => m.tool_call_id === 'call_write_2');
    expect(secondAnswer).toBeDefined();
    expect(secondAnswer?.content).toContain('error');
  });

  test('an unrecognized tool name is answered with an error instead of silently dropped', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_unknown', type: 'function', function: { name: 'delete_everything', arguments: '{}' } }],
      },
      { role: 'assistant', content: 'ok' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'do something weird', materialsSchema);
    expect(result.kind).toBe('answer');
    expect(llm.callCount).toBe(2);
    const toolMessage = llm.callAt(1).messages.find((m) => m.tool_call_id === 'call_unknown');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain('error');
  });

  test('a well-formed but wrong-shaped propose_write tool call (missing body) does not crash the turn', async () => {
    const llm = new FakeLlmClient([
      { role: 'assistant', content: null, tool_calls: [writeToolCall('call_w_bad', { summary: 'x' })] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w_good', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'add it', lineItemsSchema);
    expect(result.kind).toBe('proposed_write');
    expect(llm.callCount).toBe(2);
    const toolMessage = llm.callAt(1).messages.find((m) => m.tool_call_id === 'call_w_bad');
    expect(toolMessage?.content).toContain('error');
  });

  test('a provider tool_use_failed rejection is caught and fed back to the model instead of crashing the turn', async () => {
    class RejectingThenOkLlmClient implements LlmClient {
      calls = 0;
      async complete(_params: LlmCompleteParams): Promise<LlmMessage> {
        this.calls++;
        if (this.calls === 1) {
          throw new LlmToolCallRejectedError('rejected', { providerCode: 'tool_use_failed', providerMessage: 'bad op' });
        }
        return { role: 'assistant', content: 'Recovered — there are 10 materials.' };
      }
    }
    const llm = new RejectingThenOkLlmClient();
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'how many materials', materialsSchema);

    expect(result.kind).toBe('answer');
    expect(llm.calls).toBe(2);
  });

  test('repeated tool_use_failed rejections eventually exhaust max iterations and throw, instead of looping forever', async () => {
    class AlwaysRejectingLlmClient implements LlmClient {
      async complete(): Promise<LlmMessage> {
        throw new LlmToolCallRejectedError('rejected', { providerCode: 'tool_use_failed' });
      }
    }
    const agent = new Agent({ llmClient: new AlwaysRejectingLlmClient(), maxToolIterations: 3 });
    await expect(agent.turn(null, 'test', materialsSchema)).rejects.toThrow(/exceeded max tool-use iterations/);
  });

  test('a malformed (truncated) read tool call does not crash the turn; the LLM gets an error and can retry', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_bad', type: 'function', function: { name: 'count_records', arguments: '{"dir":"landsc' } },
        ],
      },
      { role: 'assistant', content: 'Sorry, let me try that again — there are 10 materials.' },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'how many materials do we have', materialsSchema);

    expect(result.kind).toBe('answer');
    expect(llm.callCount).toBe(2);
    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.tool_call_id === 'call_bad');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain('error');
  });

  test('a malformed read tool call alongside a valid one: the valid one still executes via the executor', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_bad', type: 'function', function: { name: 'count_records', arguments: '{"dir":' } },
          findToolCall('call_good', { dir: 'landscaping', object: 'materials', criteria: [] }),
        ],
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
    const secondCallMessages = llm.callAt(1).messages;
    expect(secondCallMessages.find((m) => m.tool_call_id === 'call_bad')?.content).toContain('error');
    expect(secondCallMessages.find((m) => m.tool_call_id === 'call_good')?.content).toBe(
      JSON.stringify([{ name: 'Versa-Lok', unit_price: 6.85 }]),
    );
  });

  test('a malformed propose_write tool call does not crash the turn; the LLM gets an error and can retry', async () => {
    const llm = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_w_bad', type: 'function', function: { name: 'propose_write', arguments: '{"summary":"x","bod' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          writeToolCall('call_w_good', {
            summary: 'Add a thing',
            body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { description: 'x', qty: 1, unit_price: 1, total: 1 } },
          }),
        ],
      },
    ]);
    const agent = new Agent({ llmClient: llm });

    const result = await agent.turn(null, 'add it', lineItemsSchema);

    expect(result.kind).toBe('proposed_write');
    expect(llm.callCount).toBe(2);
    const secondCallMessages = llm.callAt(1).messages;
    const toolMessage = secondCallMessages.find((m) => m.tool_call_id === 'call_w_bad');
    expect(toolMessage?.content).toContain('error');
  });

  test('llmMs is a non-negative number on query_request and proposed_write results too', async () => {
    const llmForQuery = new FakeLlmClient([
      {
        role: 'assistant',
        content: null,
        tool_calls: [findToolCall('call_1', { dir: 'landscaping', object: 'materials', criteria: [] })],
      },
    ]);
    const queryAgent = new Agent({ llmClient: llmForQuery });
    const queryResult = await queryAgent.turn(null, 'find stuff', materialsSchema);
    expect(queryResult.kind).toBe('query_request');
    expect(typeof queryResult.llmMs).toBe('number');
    expect(queryResult.llmMs).toBeGreaterThanOrEqual(0);

    const llmForWrite = new FakeLlmClient([
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
    ]);
    const writeAgent = new Agent({ llmClient: llmForWrite });
    const writeResult = await writeAgent.turn(null, 'add it', lineItemsSchema);
    expect(writeResult.kind).toBe('proposed_write');
    expect(typeof writeResult.llmMs).toBe('number');
    expect(writeResult.llmMs).toBeGreaterThanOrEqual(0);
  });
});
