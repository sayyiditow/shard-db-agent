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
