import type { AgentTurnResult, ObjectSchema, QueryRequestItem, ReadQuery, SessionState, TurnInput, WriteQuery } from './types';
import type { LlmClient, LlmMessage } from './llm-client';
import { OpenAICompatLlmClient } from './llm-client';
import {
  applyTurnInputs,
  cacheSchema,
  createInitialSessionData,
  deserializeState,
  getSchema,
  serializeState,
  type SessionData,
} from './state';
import { ALL_TOOL_DEFS, isProposeWriteToolCall, isReadToolCall, parseProposeWriteArgs, toolCallToReadQuery } from './tools';
import { buildSystemPrompt } from './prompt';
import { validateWriteAgainstSchema } from './write-validate';
import { mintKey } from './key-mint';
import { WriteValidationError } from './errors';

const DEFAULT_MAX_TOOL_ITERATIONS = 8;

export interface AgentOptions {
  llmClient?: LlmClient;
  executor?: (query: ReadQuery) => Promise<unknown>;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxToolIterations?: number;
}

export class Agent {
  private readonly llmClient: LlmClient;
  private readonly executor?: (query: ReadQuery) => Promise<unknown>;
  private readonly maxToolIterations: number;

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
  }

  async turn(
    state: SessionState | null,
    text: string | null,
    schema?: ObjectSchema,
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
      const systemPrompt = buildSystemPrompt(data.schemas);
      const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }, ...data.messages];

      const llmStart = performance.now();
      const assistantMessage = await this.llmClient.complete({ messages, tools: ALL_TOOL_DEFS });
      const callMs = performance.now() - llmStart;
      llmMs += callMs;
      data.messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (process.env.AGENT_TRACE) {
        const names = toolCalls.length > 0 ? toolCalls.map((c) => c.function.name).join(',') : '(none — final answer)';
        const known = Object.keys(data.schemas).join(',') || '(none)';
        console.error(`[trace] iter=${iteration} callMs=${Math.round(callMs)} tools=[${names}] cachedSchemas=[${known}]`);
      }
      if (toolCalls.length === 0) {
        return { kind: 'answer', text: assistantMessage.content ?? '', state: serializeState(data), llmMs: Math.round(llmMs) };
      }

      const writeCall = toolCalls.find(isProposeWriteToolCall);
      if (writeCall) {
        const { summary, body } = parseProposeWriteArgs(writeCall);
        const objSchema = getSchema(data, body.dir, body.object);
        if (!objSchema) {
          data.messages.push({
            role: 'tool',
            tool_call_id: writeCall.id,
            content: JSON.stringify({
              error: `unknown object: ${body.dir}/${body.object} — pick a known object`,
            }),
          });
          continue;
        }
        try {
          validateWriteAgainstSchema(objSchema, body);
        } catch (err) {
          if (err instanceof WriteValidationError) {
            data.messages.push({
              role: 'tool',
              tool_call_id: writeCall.id,
              content: JSON.stringify({ error: 'invalid write', issues: err.issues }),
            });
            continue;
          }
          throw err;
        }

        const pendingId = crypto.randomUUID();
        const finalBody: WriteQuery = body.mode === 'insert' && !body.key ? { ...body, key: mintKey(pendingId) } : body;

        data.pendingWrites[pendingId] = { body: finalBody, toolCallId: writeCall.id };

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
      const readQueries = readCalls.map(toolCallToReadQuery);

      if (this.executor) {
        for (let i = 0; i < readCalls.length; i++) {
          const call = readCalls[i];
          const query = readQueries[i];
          const result = await this.executor(query);
          if (query.mode === 'describe-object' && result != null && !('error' in (result as object))) {
            cacheSchema(data, result as ObjectSchema);
          }
          data.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }

      const queries: QueryRequestItem[] = readCalls.map((call, i) => ({ id: call.id, query: readQueries[i] }));
      return { kind: 'query_request', queries, state: serializeState(data), llmMs: Math.round(llmMs) };
    }

    throw new Error(
      `shard-db-agent: exceeded max tool-use iterations (${this.maxToolIterations}) without producing a result`,
    );
  }

  private loadSessionData(state: SessionState | null, schema?: ObjectSchema): SessionData {
    if (state === null) {
      if (!schema) {
        throw new Error('shard-db-agent: schema is required on the first turn of a new session (state is null)');
      }
      return createInitialSessionData(schema);
    }
    const data = deserializeState(state);
    if (schema) {
      cacheSchema(data, schema);
    }
    return data;
  }
}
