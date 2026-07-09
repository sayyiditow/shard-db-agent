import { describe, test, expect } from 'bun:test';
import { isReadQuery, isWriteQuery, type QueryBody } from '../src/types';

describe('isReadQuery / isWriteQuery', () => {
  test('find/count/aggregate/describe-object are read queries', () => {
    const find: QueryBody = { mode: 'find', dir: 'd', object: 'o', criteria: [] };
    const count: QueryBody = { mode: 'count', dir: 'd', object: 'o', criteria: [] };
    const agg: QueryBody = { mode: 'aggregate', dir: 'd', object: 'o', aggregates: [{ fn: 'count', alias: 'n' }] };
    const desc: QueryBody = { mode: 'describe-object', dir: 'd', object: 'o' };

    for (const q of [find, count, agg, desc]) {
      expect(isReadQuery(q)).toBe(true);
      expect(isWriteQuery(q)).toBe(false);
    }
  });

  test('insert/update/delete are write queries', () => {
    const insert: QueryBody = { mode: 'insert', dir: 'd', object: 'o', value: {} };
    const update: QueryBody = { mode: 'update', dir: 'd', object: 'o', key: 'k', value: {} };
    const del: QueryBody = { mode: 'delete', dir: 'd', object: 'o', key: 'k' };

    for (const q of [insert, update, del]) {
      expect(isWriteQuery(q)).toBe(true);
      expect(isReadQuery(q)).toBe(false);
    }
  });

  test('criteria nodes compose AND/OR trees', () => {
    const tree: QueryBody = {
      mode: 'find',
      dir: 'd',
      object: 'o',
      criteria: [
        {
          or: [
            { field: 'status', op: 'eq', value: 'open' },
            { and: [{ field: 'status', op: 'eq', value: 'pending' }, { field: 'age', op: 'gt', value: '5' }] },
          ],
        },
      ],
    };
    expect(isReadQuery(tree)).toBe(true);
  });
});
