/**
 * Mock AI Provider（默认实现）
 *
 * 【模块职责】
 * 在没有真实 AI API 的情况下模拟回复，保证演示与测试稳定：
 * - echo：回显用户消息（默认，便于展示「多轮问答」效果）；
 * - random：从固定话术库随机回复。
 * - 流式：generate 与 stream 都可用；stream 把完整回复按固定长度切块、
 *   按 streamChunkDelayMs 间隔逐块产出，模拟真实 API 的「打字机」效果；
 * - 支持取消：监听 options.signal，被 abort（如 AiService 超时）时立即抛出可重试错误，
 *   避免底层调用悬挂。
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
 * @property streamChunkDelayMs 流式时每块之间的间隔（毫秒，默认 20，演示更真实）
 */
export interface MockAiProviderOptions {
  mode?: 'echo' | 'random';
  failTimes?: number;
  delayMs?: number;
  streamChunkDelayMs?: number;
}

// 流式切块长度：按字符数切分回复，模拟 token 级增量输出
const STREAM_CHUNK_SIZE = 4;

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
    options?: AiGenerateOptions,
  ): Promise<AiGenerateResult> {
    await this.beforeGenerate(options);

    // 机器人生成逻辑收敛为纯函数，generate 与 stream 复用同一份回复内容
    return { content: this.buildReply(context) };
  }

  /**
   * 流式生成回复（分块产出完整回复文本）
   *
   * @param context 生成上下文（与 generate 一致）
   * @param options 单次选项（signal 用于取消；块间延迟见 streamChunkDelayMs）
   * @returns AsyncIterable<string> 逐块产出文本，拼接后与 generate 结果完全一致
   * @throws AiError(AI_UNAVAILABLE, retryable) 处于故障注入窗口或已被取消
   */
  async *stream(context: AiGenerateContext, options?: AiGenerateOptions): AsyncIterable<string> {
    await this.beforeGenerate(options);

    const reply = this.buildReply(context);
    // 按固定长度切块：完整的「多轮问答」演示效果，同时保证拼接结果稳定可测
    const chunks: string[] = [];
    for (let i = 0; i < reply.length; i += STREAM_CHUNK_SIZE) {
      chunks.push(reply.slice(i, i + STREAM_CHUNK_SIZE));
    }
    if (chunks.length === 0) {
      chunks.push('');
    }

    for (const chunk of chunks) {
      // 每个块产出前检查取消：客户端断连/超时后立即停止，不再产出
      if (options?.signal?.aborted) {
        throw new AiError('AI request aborted', 'AI_ABORTED', true);
      }
      // 块间延迟：模拟真实模型逐 token 返回的节奏（测试可传 0 关闭）
      if (this.options.streamChunkDelayMs) {
        await sleep(this.options.streamChunkDelayMs, options?.signal);
      }
      yield chunk;
    }
  }

  /**
   * 生成前的公共前置处理：取消检查、模拟延迟、故障注入
   *
   * @param options 单次选项（signal 用于取消）
   * @returns Promise<void>
   * @throws AiError(AI_ABORTED / AI_UNAVAILABLE) 已取消或处于故障注入窗口
   */
  private async beforeGenerate(options?: AiGenerateOptions): Promise<void> {
    // 已被取消（如超时触发的 abort）：立即抛出，不再执行
    if (options?.signal?.aborted) {
      throw new AiError('AI request aborted', 'AI_ABORTED', true);
    }
    // 模拟网络延迟
    if (this.options.delayMs) {
      await sleep(this.options.delayMs, options?.signal);
    }
    // 延迟期间被取消：同样立即抛出（信号可能在 sleep 中触发）
    if (options?.signal?.aborted) {
      throw new AiError('AI request aborted', 'AI_ABORTED', true);
    }
    // 故障注入：前 failTimes 次调用抛出可重试错误
    if (this.failureCount < (this.options.failTimes ?? 0)) {
      this.failureCount += 1;
      throw new AiError('Mock provider simulated failure', 'AI_UNAVAILABLE', true);
    }
  }

  /**
   * 构建完整回复文本（generate 与 stream 共用的纯函数）
   *
   * @param context 生成上下文（content / botName / userName）
   * @returns string 完整回复文本
   * 说明：
   * - 内容里**不再写 NPC 自己的名字前缀**：发言者由前端头像/名字标签与
   *   群组历史上下文的前缀逻辑负责（见 group.service.ts buildGroupHistory），
   *   避免「存库带前缀 + 历史再拼前缀」导致双重前缀、模型模仿出多重前缀；
   * - 回显消息使用「发送者用户名说：」而不是写死「你说」——
   *   用户名由消息服务在调用时传入（个人对话取当前用户，群组取实际发言成员）。
   */
  private buildReply(context: AiGenerateContext): string {
    if (this.options.mode === 'random') {
      return RANDOM_REPLIES[Math.floor(Math.random() * RANDOM_REPLIES.length)] ?? '';
    }
    // 回显消息时带上「发送者用户名」，而不是写死「你说」——
    // 用户名由消息服务在调用时传入（个人对话取当前用户，群组取实际发言成员）。
    return `${context.userName ?? '用户'}说：「${context.content}」——这是一条模拟回复。`;
  }
}

/**
 * 延时工具
 *
 * @param ms     毫秒数
 * @param signal 可选取消信号：被 abort 时立即以可重试错误拒绝
 * @returns Promise<void> 到点后 resolve；被取消时 reject
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // 函数声明提升：setTimeout 回调中引用 onAbort 是安全的（回调总是晚于声明执行）
    function onAbort() {
      clearTimeout(timer);
      reject(new AiError('AI request aborted', 'AI_ABORTED', true));
    }

    if (!signal) {
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
