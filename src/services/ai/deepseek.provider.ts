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
 * @property model     模型名（默认 deepseek-chat）
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
    this.model = options.model ?? 'deepseek-chat';
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
          stream: false,
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
}
