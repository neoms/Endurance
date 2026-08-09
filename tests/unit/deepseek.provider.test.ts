/**
 * DeepSeek Provider 单元测试（注入 fake fetch，不发起真实网络请求）
 *
 * 覆盖：
 * - 请求组装：URL、Bearer 鉴权、model、系统提示（人设）、历史与当前消息透传；
 * - 响应解析：choices[0].message.content（含 trim）；
 * - 错误分类：网络错误/429/5xx 可重试、401 不可重试、空内容可重试、信号中止；
 * - 自定义 baseUrl（去末尾斜杠）与 model；
 * - Provider 工厂：配置 key → DeepSeek；未配置 → Mock。
 */
import { describe, expect, it } from 'vitest';

import { DeepSeekProvider } from '../../src/services/ai/deepseek.provider.js';
import { MockAiProvider } from '../../src/services/ai/mock.provider.js';
import { createDefaultAiProvider } from '../../src/services/ai/provider.factory.js';
import type { AiGenerateContext } from '../../src/services/ai/types.js';

/**
 * 构造注入 fake fetch 的 Provider
 *
 * @param handler 自定义 fetch 处理器（接收请求参数，返回 Response）
 * @returns DeepSeekProvider 测试用实例
 */
function makeProvider(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
  options: { apiKey?: string; baseUrl?: string; model?: string } = {},
): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: options.apiKey ?? 'sk-test',
    baseUrl: options.baseUrl,
    model: options.model,
    fetchImpl: handler as typeof fetch,
  });
}

/** JSON 响应构造器 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 一个包含群组人设与历史的典型上下文 */
const groupContext: AiGenerateContext = {
  content: '你好',
  botName: '技术机器人',
  personality: '严谨、专业，喜欢讲原理',
  userName: 'alice',
  history: [
    { role: 'user', content: '昨天的问题' },
    { role: 'assistant', content: '已经解决了' },
  ],
};

