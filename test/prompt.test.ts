import { describe, test, expect } from 'bun:test';
import { buildSystemPrompt } from '../src/prompt';
import type { ObjectSchema } from '../src/types';

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
    { name: 'old_field', type: 'varchar', size: 10, removed: true },
  ],
  indexes: ['category'],
  record_count: 10,
};

describe('buildSystemPrompt', () => {
  test('lists known fields and indexes for a described object', () => {
    const prompt = buildSystemPrompt({ 'landscaping/materials': materialsSchema });
    expect(prompt).toContain('landscaping/materials');
    expect(prompt).toContain('name: varchar(80)');
    expect(prompt).toContain('unit_price: double');
    expect(prompt).toContain('Indexed: category');
  });

  test('excludes removed fields', () => {
    const prompt = buildSystemPrompt({ 'landscaping/materials': materialsSchema });
    expect(prompt).not.toContain('old_field');
  });

  test('says no schemas are known yet when the map is empty', () => {
    expect(buildSystemPrompt({})).toContain('none yet');
  });

  test('always includes the confirm-before-write rule', () => {
    expect(buildSystemPrompt({})).toContain('propose_write');
  });

  test('instructs the model to state a committed write as settled fact, not hedge', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('outcome "committed"');
    expect(prompt).toContain('never hedge');
  });

  test('instructs the model on how to respond to a rejected write', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('outcome "rejected"');
    expect(prompt).toContain('write was cancelled');
  });
});
