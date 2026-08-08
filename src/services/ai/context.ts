/**
 * AI 上下文滑动窗口模块
 *
 * 【模块职责】
 * 把「数据库里的历史消息」加工成「送入 AI 的上下文历史」：
 * - 窗口上限：上下文最多携带 MAX_CONTEXT_HISTORY（20）条历史消息；
 * - 滑动窗口 + 总结：历史消息达到 SUMMARY_THRESHOLD（15）条时，
 *   把最早的部分压缩为一条摘要放在上下文头部，尾部只保留 KEEP_RECENT_MESSAGES（5）条
 *   最新原始消息，保证模型始终能看到「完整的早期脉络 + 最近细节」；
 * - 纯函数设计：只影响上下文，绝不改动数据库中的历史消息，
 *   因此聊天界面展示的历史记录不受任何影响。
 *
 * 【总结实现说明】
 * 当前采用「确定性摘要」（压缩空白 + 逐条截断 + 总量预算），优点：
 * - 无额外 AI 调用（不增加请求成本与延迟）；
 * - 每次计算结果一致（可测试、可复现）；
 * - 无持久化需求（不依赖总结结果落库）。
 * 若后续需要语义级总结，可在 summarizeMessages 中替换为 AI 调用
 * （需配套持久化缓存与失败兜底，见 docs/DESIGN.md 的权衡说明）。
 */

/** 上下文历史消息：role 支持 system（摘要）与 user/assistant（常规消息） */
export interface AiHistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 上下文窗口硬上限：未触发总结时最多携带 20 条历史消息
export const MAX_CONTEXT_HISTORY = 20;
// 总结触发阈值：历史达到 15 条时对「最早部分」做总结
export const SUMMARY_THRESHOLD = 15;
// 总结后保留的最新原始消息条数
export const KEEP_RECENT_MESSAGES = 5;
// 单条消息在摘要中保留的最大字符数（超过截断加省略号）
const MESSAGE_BUDGET = 120;
// 摘要总字符预算：防止摘要本身占用过多上下文
const SUMMARY_BUDGET = 800;

/**
 * 构建送入 AI 的上下文历史（滑动窗口 + 总结）
 *
 * @param messages 按时间升序排列的历史消息（content 已带发言者前缀，见各服务组装处）
 * @returns AiHistoryMessage[] 上下文历史：
 *   - 少于 SUMMARY_THRESHOLD 条：原样返回（最多 MAX_CONTEXT_HISTORY 条）；
 *   - 达到阈值：返回「[摘要] + 最新 KEEP_RECENT_MESSAGES 条原始消息」，
 *     摘要覆盖最早 (总数 - KEEP_RECENT_MESSAGES) 条。
 * 说明：输入数组不会被修改（slice 取子集），调用方可安全复用。
 */
export function buildContextHistory(messages: AiHistoryMessage[]): AiHistoryMessage[] {
  if (messages.length < SUMMARY_THRESHOLD) {
    return messages.slice(-MAX_CONTEXT_HISTORY);
  }

  // 触发总结：最早部分折叠进摘要，最新 KEEP_RECENT_MESSAGES 条保留原文
  const older = messages.slice(0, messages.length - KEEP_RECENT_MESSAGES);
  const recent = messages.slice(-KEEP_RECENT_MESSAGES);
  return [{ role: 'system', content: summarizeMessages(older) }, ...recent];
}

/**
 * 生成历史消息摘要（确定性算法）
 *
 * @param messages 需要折叠进摘要的历史消息（时间升序，content 已带发言者前缀）
 * @returns string 摘要文本，格式：
 *   「[历史消息摘要 · 共 N 条] 消息1；消息2；…」
 * 逻辑：逐条压缩空白（多行折叠为单行）、按单条预算截断、
 * 累计超过总预算即停止，最后用「；」拼接并标注折叠条数。
 */
export function summarizeMessages(messages: AiHistoryMessage[]): string {
  const parts: string[] = [];
  let used = 0;

  for (const message of messages) {
    // 压缩空白：把换行/连续空格折叠为单个空格，显著缩小体积
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    // 单条截断
    const part = text.length > MESSAGE_BUDGET ? `${text.slice(0, MESSAGE_BUDGET)}…` : text;
    // 总量预算（含分隔符「；」约 2 字符）
    if (used + part.length + 2 > SUMMARY_BUDGET) {
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }

  return `[历史消息摘要 · 共 ${messages.length} 条] ${parts.join('；')}`;
}
