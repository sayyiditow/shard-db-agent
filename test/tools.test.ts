import { describe, test, expect } from 'bun:test';
import {
  ALL_TOOL_DEFS,
  READ_TOOL_DEFS,
  isReadToolCall,
  isProposeWriteToolCall,
  toolCallToReadQuery,
  parseProposeWriteArgs,
} from '../src/tools';
import type { LlmToolCall } from '../src/llm-client';

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
