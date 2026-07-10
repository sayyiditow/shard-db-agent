import { describe, test, expect } from 'bun:test';
import {
  ALL_TOOL_DEFS,
  READ_TOOL_DEFS,
  FIND_RECORDS_TOOL,
  COUNT_RECORDS_TOOL,
  AGGREGATE_RECORDS_TOOL,
  isReadToolCall,
  isProposeWriteToolCall,
  toolCallToReadQuery,
  parseProposeWriteArgs,
} from '../src/tools';
import type { LlmToolCall } from '../src/llm-client';

function criteriaItemSchema(tool: typeof FIND_RECORDS_TOOL, prop: string = 'criteria'): Record<string, unknown> {
  const params = tool.function.parameters as { properties: Record<string, { items: Record<string, unknown> }> };
  return params.properties[prop].items;
}

function toolCall(name: string, args: unknown): LlmToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('tool definitions', () => {
  test('ALL_TOOL_DEFS has exactly 6 tools with unique names', () => {
    expect(ALL_TOOL_DEFS).toHaveLength(6);
    const names = new Set(ALL_TOOL_DEFS.map((t) => t.function.name));
    expect(names.size).toBe(6);
  });

  test('READ_TOOL_DEFS includes list_objects', () => {
    expect(READ_TOOL_DEFS.some((t) => t.function.name === 'list_objects')).toBe(true);
  });

  test('READ_TOOL_DEFS excludes propose_write', () => {
    expect(READ_TOOL_DEFS.some((t) => t.function.name === 'propose_write')).toBe(false);
  });

  test('find_records criteria items declare a concrete field/op/value shape, not an empty schema', () => {
    const schema = criteriaItemSchema(FIND_RECORDS_TOOL);
    expect(schema).not.toEqual({});
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['field', 'op', 'value', 'value2']));
    expect(schema.required).toEqual(expect.arrayContaining(['field', 'op', 'value']));
  });

  test('find_records criteria op is constrained to the real operator set', () => {
    const schema = criteriaItemSchema(FIND_RECORDS_TOOL);
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.op.enum).toEqual(expect.arrayContaining(['eq', 'lt', 'gt', 'between', 'in', 'like', 'contains', 'starts_with']));
  });

  test('count_records and aggregate_records criteria share the same concrete shape', () => {
    for (const schema of [criteriaItemSchema(COUNT_RECORDS_TOOL), criteriaItemSchema(AGGREGATE_RECORDS_TOOL)]) {
      expect(schema).not.toEqual({});
      expect(schema.required).toEqual(expect.arrayContaining(['field', 'op', 'value']));
    }
  });

  test('aggregate_records having items also declare the concrete criterion shape', () => {
    const schema = criteriaItemSchema(AGGREGATE_RECORDS_TOOL, 'having');
    expect(schema).not.toEqual({});
    expect(schema.required).toEqual(expect.arrayContaining(['field', 'op', 'value']));
  });

  test('criteria items still allow or/and combinator nodes', () => {
    const schema = criteriaItemSchema(FIND_RECORDS_TOOL);
    const oneOf = schema.oneOf as Record<string, unknown>[];
    expect(oneOf).toBeDefined();
    const requiredKeys = oneOf.map((s) => (s.required as string[])[0]);
    expect(requiredKeys).toEqual(expect.arrayContaining(['field', 'or', 'and']));
  });

  test('isReadToolCall / isProposeWriteToolCall classify correctly', () => {
    const find = toolCall('find_records', { dir: 'd', object: 'o', criteria: [] });
    const write = toolCall('propose_write', { summary: 's', body: {} });
    expect(isReadToolCall(find)).toBe(true);
    expect(isProposeWriteToolCall(find)).toBe(false);
    expect(isReadToolCall(write)).toBe(false);
    expect(isProposeWriteToolCall(write)).toBe(true);
  });

  test('toolCallToReadQuery maps find_records to a FindQuery', () => {
    const call = toolCall('find_records', {
      dir: 'landscaping',
      object: 'materials',
      criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
    });
    expect(toolCallToReadQuery(call)).toEqual({
      mode: 'find',
      dir: 'landscaping',
      object: 'materials',
      criteria: [{ field: 'category', op: 'eq', value: 'retaining_wall_block' }],
    });
  });

  test('toolCallToReadQuery maps describe_object to a DescribeObjectQuery', () => {
    const call = toolCall('describe_object', { dir: 'landscaping', object: 'materials' });
    expect(toolCallToReadQuery(call)).toEqual({ mode: 'describe-object', dir: 'landscaping', object: 'materials' });
  });

  test('toolCallToReadQuery maps list_objects to a ListObjectsQuery', () => {
    const call = toolCall('list_objects', { dir: 'landscaping' });
    expect(toolCallToReadQuery(call)).toEqual({ mode: 'list-objects', dir: 'landscaping' });
  });

  test('toolCallToReadQuery throws for propose_write', () => {
    const call = toolCall('propose_write', { summary: 's', body: {} });
    expect(() => toolCallToReadQuery(call)).toThrow();
  });

  test('parseProposeWriteArgs parses summary and body', () => {
    const call = toolCall('propose_write', {
      summary: 'Add: Block retaining wall',
      body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { qty: 120 } },
    });
    expect(parseProposeWriteArgs(call)).toEqual({
      summary: 'Add: Block retaining wall',
      body: { mode: 'insert', dir: 'landscaping', object: 'line_items', value: { qty: 120 } },
    });
  });
});
