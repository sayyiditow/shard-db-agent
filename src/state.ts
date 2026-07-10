import type { ObjectSchema, TurnInput, WriteQuery } from './types';
import { InvalidStateError } from './errors';
import type { LlmMessage } from './llm-client';

const STATE_VERSION = 2;
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

export interface PendingWrite {
  body: WriteQuery;
  toolCallId: string;
}

export interface PendingDescribeQuery {
  dir: string;
  object: string;
}

export interface SessionData {
  version: number;
  schemas: Record<string, ObjectSchema>;
  messages: LlmMessage[];
  pendingWrites: Record<string, PendingWrite>;
  pendingDescribeQueries: Record<string, PendingDescribeQuery>;
}

function schemaKey(dir: string, object: string): string {
  return JSON.stringify([dir, object]);
}

export function createInitialSessionData(schema: ObjectSchema): SessionData {
  return {
    version: STATE_VERSION,
    schemas: { [schemaKey(schema.dir, schema.object)]: schema },
    messages: [],
    pendingWrites: {},
    pendingDescribeQueries: {},
  };
}

export function cacheSchema(data: SessionData, schema: ObjectSchema): void {
  data.schemas[schemaKey(schema.dir, schema.object)] = schema;
}

export function getSchema(data: SessionData, dir: string, object: string): ObjectSchema | undefined {
  return data.schemas[schemaKey(dir, object)];
}

export function serializeState(data: SessionData): string {
  return Buffer.from(JSON.stringify(data), 'utf-8').toString('base64');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMessage(value: unknown): value is LlmMessage {
  if (!isPlainRecord(value)) return false;
  if (typeof value.role !== 'string' || !VALID_ROLES.has(value.role)) return false;
  if (value.content != null && typeof value.content !== 'string') return false;
  return true;
}

export function isObjectSchemaShape(value: unknown): value is ObjectSchema {
  return (
    isPlainRecord(value) &&
    typeof value.dir === 'string' &&
    typeof value.object === 'string' &&
    Array.isArray(value.fields)
  );
}

function isValidPendingWrite(value: unknown): value is PendingWrite {
  return isPlainRecord(value) && typeof value.toolCallId === 'string' && isPlainRecord(value.body);
}

function isValidPendingDescribeQuery(value: unknown): value is PendingDescribeQuery {
  return isPlainRecord(value) && typeof value.dir === 'string' && typeof value.object === 'string';
}

export function deserializeState(state: string): SessionData {
  const json = Buffer.from(state, 'base64').toString('utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidStateError('shard-db-agent: state does not decode to valid JSON');
  }

  const candidate = parsed as Partial<SessionData> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.version !== STATE_VERSION ||
    typeof candidate.schemas !== 'object' ||
    !Array.isArray(candidate.messages) ||
    typeof candidate.pendingWrites !== 'object' ||
    typeof candidate.pendingDescribeQueries !== 'object'
  ) {
    throw new InvalidStateError('shard-db-agent: state is missing required fields or has an unsupported version');
  }

  if (!candidate.messages.every(isValidMessage)) {
    throw new InvalidStateError('shard-db-agent: state.messages contains a malformed message');
  }
  if (!isPlainRecord(candidate.schemas) || !Object.values(candidate.schemas).every(isObjectSchemaShape)) {
    throw new InvalidStateError('shard-db-agent: state.schemas contains a malformed schema entry');
  }
  if (!isPlainRecord(candidate.pendingWrites) || !Object.values(candidate.pendingWrites).every(isValidPendingWrite)) {
    throw new InvalidStateError('shard-db-agent: state.pendingWrites contains a malformed entry');
  }
  if (
    !isPlainRecord(candidate.pendingDescribeQueries) ||
    !Object.values(candidate.pendingDescribeQueries).every(isValidPendingDescribeQuery)
  ) {
    throw new InvalidStateError('shard-db-agent: state.pendingDescribeQueries contains a malformed entry');
  }

  return candidate as SessionData;
}

export const STALE_TOOL_RESULT_MARKER = 'superseded — see a later tool result in this conversation for current data';

export function pruneStaleToolResults(data: SessionData, keep: number): void {
  const toolIndices: number[] = [];
  for (let i = 0; i < data.messages.length; i++) {
    if (data.messages[i].role === 'tool') {
      toolIndices.push(i);
    }
  }

  const staleCount = Math.max(0, toolIndices.length - keep);
  for (let i = 0; i < staleCount; i++) {
    const idx = toolIndices[i];
    if (data.messages[idx].content !== STALE_TOOL_RESULT_MARKER) {
      data.messages[idx] = { ...data.messages[idx], content: STALE_TOOL_RESULT_MARKER };
    }
  }
}

export function applyTurnInputs(data: SessionData, turnInputs: TurnInput[]): void {
  for (const input of turnInputs) {
    if (input.kind === 'query_result') {
      const pendingDescribe = Object.prototype.hasOwnProperty.call(data.pendingDescribeQueries, input.id)
        ? data.pendingDescribeQueries[input.id]
        : undefined;
      if (pendingDescribe && isObjectSchemaShape(input.data)) {
        cacheSchema(data, input.data);
      }
      delete data.pendingDescribeQueries[input.id];

      data.messages.push({
        role: 'tool',
        tool_call_id: input.id,
        content: JSON.stringify(input.data),
      });
      continue;
    }

    const pending = Object.prototype.hasOwnProperty.call(data.pendingWrites, input.pendingId)
      ? data.pendingWrites[input.pendingId]
      : undefined;
    if (!pending) {
      throw new InvalidStateError(
        `shard-db-agent: write_outcome pendingId "${input.pendingId}" does not match any pending write from this session`,
      );
    }
    delete data.pendingWrites[input.pendingId];
    data.messages.push({
      role: 'tool',
      tool_call_id: pending.toolCallId,
      content: JSON.stringify({ outcome: input.outcome, error: input.error ?? null, write: pending.body }),
    });
  }
}
