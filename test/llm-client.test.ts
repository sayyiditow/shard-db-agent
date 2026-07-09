import { describe, test, expect } from 'bun:test';
import { OpenAICompatLlmClient } from '../src/llm-client';

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

  test('throws when the response has no choices', async () => {
    const fetchImpl = fakeFetch(200, { choices: [] });
    const client = new OpenAICompatLlmClient({ baseUrl: 'http://localhost:8080/v1', model: 'm', fetchImpl });
    await expect(client.complete({ messages: [], tools: [] })).rejects.toThrow(/no choices/);
  });
});
