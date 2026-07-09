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
  content: string | null;
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

export interface OpenAICompatLlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiChatCompletionResponse {
  choices: { message: LlmMessage }[];
}

export class OpenAICompatLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
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

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`shard-db-agent: LLM endpoint returned ${response.status} ${response.statusText}: ${body}`);
    }

    const json = (await response.json()) as OpenAiChatCompletionResponse;
    const choice = json.choices?.[0];
    if (!choice) {
      throw new Error('shard-db-agent: LLM response had no choices');
    }
    return choice.message;
  }
}
