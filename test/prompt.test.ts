import { describe, test, expect } from 'bun:test';
import { buildSystemPrompt } from '../src/prompt';
import type { ObjectSchema } from '../src/types';

const materialsSchema: ObjectSchema = {
  dir: 'landscaping',
  object: 'materials',
  splits: 8,
  max_key: 64,
  value_size: 100,
  fields: [
    { name: 'name', type: 'varchar', size: 80 },
    { name: 'unit_price', type: 'double' },
    { name: 'old_field', type: 'varchar', size: 10, removed: true },
  ],
  indexes: ['category'],
  counts: { live: 10, tombstoned: 0 },
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
});
