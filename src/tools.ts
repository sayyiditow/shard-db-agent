import type { LlmToolDef, LlmToolCall } from './llm-client';
import type {
  AggregateQuery,
  CountQuery,
  CriterionOp,
  DescribeObjectQuery,
  FindQuery,
  ListObjectsQuery,
  ReadQuery,
  WriteQuery,
} from './types';

const CRITERION_OPS: CriterionOp[] = [
  'eq', 'equal', '=', 'neq', 'not_equal', '!=', '<>',
  'lt', 'less', '<', 'gt', 'greater', '>', 'lte', 'less_eq', '<=', 'gte', 'greater_eq', '>=',
  'between',
  'in', 'nin', 'not_in',
  'exists', 'nexists', 'not_exists',
  'like', 'nlike', 'not_like',
  'contains', 'ncontains', 'not_contains',
  'starts', 'starts_with', 'ends', 'ends_with',
  'ilike', 'not_ilike', 'icontains', 'not_icontains', 'istarts', 'iends',
  'len_eq', 'len_neq', 'len_lt', 'len_gt', 'len_lte', 'len_gte', 'len_between',
  'eq_field', 'neq_field', 'lt_field', 'gt_field', 'lte_field', 'gte_field',
  'regex', 'not_regex',
];

/**
 * Criteria tree node: either a concrete {field, op, value, value2?} leaf, or
 * an {or: [...]} / {and: [...]} combinator nesting more nodes. Top-level
 * properties/required describe the leaf shape so a bare leaf validates
 * directly; oneOf spells out all three legal shapes so models reliably
 * produce well-formed criteria instead of guessing against an empty schema.
 */
const CRITERION_NODE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    field: { type: 'string', description: 'Field name to filter on.' },
    op: { type: 'string', enum: CRITERION_OPS, description: 'Comparison operator.' },
    value: { type: ['string', 'number', 'boolean'], description: 'Comparison value; the server coerces to the field type.' },
    value2: { type: ['string', 'number', 'boolean'], description: 'Second value, required only for range ops like between/len_between.' },
    or: { type: 'array', items: {}, description: 'OR-combined child criteria nodes.' },
    and: { type: 'array', items: {}, description: 'AND-combined child criteria nodes.' },
  },
  required: ['field', 'op', 'value'],
  oneOf: [
    { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] },
    { type: 'object', properties: { or: { type: 'array', items: {} } }, required: ['or'] },
    { type: 'object', properties: { and: { type: 'array', items: {} } }, required: ['and'] },
  ],
};

export const FIND_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'find_records',
    description: 'Find records matching criteria. Returns an array of {key, value} records.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: {
          type: 'array',
          items: CRITERION_NODE_SCHEMA,
          description: 'AND-combined criteria; pass [] to match every record.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional field projection.',
        },
        order_by: { type: 'string' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
      },
      required: ['dir', 'object', 'criteria'],
    },
  },
};

export const COUNT_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'count_records',
    description: 'Count records matching criteria, without fetching their values.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: { type: 'array', items: CRITERION_NODE_SCHEMA },
      },
      required: ['dir', 'object', 'criteria'],
    },
  },
};

export const AGGREGATE_RECORDS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'aggregate_records',
    description: 'Group-by aggregation (count/sum/avg/min/max) over records matching criteria.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
        criteria: { type: 'array', items: CRITERION_NODE_SCHEMA },
        group_by: { type: 'array', items: { type: 'string' } },
        aggregates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
              field: { type: 'string' },
              alias: { type: 'string' },
            },
            required: ['fn', 'alias'],
          },
        },
        having: { type: 'array', items: CRITERION_NODE_SCHEMA },
        order_by: { type: 'string' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer' },
      },
      required: ['dir', 'object', 'aggregates'],
    },
  },
};

export const DESCRIBE_OBJECT_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'describe_object',
    description:
      "Fetch an object's field schema and indexes. Call this before reading or writing an object you haven't seen yet.",
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        object: { type: 'string' },
      },
      required: ['dir', 'object'],
    },
  },
};

