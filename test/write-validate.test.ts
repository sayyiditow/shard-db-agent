import { describe, test, expect } from 'bun:test';
import { validateWriteAgainstSchema } from '../src/write-validate';
import { WriteValidationError } from '../src/errors';
import type { ObjectSchema } from '../src/types';

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
    { name: 'unit_price', type: 'numeric', precision: 12, scale: 2 },
    { name: 'shipped', type: 'bool' },
    { name: 'old_note', type: 'varchar', size: 40, removed: true },
  ],
  indexes: [],
  record_count: 0,
};

describe('validateWriteAgainstSchema', () => {
  test('passes a well-formed insert', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { description: 'Block retaining wall', qty: 120, unit_price: 6.85, shipped: false },
      }),
    ).not.toThrow();
  });

  test('rejects an unknown field', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { made_up_field: 'x' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a removed field', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { old_note: 'x' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a type mismatch', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { qty: '120' },
      }),
    ).toThrow(WriteValidationError);
  });

  test('rejects a varchar value exceeding max length', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { description: 'x'.repeat(81) },
      }),
    ).toThrow(WriteValidationError);
  });

  test('update without a key is rejected', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'update',
        dir: 'landscaping',
        object: 'line_items',
        key: '',
        value: { qty: 5 },
      }),
    ).toThrow(WriteValidationError);
  });

  test('delete requires only a non-empty key, not a value', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'delete',
        dir: 'landscaping',
        object: 'line_items',
        key: 'li_1',
      }),
    ).not.toThrow();
  });

  test('delete without a key is rejected', () => {
    expect(() =>
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'delete',
        dir: 'landscaping',
        object: 'line_items',
        key: '',
      }),
    ).toThrow(WriteValidationError);
  });

  test('collects multiple issues in a single error', () => {
    try {
      validateWriteAgainstSchema(lineItemsSchema, {
        mode: 'insert',
        dir: 'landscaping',
        object: 'line_items',
        value: { made_up: 'x', qty: 'not a number' },
      });
      throw new Error('expected validateWriteAgainstSchema to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WriteValidationError);
      expect((err as WriteValidationError).issues).toHaveLength(2);
    }
  });
});
