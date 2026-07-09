import type { LlmClient, LlmCompleteParams, LlmMessage } from '../../src/llm-client';

export class FakeLlmClient implements LlmClient {
  private readonly scripted: LlmMessage[];
  private readonly calls: LlmCompleteParams[] = [];
  private cursor = 0;

  constructor(scripted: LlmMessage[]) {
    this.scripted = scripted;
  }

  async complete(params: LlmCompleteParams): Promise<LlmMessage> {
    this.calls.push(params);
    if (this.cursor >= this.scripted.length) {
      throw new Error(`FakeLlmClient: no scripted response left for call #${this.cursor + 1}`);
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