export const LIST_OBJECTS_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'list_objects',
    description:
      "List every object name that exists inside a tenant directory. Only call this when you can't find the object the user means — e.g. describe_object came back with an error, or the name they gave doesn't match anything in the known schemas below — so you can match the closest real name before asking the user to clarify. Don't call it otherwise.",
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
      },
      required: ['dir'],
    },
  },
};

export const PROPOSE_WRITE_TOOL: LlmToolDef = {
  type: 'function',
  function: {
    name: 'propose_write',
    description:
      'Propose an insert, update, or delete for the user to confirm. Never assume a write happened until you are told it was committed.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One-line human-readable summary of the write, shown to the user for confirmation.',
        },
        body: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['insert', 'update', 'delete'] },
            dir: { type: 'string' },
            object: { type: 'string' },
            key: {
              type: 'string',
              description: 'Required for update/delete. Optional for insert — omit to have one generated.',
            },
            value: {
              type: 'object',
              description: 'Required for insert/update. Field values matching the object schema.',
            },
          },
          required: ['mode', 'dir', 'object'],
        },
      },
      required: ['summary', 'body'],
    },
  },
};

export const READ_TOOL_DEFS: LlmToolDef[] = [
  FIND_RECORDS_TOOL,
  COUNT_RECORDS_TOOL,
  AGGREGATE_RECORDS_TOOL,
  DESCRIBE_OBJECT_TOOL,
  LIST_OBJECTS_TOOL,
];

export const ALL_TOOL_DEFS: LlmToolDef[] = [...READ_TOOL_DEFS, PROPOSE_WRITE_TOOL];

const READ_TOOL_NAMES = new Set(READ_TOOL_DEFS.map((t) => t.function.name));

export function isReadToolCall(call: LlmToolCall): boolean {
  return READ_TOOL_NAMES.has(call.function.name);
}

export function isProposeWriteToolCall(call: LlmToolCall): boolean {
  return call.function.name === 'propose_write';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`shard-db-agent: expected "${field}" to be a string`);
  }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`shard-db-agent: expected "${field}" to be an array`);
  }
}

export function toolCallToReadQuery(call: LlmToolCall): ReadQuery {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  switch (call.function.name) {
    case 'find_records':
      assertString(args.dir, 'dir');
      assertString(args.object, 'object');
      assertArray(args.criteria, 'criteria');
      return { mode: 'find', ...(args as object) } as FindQuery;
    case 'count_records':
      assertString(args.dir, 'dir');
      assertString(args.object, 'object');
      assertArray(args.criteria, 'criteria');
      return { mode: 'count', ...(args as object) } as CountQuery;
    case 'aggregate_records':
      assertString(args.dir, 'dir');
      assertString(args.object, 'object');
      assertArray(args.aggregates, 'aggregates');
      return { mode: 'aggregate', ...(args as object) } as AggregateQuery;
    case 'describe_object':
      assertString(args.dir, 'dir');
      assertString(args.object, 'object');
      return { mode: 'describe-object', ...(args as object) } as DescribeObjectQuery;
    case 'list_objects':
      assertString(args.dir, 'dir');
      return { mode: 'list-objects', ...(args as object) } as ListObjectsQuery;
    default:
      throw new Error(`shard-db-agent: "${call.function.name}" is not a read tool`);
  }
}

export interface ProposeWriteArgs {
  summary: string;
  body: WriteQuery;
}

export function parseProposeWriteArgs(call: LlmToolCall): ProposeWriteArgs {
  const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  assertString(args.summary, 'summary');
  if (!isPlainObject(args.body)) {
    throw new Error('shard-db-agent: expected "body" to be an object');
  }
  const body = args.body;
  if (body.mode !== 'insert' && body.mode !== 'update' && body.mode !== 'delete') {
    throw new Error('shard-db-agent: expected body.mode to be one of insert/update/delete');
  }
  assertString(body.dir, 'body.dir');
  assertString(body.object, 'body.object');
  return { summary: args.summary, body: body as unknown as WriteQuery };
}
