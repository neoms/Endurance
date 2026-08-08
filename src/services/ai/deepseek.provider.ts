/**
 * DeepSeek AI Provider（OpenAI 兼容 Chat Completions 接口）
 *
 * 【模块职责】
 * 对接 DeepSeek 官方/兼容网关的 `POST /chat/completions`：
 * - 消息组装（系统提示/人设/历史/用户名前缀）委托 prompts 模块，
 *   提示词与代码解耦、独立版本控制（见 prompts.ts）；
 * - 严格遵循 AiProvider 接口，超时/重试由 AiService 统一处理；
 * - 错误分类与 AiService 的重试策略对齐：
 *   * 网络错误 / 429 限流 / 5xx → 可重试（AI_UNAVAILABLE / AI_ABORTED）；
 *   * 4xx（如 401 API Key 无效）→ 不可重试（AI_INVALID_REQUEST），避免无效重试；
 * - 全程不记录 API Key 与请求体内容，只记录状态码/模型/用量等非敏感信息。
 *
 * 【调用约定】
 * 未配置 DEEPSEEK_API_KEY 时不会创建本 Provider（见 provider.factory.ts），
 * 由 MockAiProvider 兜底，保证零配置可运行。
 */
import { logger } from '../../lib/logger.js';
import { AiError } from './errors.js';
import { buildChatMessages } from './prompts.js';
import type {
  AiGenerateContext,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
} from './types.js';

/**
 * DeepSeek Provider 构造参数
 *
 * @property apiKey    DeepSeek API Key（必须）
 * @property baseUrl   API 基础地址（默认 https://api.deepseek.com，末尾自动去斜杠）
 * @property model     模型名（默认 deepseek-v4-flash，思考模式由请求体显式关闭）
 * @property fetchImpl 可注入的 fetch 实现（单元测试用；缺省用全局 fetch）
 */
export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * DeepSeek Chat Completions 响应结构（仅声明用到的字段）
 *
 * @property choices[].message.content 模型生成的回复文本
 * @property usage token 用量（用于日志与排查）
 */
interface DeepSeekChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * DeepSeek Chat Completions 流式响应块结构（SSE 的每条 data）
 *
 * @property choices[].delta.content 本块的增量文本（流式时逐块累积）
 * @property choices[].delta.reasoning_content 思考过程文本（V4 关闭思考时不存在，忽略）
 */
interface DeepSeekChatStreamChunk {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
}

/**
 * DeepSeek AI Provider 实现
 */
