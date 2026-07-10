import { LlmToolCallRejectedError } from './errors';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompleteParams {
  messages: LlmMessage[];
  tools: LlmToolDef[];
}

export interface LlmClient {
  complete(params: LlmCompleteParams): Promise<LlmMessage>;
}

interface OpenAIErrorBody {
  error?: {
    code?: string;
    message?: string;
    failed_generation?: string;
  };
}

export interface OpenAICompatLlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Max retries on HTTP 429 before giving up. Default 3. */
  maxRetries?: number;
  /** Injectable for tests; defaults to a real timer-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface OpenAiChatCompletionResponse {
  choices: { message: LlmMessage }[];
}

const DEFAULT_MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return 2 ** attempt * 1000;
}

export class OpenAICompatLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: OpenAICompatLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: params.messages,
          tools: params.tools.length > 0 ? params.tools : undefined,
        }),
      });

      if (response.status === 429 && attempt < this.maxRetries) {
        await this.sleepImpl(retryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        let parsedBody: OpenAIErrorBody | undefined;
        try {
          parsedBody = JSON.parse(bodyText) as OpenAIErrorBody;
        } catch {
          parsedBody = undefined;
        }
        const providerCode = parsedBody?.error?.code;
        if (providerCode === 'tool_use_failed') {
          throw new LlmToolCallRejectedError(
            `shard-db-agent: the model produced a tool call the provider rejected as invalid: ${parsedBody?.error?.message ?? bodyText}`,
            { providerCode, providerMessage: parsedBody?.error?.message },
          );
        }
        throw new Error(`shard-db-agent: LLM endpoint returned ${response.status} ${response.statusText}: ${bodyText}`);
      }

      const json = (await response.json()) as OpenAiChatCompletionResponse;
      const choice = json.choices?.[0];
      if (!choice) {
        throw new Error('shard-db-agent: LLM response had no choices');
      }
      return choice.message;
    }
  }
}
