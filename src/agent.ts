import type { AgentTurnResult, ObjectSchema, QueryRequestItem, ReadQuery, SessionState, TurnInput, WriteQuery } from './types';
import type { LlmClient, LlmMessage, LlmToolCall } from './llm-client';
import { OpenAICompatLlmClient } from './llm-client';
import {
  applyTurnInputs,
  cacheSchema,
  createInitialSessionData,
  deserializeState,
  getSchema,
  isObjectSchemaShape,
  pruneStaleToolResults,
  serializeState,
  type SessionData,
} from './state';
import { ALL_TOOL_DEFS, isProposeWriteToolCall, isReadToolCall, parseProposeWriteArgs, toolCallToReadQuery } from './tools';
import { buildSystemPrompt } from './prompt';
import { validateWriteAgainstSchema } from './write-validate';
import { mintKey } from './key-mint';
import { LlmToolCallRejectedError, WriteValidationError } from './errors';

const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const DEFAULT_MAX_RETAINED_TOOL_RESULTS = 4;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 20_000;

export interface AgentOptions {
  llmClient?: LlmClient;
  executor?: (query: ReadQuery) => Promise<unknown>;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxToolIterations?: number;
  /** How many most-recent tool results to keep verbatim; older ones are replaced with a stale marker. Default 4. */
  maxRetainedToolResults?: number;
  /** Max characters of a single executor result's JSON allowed into the conversation before truncation. Default 20000. */
  maxToolResultChars?: number;
}

function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const omitted = content.length - maxChars;
  return `${content.slice(0, maxChars)}... [truncated — ${omitted} more characters omitted; narrow your query with "limit"/"fields" and try again]`;
}

export class Agent {
  private readonly llmClient: LlmClient;
  private readonly executor?: (query: ReadQuery) => Promise<unknown>;
  private readonly maxToolIterations: number;
  private readonly maxRetainedToolResults: number;
  private readonly maxToolResultChars: number;

  constructor(options: AgentOptions = {}) {
    if (options.llmClient) {
      this.llmClient = options.llmClient;
    } else {
      if (!options.baseUrl || !options.model) {
        throw new Error('shard-db-agent: Agent requires either an llmClient or both baseUrl and model');
      }
      this.llmClient = new OpenAICompatLlmClient({
        baseUrl: options.baseUrl,
        model: options.model,
        apiKey: options.apiKey,
      });
    }
    this.executor = options.executor;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.maxRetainedToolResults = options.maxRetainedToolResults ?? DEFAULT_MAX_RETAINED_TOOL_RESULTS;
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  }

