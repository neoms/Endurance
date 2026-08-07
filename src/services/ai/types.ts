/**
 * AI Provider 抽象层类型定义
 *
 * 【设计说明】
 * 通过统一接口隔离具体 AI 实现（Mock / 真实 API），
 * 业务侧（AiService 与消息服务）只依赖该接口，
 * 便于替换实现、测试注入故障，以及后续对接真实 AI API。
 */

/**
 * AI Provider 接口：任何能生成回复的服务都实现它
 */
export interface AiProvider {
  readonly name: string;
  generate(context: AiGenerateContext, options?: AiGenerateOptions): Promise<AiGenerateResult>;
}

/**
 * 生成回复所需的上下文
 *
 * @property content     当前用户消息内容
 * @property botName     机器人名称（群组场景用于回复前缀，可选）
 * @property personality 机器人性格描述（可选，供真实 AI 参考人设）
 * @property history     最近对话历史（role: user/assistant），供上下文理解
 */
export interface AiGenerateContext {
  content: string;
  botName?: string;
  personality?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * 单次生成选项
 *
 * @property timeoutMs 单次调用超时（毫秒）
 */
export interface AiGenerateOptions {
  timeoutMs?: number;
}

/**
 * 生成结果
 *
 * @property content 生成的回复文本
 */
export interface AiGenerateResult {
  content: string;
}

/**
 * 重试策略选项
 *
 * @property maxRetries       重试次数（总尝试 = maxRetries + 1）
 * @property timeoutMs        单次超时（毫秒）
 * @property baseRetryDelayMs 退避基准延迟（毫秒），实际延迟 = base * 2^attempt + 抖动
 */
export interface AiRetryOptions {
  maxRetries?: number;
  timeoutMs?: number;
  baseRetryDelayMs?: number;
}
