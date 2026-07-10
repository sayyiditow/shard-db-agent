import { describe, test, expect } from 'bun:test';
import { OpenAICompatLlmClient } from '../src/llm-client';
import { LlmToolCallRejectedError } from '../src/errors';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('OpenAICompatLlmClient', () => {
  test('posts model/messages/tools to <baseUrl>/chat/completions and returns the first choice message', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1/', model: 'qwen2.5-14b', fetchImpl });
    const result = await client.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [] });

    expect(result).toEqual({ role: 'assistant', content: 'hi' });
    expect(capturedUrl).toBe('http://localhost:8080/v1/chat/completions');
    const sentBody = JSON.parse((capturedInit?.body as string) ?? '{}');
    expect(sentBody.model).toBe('qwen2.5-14b');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(sentBody.tools).toBeUndefined();
  });

  test('includes an Authorization header when apiKey is set', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', apiKey: 'secret', fetchImpl });
    await client.complete({ messages: [], tools: [] });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  test('throws when the response is not ok', async () => {
    const fetchImpl = fakeFetch(500, { error: 'boom' });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/500/);
  });

  test('throws LlmToolCallRejectedError when the provider reports code: tool_use_failed', async () => {
    const fetchImpl = fakeFetch(400, {
      error: {
        message: 'Failed to call a function. Please adjust your prompt.',
        type: 'invalid_request_error',
        code: 'tool_use_failed',
        failed_generation: '{"op": ">"}',
      },
    });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toBeInstanceOf(LlmToolCallRejectedError);
  });

  test('a generic non-tool_use_failed 400 still throws a plain Error, not LlmToolCallRejectedError', async () => {
    const fetchImpl = fakeFetch(400, { error: { message: 'bad request', code: 'invalid_request' } });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    const promise = client.complete({ messages: [], tools: [] });
    await expect(promise).rejects.toThrow();
    await expect(promise).rejects.not.toBeInstanceOf(LlmToolCallRejectedError);
  });

  test('throws when the response has no choices', async () => {
    const fetchImpl = fakeFetch(200, { choices: [] });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/no choices/);
  });

  test('retries a 429 respecting the Retry-After header, then returns the result', async () => {
    let callCount = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'Retry-After': '2' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({
      baseUrl: 'http://localhost:8080/v1',
      model: 'm',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.complete({ messages: [], tools: [] });

    expect(result).toEqual({ role: 'assistant', content: 'ok' });
    expect(callCount).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  test('falls back to exponential backoff when the Retry-After header is absent', async () => {
    let callCount = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({
      baseUrl: 'http://localhost:8080/v1',
      model: 'm',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.complete({ messages: [], tools: [] });

    expect(result).toEqual({ role: 'assistant', content: 'ok' });
    expect(sleeps).toEqual([1000, 2000]);
  });

  test('gives up after maxRetries consecutive 429s and throws', async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'still limited' }), { status: 429 });
    }) as unknown as typeof fetch;

    const client = new OpenAICompatLlmClient({
      baseUrl: 'http://localhost:8080/v1',
      model: 'm',
      fetchImpl,
      maxRetries: 2,
      sleepImpl: async () => {},
    });

    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/429/);
    expect(callCount).toBe(3);
  });
});
