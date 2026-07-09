import type { ObjectSchema, InsertQuery, UpdateQuery, DeleteQuery, FieldDescriptor } from './types';
import { WriteValidationError } from './errors';

type ExpectedJsType = 'string' | 'number' | 'boolean';

const NUMERIC_TYPES = new Set(['int', 'long', 'short', 'byte', 'double', 'numeric']);
const STRING_TYPES = new Set(['varchar', 'date', 'datetime', 'datetimems', 'timestamp', 'ipv4', 'ipv6']);

function expectedJsType(fieldType: string): ExpectedJsType | undefined {
  if (NUMERIC_TYPES.has(fieldType)) return 'number';
  if (STRING_TYPES.has(fieldType)) return 'string';
  if (fieldType === 'bool') return 'boolean';
  return undefined;
}

function findField(schema: ObjectSchema, name: string): FieldDescriptor | undefined {
  return schema.fields.find((f) => f.name === name && !f.removed);
}

export function validateWriteAgainstSchema(
  schema: ObjectSchema,
  body: InsertQuery | UpdateQuery | DeleteQuery,
): void {
  const issues: string[] = [];

  if (body.mode === 'delete') {
    if (!body.key || body.key.length === 0) {
      issues.push('delete requires a non-empty key');
    }
    if (issues.length > 0) {
      throw new WriteValidationError(`shard-db-agent: invalid delete write for ${schema.dir}/${schema.object}`, issues);
    }
    return;
  }

  if (body.mode === 'update' && (!body.key || body.key.length === 0)) {
    issues.push('update requires a non-empty key');
  }

  const value = body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${body.mode} requires a "value" object`);
    throw new WriteValidationError(`shard-db-agent: invalid ${body.mode} write for ${schema.dir}/${schema.object}`, issues);
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    const field = findField(schema, fieldName);
    if (!field) {
      issues.push(`unknown field: ${fieldName}`);
      continue;
    }
    const expected = expectedJsType(field.type);
    if (expected && typeof fieldValue !== expected) {
      issues.push(`field "${fieldName}" expects ${expected} for type ${field.type}, got ${typeof fieldValue}`);
      continue;
    }
    if (field.type === 'varchar' && typeof fieldValue === 'string' && field.size && fieldValue.length > field.size) {
      issues.push(`field "${fieldName}" exceeds max length ${field.size} (got ${fieldValue.length})`);
    }
  }

  if (issues.length > 0) {
    throw new WriteValidationError(`shard-db-agent: invalid ${body.mode} write for ${schema.dir}/${schema.object}`, issues);
  }
}