  async turn(
    state: SessionState | null,
    text: string | null,
    schema?: ObjectSchema | ObjectSchema[],
    turnInputs?: TurnInput[],
  ): Promise<AgentTurnResult> {
    const data = this.loadSessionData(state, schema);

    if (turnInputs && turnInputs.length > 0) {
      applyTurnInputs(data, turnInputs);
    }

    if (text !== null) {
      data.messages.push({ role: 'user', content: text });
    }

    let llmMs = 0;

    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      pruneStaleToolResults(data, this.maxRetainedToolResults);

      const systemPrompt = buildSystemPrompt(data.schemas);
      const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }, ...data.messages];

      const llmStart = performance.now();
      let assistantMessage: LlmMessage;
      try {
        assistantMessage = await this.llmClient.complete({ messages, tools: ALL_TOOL_DEFS });
      } catch (err) {
        if (err instanceof LlmToolCallRejectedError) {
          llmMs += performance.now() - llmStart;
          if (process.env.AGENT_TRACE) {
            console.error(`[trace] iter=${iteration} tool_use_failed: ${err.providerMessage ?? err.message}`);
          }
          data.messages.push({
            role: 'user',
            content: `Your last tool call was rejected as invalid: ${err.providerMessage ?? err.message}. Retry with corrected arguments — check operator names/symbols and value types against the tool schema.`,
          });
          continue;
        }
        throw err;
      }
      const callMs = performance.now() - llmStart;
      llmMs += callMs;
      data.messages.push({ ...assistantMessage, content: assistantMessage.content ?? null });

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (process.env.AGENT_TRACE) {
        const names = toolCalls.length > 0 ? toolCalls.map((c) => c.function.name).join(',') : '(none — final answer)';
        const known = Object.keys(data.schemas).join(',') || '(none)';
        console.error(`[trace] iter=${iteration} callMs=${Math.round(callMs)} tools=[${names}] cachedSchemas=[${known}]`);
      }
      if (toolCalls.length === 0) {
        return { kind: 'answer', text: assistantMessage.content ?? '', state: serializeState(data), llmMs: Math.round(llmMs) };
      }

      const answeredIds = new Set<string>();
      const answer = (callId: string, content: string) => {
        answeredIds.add(callId);
        data.messages.push({ role: 'tool', tool_call_id: callId, content });
      };
      const answerUnhandled = () => {
        for (const call of toolCalls) {
          if (answeredIds.has(call.id)) continue;
          answer(call.id, JSON.stringify({ skipped: 'not executed this turn — see the other tool result(s) in this turn for what happened' }));
        }
      };

      const writeCalls = toolCalls.filter(isProposeWriteToolCall);
      const writeCall = writeCalls[0];

      if (writeCall) {
        for (const extra of writeCalls.slice(1)) {
          answer(extra.id, JSON.stringify({ error: 'only one propose_write is processed per turn — resubmit this call on a later turn' }));
        }

        let summary: string;
        let body: WriteQuery;
        try {
          ({ summary, body } = parseProposeWriteArgs(writeCall));
        } catch {
          answer(writeCall.id, JSON.stringify({ error: 'malformed tool call arguments — please retry with valid JSON' }));
          answerUnhandled();
          continue;
        }
        const objSchema = getSchema(data, body.dir, body.object);
        if (!objSchema) {
          answer(writeCall.id, JSON.stringify({ error: `unknown object: ${body.dir}/${body.object} — pick a known object` }));
          answerUnhandled();
          continue;
        }
        try {
          validateWriteAgainstSchema(objSchema, body);
        } catch (err) {
          if (err instanceof WriteValidationError) {
            answer(writeCall.id, JSON.stringify({ error: 'invalid write', issues: err.issues }));
            answerUnhandled();
            continue;
          }
          throw err;
        }

        const pendingId = crypto.randomUUID();
        const finalBody: WriteQuery = body.mode === 'insert' && !body.key ? { ...body, key: mintKey(pendingId) } : body;

        data.pendingWrites[pendingId] = { body: finalBody, toolCallId: writeCall.id };
        answeredIds.add(writeCall.id);
        answerUnhandled();

        return {
          kind: 'proposed_write',
          body: finalBody,
          summary,
          pendingId,
          state: serializeState(data),
          llmMs: Math.round(llmMs),
        };
      }

      const readCalls = toolCalls.filter(isReadToolCall);
      const unknownCalls = toolCalls.filter((c) => !isReadToolCall(c) && !isProposeWriteToolCall(c));
      for (const call of unknownCalls) {
        answer(call.id, JSON.stringify({ error: `unknown tool "${call.function.name}"` }));
      }

      const parsedReadCalls: { call: LlmToolCall; query: ReadQuery }[] = [];
      for (const call of readCalls) {
        try {
          parsedReadCalls.push({ call, query: toolCallToReadQuery(call) });
        } catch {
          answer(call.id, JSON.stringify({ error: 'malformed tool call arguments — please retry with valid JSON' }));
        }
      }

      if (this.executor) {
        const results = await Promise.all(
          parsedReadCalls.map(async ({ call, query }) => ({ call, query, result: await this.executor!(query) })),
        );
        for (const { call, query, result } of results) {
          if (query.mode === 'describe-object' && isObjectSchemaShape(result)) {
            cacheSchema(data, result);
          }
          answer(call.id, truncateToolResult(JSON.stringify(result), this.maxToolResultChars));
        }
        continue;
      }

      if (parsedReadCalls.length === 0) {
        continue;
      }

      for (const { call, query } of parsedReadCalls) {
        if (query.mode === 'describe-object') {
          data.pendingDescribeQueries[call.id] = { dir: query.dir, object: query.object };
        }
      }

      const queries: QueryRequestItem[] = parsedReadCalls.map(({ call, query }) => ({ id: call.id, query }));
      return { kind: 'query_request', queries, state: serializeState(data), llmMs: Math.round(llmMs) };
    }

    throw new Error(
      `shard-db-agent: exceeded max tool-use iterations (${this.maxToolIterations}) without producing a result`,
    );
  }

  private loadSessionData(state: SessionState | null, schema?: ObjectSchema | ObjectSchema[]): SessionData {
    const schemas = schema === undefined ? [] : Array.isArray(schema) ? schema : [schema];

    if (state === null) {
      if (schemas.length === 0) {
        throw new Error('shard-db-agent: schema is required on the first turn of a new session (state is null)');
      }
      const data = createInitialSessionData(schemas[0]);
      for (const s of schemas.slice(1)) cacheSchema(data, s);
      return data;
    }
    const data = deserializeState(state);
    for (const s of schemas) cacheSchema(data, s);
    return data;
  }
}