describe('DeepSeekProvider', () => {
  it('assembles the request (URL/auth/model/messages) and parses the reply', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody:
      | {
          model: string;
          messages: Array<{ role: string; content: string }>;
          temperature: number;
          max_tokens: number;
          stream: boolean;
          thinking?: { type: string };
        }
      | undefined;

    const provider = makeProvider(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        choices: [{ message: { content: '  这是 DeepSeek 的智能回复  ' } }],
        usage: { total_tokens: 12 },
      });
    });

    const result = await provider.generate(groupContext, {});

    expect(result.content).toBe('这是 DeepSeek 的智能回复');
    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions');
    expect(capturedHeaders?.authorization).toBe('Bearer sk-test');
    // 默认模型为 deepseek-v4-flash（V4 快速路径）
    expect(capturedBody?.model).toBe('deepseek-v4-flash');
    expect(capturedBody?.stream).toBe(false);
    // V4 系列显式关闭思考模式，换取更低延迟
    expect(capturedBody?.thinking).toEqual({ type: 'disabled' });
    // 系统提示注入机器人名称与性格
    expect(capturedBody?.messages[0]).toMatchObject({ role: 'system' });
    expect(capturedBody?.messages[0]?.content).toContain('技术机器人');
    expect(capturedBody?.messages[0]?.content).toContain('严谨、专业');
    // 历史消息按原顺序透传
    expect(capturedBody?.messages[1]).toEqual({ role: 'user', content: '昨天的问题' });
    expect(capturedBody?.messages[2]).toEqual({ role: 'assistant', content: '已经解决了' });
    // 当前用户消息附带发送者用户名前缀
    expect(capturedBody?.messages[3]).toEqual({ role: 'user', content: 'alice：你好' });
  });

  it('strips trailing slash from baseUrl and honors custom model', async () => {
    let capturedUrl: string | undefined;
    const provider = makeProvider(
      async (url) => {
        capturedUrl = String(url);
        return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
      },
      { baseUrl: 'https://gateway.example.com/', model: 'deepseek-reasoner' },
    );

    await provider.generate({ content: 'hi' }, {});

    expect(capturedUrl).toBe('https://gateway.example.com/chat/completions');
  });

  it('does not send the thinking flag for non-V4 models', async () => {
    let capturedBody:
      | {
          model: string;
          thinking?: { type: string };
        }
      | undefined;
    const provider = makeProvider(
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
      },
      { model: 'deepseek-chat' },
    );

    await provider.generate({ content: 'hi' }, {});

    // 非 V4 模型（如 deepseek-chat）不携带 thinking，避免上游拒绝未知参数
    expect(capturedBody?.model).toBe('deepseek-chat');
    expect(capturedBody?.thinking).toBeUndefined();
  });

  it('treats network errors as retryable', async () => {
    const provider = makeProvider(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(provider.generate({ content: 'hi' }, {})).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });
  });

  it('classifies HTTP status codes: 401 non-retryable, 429/5xx retryable', async () => {
    const unauthorized = makeProvider(async () => jsonResponse(401, { error: 'invalid key' }));
    await expect(unauthorized.generate({ content: 'hi' }, {})).rejects.toMatchObject({
      code: 'AI_INVALID_REQUEST',
      retryable: false,
    });

    const rateLimited = makeProvider(async () => jsonResponse(429, { error: 'slow down' }));
    await expect(rateLimited.generate({ content: 'hi' }, {})).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });

    const serverError = makeProvider(async () => jsonResponse(503, { error: 'busy' }));
    await expect(serverError.generate({ content: 'hi' }, {})).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });
  });

  it('treats an aborted signal as retryable (AI_ABORTED)', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = makeProvider(async (_url, init) => {
      // 模拟真实 fetch：signal 已中止时抛 AbortError
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    });

    await expect(
      provider.generate({ content: 'hi' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AI_ABORTED', retryable: true });
  });

  it('treats empty content as retryable failure', async () => {
    const provider = makeProvider(async () =>
      jsonResponse(200, { choices: [{ message: { content: '   ' } }] }),
    );

    await expect(provider.generate({ content: 'hi' }, {})).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('DeepSeekProvider stream', () => {
  it('streams SSE chunks and joins them into the full reply', async () => {
    // 构造两段 data 增量 + [DONE] 结束标记的 SSE 响应体
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    let capturedBody: { stream: boolean; model: string } | undefined;
    const provider = makeProvider(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    // 收集所有增量块并拼接
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ content: 'hi' }, {})) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('你好');
    // 流式请求体必须携带 stream: true，且 V4 模型仍显式关闭思考模式
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.model).toBe('deepseek-v4-flash');
    expect((capturedBody as { thinking?: { type: string } } | undefined)?.thinking).toEqual({
      type: 'disabled',
    });
  });

  it('treats an empty stream as a retryable failure', async () => {
    const provider = makeProvider(
      async () =>
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    await expect(async () => {
      for await (const _chunk of provider.stream({ content: 'hi' }, {})) {
        // 无内容时不应产出任何块
      }
    }).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true });
  });

  it('classifies non-OK status before streaming starts', async () => {
    const provider = makeProvider(async () => jsonResponse(401, { error: 'invalid key' }));

    await expect(async () => {
      for await (const _chunk of provider.stream({ content: 'hi' }, {})) {
        // 不应有任何产出
      }
    }).rejects.toMatchObject({ code: 'AI_INVALID_REQUEST', retryable: false });
  });

  it('skips malformed SSE data frames and continues streaming', async () => {
    // 个别 data 帧不是合法 JSON：记录日志跳过，不让整个流崩掉
    const sseBody = [
      'data: {broken-json',
      '',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const provider = makeProvider(
      async () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const chunks: string[] = [];
    for await (const chunk of provider.stream({ content: 'hi' }, {})) {
      chunks.push(chunk);
    }

    // 坏帧被跳过，后续正常帧照常产出
    expect(chunks.join('')).toBe('好');
  });

  it('throws AI_ABORTED when the stream is interrupted after cancellation', async () => {
    // 上游连接在取消信号生效后被掐断：应归一化为可重试的 AI_ABORTED
    const provider = makeProvider(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'),
              );
            },
            pull(controller) {
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const controller = new AbortController();
    const iterator = provider
      .stream({ content: 'hi' }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    // 先产出首块，再取消并等待下一块读取失败
    const first = await iterator.next();
    expect(first.value).toBe('A');
    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'AI_ABORTED',
      retryable: true,
    });
  });

  it('treats an interrupted stream as a retryable AI_UNAVAILABLE', async () => {
    // 连接中途被上游掐断（未取消）：归类为可重试的 AI_UNAVAILABLE
    const provider = makeProvider(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('socket hang up'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    await expect(async () => {
      for await (const _chunk of provider.stream({ content: 'hi' }, {})) {
        // 不应有任何产出
      }
    }).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true });
  });

  it('treats a response without a body as a retryable failure', async () => {
    // 服务端返回 200 但没有任何响应体：拿不到 reader，应视为可重试异常
    const provider = makeProvider(async () => new Response(null, { status: 200 }));

    await expect(async () => {
      for await (const _chunk of provider.stream({ content: 'hi' }, {})) {
        // 不应有任何产出
      }
    }).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true });
  });

  it('ends the stream when the upstream closes without a [DONE] marker', async () => {
    // 服务端正常关闭但未发 [DONE]：读取循环应在 done=true 时自然结束
    const provider = makeProvider(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"收"}}]}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const chunks: string[] = [];
    for await (const chunk of provider.stream({ content: 'hi' }, {})) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('收');
  });
});

describe('createDefaultAiProvider factory', () => {
  it('uses DeepSeek when a key is configured', () => {
    expect(createDefaultAiProvider('sk-abc')).toBeInstanceOf(DeepSeekProvider);
  });

  it('falls back to Mock when the key is missing or empty', () => {
    expect(createDefaultAiProvider(undefined)).toBeInstanceOf(MockAiProvider);
    expect(createDefaultAiProvider('')).toBeInstanceOf(MockAiProvider);
  });

  // 防回归：确保测试环境强制回退 Mock（tests/setup.ts 把 DEEPSEEK_API_KEY 置空）
  it('still creates a Mock provider when env key is empty', () => {
    expect(createDefaultAiProvider(process.env.DEEPSEEK_API_KEY)).toBeInstanceOf(MockAiProvider);
  });
});
