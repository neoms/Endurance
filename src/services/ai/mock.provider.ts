/**
 * Mock AI Provider（默认实现）
 *
 * 【模块职责】
 * 在没有真实 AI API 的情况下模拟回复，保证演示与测试稳定：
 * - echo：回显用户消息（默认，便于展示「多轮问答」效果）；
 * - random：从固定话术库随机回复。
 *
 * 【测试支持】
 * - failTimes：前 N 次调用抛可重试错误（验证重试/失败标记逻辑）；
 * - delayMs：模拟响应延迟（配合 AiService 超时逻辑测试）。
 */
import { AiError } from './errors.js';
import type {
  AiGenerateContext,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
} from './types.js';

// random 模式的话术库
const RANDOM_REPLIES = [
  '这个想法很有意思，能展开讲讲吗？',
  '收到！让我想想怎么帮你。',
  '嗯嗯，我在听，继续说～',
  '好的，已记录。这是一条模拟回复。',
];

/**
 * Mock Provider 选项
 *
 * @property mode      echo：回显；random：随机话术
 * @property failTimes 前 N 次调用抛可重试错误（测试故障注入）
 * @property delayMs   模拟响应延迟（毫秒）
 */
export interface MockAiProviderOptions {
  mode?: 'echo' | 'random';
  failTimes?: number;
  delayMs?: number;
}

export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  // 已注入的失败次数计数（用于 failTimes 故障注入）
  private failureCount = 0;

  constructor(private readonly options: MockAiProviderOptions = {}) {}

  /**
   * 生成回复
   *
   * @param context 生成上下文（content 必填；botName 用于回复前缀）
   * @param _options 单次选项（Mock 不感知超时，超时由 AiService 统一包装）
   * @returns Promise<AiGenerateResult> 模拟回复
   * @throws AiError(AI_UNAVAILABLE, retryable) 当处于故障注入窗口内
   */
  async generate(
    context: AiGenerateContext,
    _options?: AiGenerateOptions,
  ): Promise<AiGenerateResult> {
    // 模拟网络延迟
    if (this.options.delayMs) {
      await sleep(this.options.delayMs);
    }
    // 故障注入：前 failTimes 次调用抛出可重试错误
    if (this.failureCount < (this.options.failTimes ?? 0)) {
      this.failureCount += 1;
      throw new AiError('Mock provider simulated failure', 'AI_UNAVAILABLE', true);
    }

    // 机器人有名字时带上前缀，方便群组场景区分发言者
    const prefix = context.botName ? `${context.botName}：` : '';
    if (this.options.mode === 'random') {
      const reply = RANDOM_REPLIES[Math.floor(Math.random() * RANDOM_REPLIES.length)];
      return { content: `${prefix}${reply}` };
    }
    return { content: `${prefix}你说：「${context.content}」——这是一条模拟回复。` };
  }
}

/**
 * 延时工具
 *
 * @param ms 毫秒数
 * @returns Promise<void> 到点后 resolve
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
