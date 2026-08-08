/**
 * AI 上下文滑动窗口模块
 *
 * 【模块职责】
 * 把「数据库里的历史消息」加工成「送入 AI 的上下文历史」：
 * - 窗口上限：上下文最多携带 MAX_CONTEXT_HISTORY（20）条历史消息；
 * - 滑动窗口 + 总结：历史消息达到 SUMMARY_THRESHOLD（20，即窗口满）时，
 *   把最早的 (20 - 5) = 15 条压缩为一条摘要放在上下文头部，尾部保留
 *   KEEP_RECENT_MESSAGES（5）条最新原始消息——压缩后上下文变成 6 条，
 *   继续积累到 20 条时再次触发新一轮压缩，周而复始；
 * - 只影响上下文，绝不改动数据库中的历史消息，
 *   因此聊天界面展示的历史记录不受任何影响。
 *
 * 【总结实现说明（语义压缩优先，确定性兜底）】
 * - 传入 SemanticSummarizer 时：优先用 DeepSeek 对最早部分做「语义压缩」
 *   （保留关键事实与说话者脉络，见 summarizer.ts）；AI 调用失败或未配置
 *   API Key 时自动降级为「确定性摘要」；
 *   - 第二次及以后触发时，若上一次摘要仍可衔接（按消息 id 匹配），
 *     走「增量压缩」：以上一次摘要 + 新增的少量消息作为输入，而不是全量重压；
 * - 未传入摘要器：直接使用确定性摘要（压缩空白 + 逐条截断 + 总量预算），
 *   零成本、结果可复现，作为纯函数保留供测试与降级场景使用。
 */
/**
 * 上下文历史消息：role 支持 system（摘要）与 user/assistant（常规消息）
 *
 * @property id 可选的消息 id（数据库主键），仅用于语义摘要器的「增量衔接」：
 *              通过「上一次摘要覆盖到的最后一条消息 id」判断哪些消息是新增的；
 *              该字段不会进入发送给模型的 messages（prompts 组装时忽略）。
 */
export interface AiHistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  id?: string;
}

/**
 * 历史消息摘要器接口（供 buildContextHistory 注入）
 *
 * 【设计说明】
 * 用最小接口而非具体类，让测试可以注入轻量替身；
 * 生产实现为 SemanticSummarizer（语义压缩 + 确定性兜底）。
 */
export interface HistorySummarizer {
  /**
   * 生成历史消息摘要
   *
   * @param messages 需要折叠进摘要的历史消息（时间升序）
   * @param scopeId  可选会话作用域 id（conversationId / groupId）：
   *                 供实现维护「上次摘要覆盖到哪条消息」的增量状态
   * @returns Promise<string> 摘要文本（语义压缩或确定性摘要，调用方无需关心具体实现）
   */
  summarize(messages: AiHistoryMessage[], scopeId?: string): Promise<string>;
}

// 上下文窗口硬上限：未触发总结时最多携带 20 条历史消息
export const MAX_CONTEXT_HISTORY = 20;
// 总结触发阈值：历史达到 20 条（窗口满）时对「最早的 15 条」做总结。
// 设计说明：压缩前 15 条 + 保留最新 5 条 = 6 条，之后继续积累到 20 条再触发。
export const SUMMARY_THRESHOLD = 20;
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
 * @param summarizer 可选的摘要器（配置了 DeepSeek 时注入 SemanticSummarizer；
 *                   未配置/缺省时使用确定性摘要）
 * @param scopeId    可选的会话作用域 id（conversationId / groupId）：
 *                   供语义摘要器维护「上次摘要覆盖到哪条消息」的增量状态
 * @returns AiHistoryMessage[] 上下文历史：
 *   - 少于 SUMMARY_THRESHOLD（20）条：原样返回（最多 MAX_CONTEXT_HISTORY 条）；
 *   - 达到阈值：返回「[摘要] + 最新 KEEP_RECENT_MESSAGES（5）条原始消息」，
 *     摘要覆盖最早的 (20 - 5) = 15 条。
 * 说明：输入数组不会被修改（slice 取子集），调用方可安全复用。
 */
export async function buildContextHistory(
  messages: AiHistoryMessage[],
  summarizer?: HistorySummarizer | null,
  scopeId?: string,
): Promise<AiHistoryMessage[]> {
  if (messages.length < SUMMARY_THRESHOLD) {
    return messages.slice(-MAX_CONTEXT_HISTORY);
  }

  // 防御性截断：即使传入超过 20 条（正常流程 DB 已取最近 20 条），
  // 也先收敛到窗口上限，保证「压缩前 15 条 + 保留最新 5 条」的契约成立
  const windowed = messages.slice(-MAX_CONTEXT_HISTORY);
  // 触发总结：最早的 (20-5)=15 条折叠进摘要，最新 5 条保留原文
  const older = windowed.slice(0, windowed.length - KEEP_RECENT_MESSAGES);
  const recent = windowed.slice(-KEEP_RECENT_MESSAGES);
  // 语义压缩（AI）优先，内部自带确定性兜底与增量衔接；无摘要器时直接确定性摘要
  const summary = summarizer
    ? await summarizer.summarize(older, scopeId)
    : summarizeMessages(older);
  return [{ role: 'system', content: summary }, ...recent];
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