export class DeepSeekProvider implements AiProvider {
  readonly name = 'deepseek';

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekProviderOptions) {
    // 去掉末尾斜杠，保证拼出的 URL 为 {baseUrl}/chat/completions
    this.baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model ?? 'deepseek-v4-flash';
    // 注入 fetchImpl 便于测试；生产环境使用全局 fetch（Node 24 内置）
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 生成回复
   *
   * @param context 生成上下文（content / botName / personality / userName / history）
   * @param options 单次调用选项（timeoutMs / signal；超时取消由 AiService 触发）
   * @returns Promise<AiGenerateResult> 模型生成的回复文本
   * @throws AiError（可重试/不可重试由错误分类决定）
   * 主要逻辑：组装 messages → 调用 Chat Completions → 校验 HTTP 状态 →
   * 解析 choices[0].message.content → 返回。
   */
  async generate(
    context: AiGenerateContext,
    options?: AiGenerateOptions,
  ): Promise<AiGenerateResult> {
    // 发起一次性（非流式）请求；网络/HTTP 错误处理统一收敛在私有方法里
    const response = await this.request(context, options, false);

    const data = (await response.json()) as DeepSeekChatResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      // 空内容视为临时故障（可重试），避免把「无回复」误当成功写入消息
      throw new AiError('DeepSeek returned empty content', 'AI_UNAVAILABLE', true);
    }

    logger.debug(
      { model: data.model ?? this.model, usage: data.usage },
      'ai: deepseek reply received',
    );
    return { content };
  }

  /**
   * 流式生成回复（SSE 增量解析）
   *
   * @param context 生成上下文（与 generate 一致）
   * @param options 单次调用选项（signal 透传 fetch；超时取消由 AiService 触发）
   * @returns AsyncIterable<string> 逐块产出增量文本，全部拼接即为完整回复
   * @throws AiError 网络错误/HTTP 错误/流中断（分类与 generate 一致）
   * 主要逻辑：以 stream:true 发起请求 → 逐行解析 SSE 的 data 帧 →
   * 累积 choices[0].delta.content 并逐块产出 → 遇到 [DONE] 结束；
   * 若一个字符都没产出则视为空回复（可重试），避免把空流当成功。
   */
  async *stream(context: AiGenerateContext, options?: AiGenerateOptions): AsyncIterable<string> {
    // 流式请求：headers/鉴权/thinking 开关等逻辑与 generate 完全一致
    const response = await this.request(context, options, true);

    // 读取响应体字节流；拿不到 reader 视为服务端异常（可重试）
    const reader = response.body?.getReader();
    if (!reader) {
      throw new AiError('DeepSeek stream body unavailable', 'AI_UNAVAILABLE', true);
    }

    const decoder = new TextDecoder();
    // SSE 按行到达，跨 chunk 的半行暂存在 buffer 里，等完整行再解析
    let buffer = '';
    let yieldedAny = false;
    // 是否收到上游 [DONE] 结束标记（决定是否提前结束读取）
    let streamDone = false;

    try {
      // 循环读取字节流，直到服务端结束（done=true）
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // 按换行符切出完整行处理（多余字节留在 buffer 等待下个 chunk）
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) {
            // 非 data 行（如注释/心跳/空行）直接忽略
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            // 上游结束标记：跳出逐行处理与字节读取两层循环
            streamDone = true;
            break;
          }
          try {
            const chunk = JSON.parse(payload) as DeepSeekChatStreamChunk;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              yieldedAny = true;
              yield delta;
            }
          } catch {
            // 个别 data 帧无法解析：记录日志后跳过，不让整个流崩掉
            logger.warn({ payload: payload.slice(0, 120) }, 'ai: deepseek stream parse error');
          }
        }
        if (streamDone) {
          break;
        }
      }
    } catch (err) {
      // 信号中止（空闲超时/客户端断连）→ 可重试错误，交给 AiService 决策
      if (options?.signal?.aborted) {
        throw new AiError('DeepSeek stream aborted', 'AI_ABORTED', true);
      }
      // 网络层中断（连接被上游掐断等）→ 可重试错误
      logger.warn({ err }, 'ai: deepseek stream interrupted');
      throw new AiError(
        err instanceof Error ? err.message : 'DeepSeek stream error',
        'AI_UNAVAILABLE',
        true,
      );
    }

    // 流正常结束但一个字符都没有：按空回复处理（可重试），避免把空流当成功
    if (!yieldedAny) {
      throw new AiError('DeepSeek returned empty stream', 'AI_UNAVAILABLE', true);
    }
  }

  /**
   * 发起 Chat Completions 请求（流式/非流式共用）
   *
   * @param context 生成上下文（组装 messages）
   * @param options 单次调用选项（signal 透传）
   * @param stream  是否流式（true → body.stream=true，返回后由调用方解析 SSE）
   * @returns Promise<Response> 已确认非错误状态的 HTTP 响应
   * @throws AiError 网络错误（可重试）或 HTTP 错误（429/5xx 可重试，其余 4xx 不可重试）
   */
  private async request(
    context: AiGenerateContext,
    options: AiGenerateOptions | undefined,
    stream: boolean,
  ): Promise<Response> {
    // 消息组装全部来自 prompts 模块（纯函数，提示词集中管理、可单测）
    const messages = buildChatMessages(context);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Bearer 鉴权；该请求头不会进入应用日志（pino-http 对 Authorization 脱敏）
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.8,
          max_tokens: 1024,
          stream,
          // deepseek-v4-flash 默认开启思考模式；本应用按需求显式关闭，
          // 换取更低延迟与更快响应（快速问答场景不需要深度推理）。
          // 注意：thinking 开关仅 V4 系列支持；其他模型（如 deepseek-chat）
          // 不携带该字段，避免上游对未知参数报错。
          ...(this.model.startsWith('deepseek-v4') ? { thinking: { type: 'disabled' } } : {}),
        }),
        // 把 AiService 的超时取消信号透传给 fetch：超时后底层请求被真正中止
        signal: options?.signal,
      });
    } catch (err) {
      // 信号中止（超时/手动取消）→ 可重试错误，交给 AiService 继续重试
      if (options?.signal?.aborted) {
        throw new AiError('DeepSeek request aborted', 'AI_ABORTED', true);
      }
      // 网络层错误（DNS/连接拒绝/超时未中止等）→ 可重试
      logger.warn({ err }, 'ai: deepseek network failure');
      throw new AiError(
        err instanceof Error ? err.message : 'DeepSeek network error',
        'AI_UNAVAILABLE',
        true,
      );
    }

    if (!response.ok) {
      // 读取错误响应体（可能很大，只截取前 500 字符）。
      // 注意：上游错误体可能回显脱敏后的 key 片段（如 401 的 "****abcd"），
      // 因此只写 debug 日志，绝不放入持久化的 errorMessage（避免敏感信息落库）。
      const errorBody = await response.text().catch(() => '');
      // 429 限流与 5xx 服务端错误属于临时故障 → 可重试；
      // 其余 4xx（401 Key 无效、400 参数错误等）重试无意义 → 不可重试
      const retryable = response.status === 429 || response.status >= 500;
      logger.debug(
        { status: response.status, retryable, errorBody: errorBody.slice(0, 500) },
        'ai: deepseek http error',
      );
      throw new AiError(
        `DeepSeek API error ${response.status}`,
        retryable ? 'AI_UNAVAILABLE' : 'AI_INVALID_REQUEST',
        retryable,
      );
    }

    return response;
  }
}
