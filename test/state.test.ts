import { describe, test, expect } from 'bun:test';
import {
  createInitialSessionData,
  cacheSchema,
  getSchema,
  serializeState,
  deserializeState,
  applyTurnInputs,
  pruneStaleToolResults,
  STALE_TOOL_RESULT_MARKER,
} from '../src/state';
import { InvalidStateError } from '../src/errors';
import type { ObjectSchema } from '../src/types';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  max_value: 100,
  slot_size: 128,
  fields: [{ name: 'name', type: 'varchar', size: 80 }],
  indexes: [],
  record_count: 10,
};

const lineItemsSchema: ObjectSchema = { ...materialsSchema, object: 'line_items' };

describe('state', () => {
  test('createInitialSessionData seeds schemas with the bootstrap schema', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(data.version).toBe(2);
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

  test('createInitialSessionData seeds an empty pendingDescribeQueries map', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(data.pendingDescribeQueries).toEqual({});
  });

  test('schemaKey does not collide when a dir/object pair contains the "/" separator itself', () => {
    const dataA = createInitialSessionData({ ...materialsSchema, dir: 'a/b', object: 'c' });
    cacheSchema(dataA, { ...materialsSchema, dir: 'a', object: 'b/c' });
    expect(getSchema(dataA, 'a/b', 'c')).toEqual({ ...materialsSchema, dir: 'a/b', object: 'c' });
    expect(getSchema(dataA, 'a', 'b/c')).toEqual({ ...materialsSchema, dir: 'a', object: 'b/c' });
  });

  test('applyTurnInputs caches the schema from a query_result answering a pending describe-object query', () => {
    const data = createInitialSessionData(materialsSchema);
    data.pendingDescribeQueries['call_describe_1'] = { dir: 'landscaping', object: 'line_items' };
    applyTurnInputs(data, [{ kind: 'query_result', id: 'call_describe_1', data: lineItemsSchema }]);
    expect(getSchema(data, 'landscaping', 'line_items')).toEqual(lineItemsSchema);
    expect(data.pendingDescribeQueries['call_describe_1']).toBeUndefined();
  });

  test('applyTurnInputs does not cache a query_result for an id with no pending describe-object query', () => {
    const data = createInitialSessionData(materialsSchema);
    applyTurnInputs(data, [{ kind: 'query_result', id: 'call_find_1', data: [{ name: 'x' }] }]);
    expect(getSchema(data, 'landscaping', 'line_items')).toBeUndefined();
  });

  test('serializeState / deserializeState round-trips', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push({ role: 'user', content: 'hello' });
    const state = serializeState(data);
    expect(deserializeState(state)).toEqual(data);
  });

  test('serializeState / deserializeState round-trips a message that has no content key (provider-returned assistant tool-call message)', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'find_records', arguments: '{}' } }],
    });
    const state = serializeState(data);
    const restored = deserializeState(state);
    expect(restored.messages[0].content).toBeUndefined();
    expect(restored.messages[0].tool_calls).toHaveLength(1);
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

  test('deserializeState throws InvalidStateError when a message has an invalid role', () => {
    const bad = Buffer.from(
      JSON.stringify({
        version: 1,
        schemas: {},
        pendingWrites: {},
        messages: [{ role: 'evil', content: 'x' }],
      }),
      'utf-8',
    ).toString('base64');
    expect(() => deserializeState(bad)).toThrow(InvalidStateError);
  });

  test('deserializeState throws InvalidStateError when a schemas entry is missing fields', () => {
    const bad = Buffer.from(
      JSON.stringify({
        version: 1,
        schemas: { 'a/b': { dir: 'a', object: 'b' } },
        pendingWrites: {},
        messages: [],
      }),
      'utf-8',
    ).toString('base64');
    expect(() => deserializeState(bad)).toThrow(InvalidStateError);
  });

  test('deserializeState throws InvalidStateError when a pendingWrites entry is malformed', () => {
    const bad = Buffer.from(
      JSON.stringify({
        version: 1,
        schemas: {},
        messages: [],
        pendingWrites: { p1: { notBody: true } },
      }),
      'utf-8',
    ).toString('base64');
    expect(() => deserializeState(bad)).toThrow(InvalidStateError);
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
    const writeBody = { mode: 'insert' as const, dir: 'landscaping', object: 'line_items', value: {} };
    data.pendingWrites['p1'] = {
      toolCallId: 'call_write_1',
      body: writeBody,
    };

    applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'p1', outcome: 'committed' }]);

    expect(data.pendingWrites['p1']).toBeUndefined();
    expect(data.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_write_1',
        content: JSON.stringify({ outcome: 'committed', error: null, write: writeBody }),
      },
    ]);
  });

  test('applyTurnInputs echoes the write body on a rejected outcome too', () => {
    const data = createInitialSessionData(materialsSchema);
    const writeBody = { mode: 'delete' as const, dir: 'landscaping', object: 'line_items', key: 'li_1' };
    data.pendingWrites['p2'] = {
      toolCallId: 'call_write_2',
      body: writeBody,
    };

    applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'p2', outcome: 'rejected' }]);

    expect(data.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_write_2',
        content: JSON.stringify({ outcome: 'rejected', error: null, write: writeBody }),
      },
    ]);
  });

  test('applyTurnInputs throws InvalidStateError for an unknown pendingId', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(() =>
      applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: 'does-not-exist', outcome: 'committed' }]),
    ).toThrow(InvalidStateError);
  });

  test('applyTurnInputs treats a "__proto__" pendingId as unknown rather than resolving to Object.prototype', () => {
    const data = createInitialSessionData(materialsSchema);
    expect(() =>
      applyTurnInputs(data, [{ kind: 'write_outcome', pendingId: '__proto__', outcome: 'committed' }]),
    ).toThrow(InvalidStateError);
    expect(Object.prototype).not.toHaveProperty('body');
  });

  test('pruneStaleToolResults leaves the most recent N tool messages untouched', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push(
      { role: 'user', content: 'q1' },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ n: 1 }) },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ n: 2 }) },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'tool', tool_call_id: 'c3', content: JSON.stringify({ n: 3 }) },
      { role: 'assistant', content: 'a3' },
    );

    pruneStaleToolResults(data, 2);

    expect(data.messages[1].content).toBe(STALE_TOOL_RESULT_MARKER);
    expect(data.messages[4].content).toBe(JSON.stringify({ n: 2 }));
    expect(data.messages[7].content).toBe(JSON.stringify({ n: 3 }));
  });

  test('pruneStaleToolResults leaves non-tool messages untouched', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push(
      { role: 'user', content: 'q1' },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ n: 1 }) },
      { role: 'assistant', content: 'a1' },
    );

    pruneStaleToolResults(data, 0);

    expect(data.messages[0]).toEqual({ role: 'user', content: 'q1' });
    expect(data.messages[2]).toEqual({ role: 'assistant', content: 'a1' });
  });

  test('pruneStaleToolResults is a no-op when tool message count is within the keep limit', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push(
      { role: 'user', content: 'q1' },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ n: 1 }) },
    );

    pruneStaleToolResults(data, 2);

    expect(data.messages[1].content).toBe(JSON.stringify({ n: 1 }));
  });

  test('pruneStaleToolResults is idempotent on already-pruned messages', () => {
    const data = createInitialSessionData(materialsSchema);
    data.messages.push(
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ n: 1 }) },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ n: 2 }) },
    );

    pruneStaleToolResults(data, 1);
    pruneStaleToolResults(data, 1);

    expect(data.messages[0].content).toBe(STALE_TOOL_RESULT_MARKER);
    expect(data.messages[1].content).toBe(JSON.stringify({ n: 2 }));
  });
});
