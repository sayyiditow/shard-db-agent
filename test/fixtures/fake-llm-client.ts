import type { LlmClient, LlmCompleteParams, LlmMessage } from '../../src/llm-client';

export interface FakeLlmClientOptions {
  /** Artificial delay (ms) applied before every scripted complete() call resolves. */
  delayMs?: number;
}

export class FakeLlmClient implements LlmClient {
  private readonly scripted: LlmMessage[];
  private readonly delayMs: number;
  private readonly calls: LlmCompleteParams[] = [];
  private cursor = 0;

  constructor(scripted: LlmMessage[], options: FakeLlmClientOptions = {}) {
    this.scripted = scripted;
    this.delayMs = options.delayMs ?? 0;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    this.calls.push(params);
    if (this.cursor >= this.scripted.length) {
      throw new Error(`FakeLlmClient: no scripted response left for call #${this.cursor + 1}`);
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.scripted[this.cursor++];
  }

  get callCount(): number {
    return this.calls.length;
  }

  callAt(index: number): LlmCompleteParams {
    const call = this.calls[index];
    if (!call) throw new Error(`FakeLlmClient: no call recorded at index ${index}`);
    return call;
  }
}
