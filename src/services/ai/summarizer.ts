/**
 * 历史消息语义摘要器（SemanticSummarizer）
 *
 * 【模块职责】
 * 为上下文滑动窗口提供「语义压缩」能力（见 context.ts 的总结阈值逻辑）：
 * - 配置了 DeepSeek API Key 时：调用 DeepSeek（deepseek-v4-flash，思考模式由
 *   DeepSeekProvider 显式关闭）把最早部分的历史消息压缩成语义摘要，
 *   保留确定性算法容易丢失的语义关联与说话者脉络；
 * - 未配置 API Key 或 AI 调用失败时：**降级回退到确定性摘要**
 *   （context.ts 的 summarizeMessages，压缩空白 + 逐条截断 + 总量预算），
 *   保证总结永不阻塞对话流程；
 * - **增量衔接（方案：满 20 条压缩前 15 条，压缩后 6 条再积累到 20 条）**：
 *   * 第一次触发时全量压缩，并记录「这份摘要覆盖到的最后一条消息 id」；
 *   * 第二次及以后触发时，通过 scopeId 找到上次摘要状态：若上次覆盖的最后一条
 *     消息仍存在于本次待压缩集合中，只把「上次摘要 + 其后新增的消息」送入模型
 *     做增量融合（SUMMARY_INCREMENTAL_SYSTEM_PROMPT），而不是对全部 15 条重压——
 *     输入从 15 条消息降到「约 300 字摘要 + 数条新消息」，显著降低延迟与 token 成本；
 *   * 衔接不上（历史被清空 / 进程重启 / 消息 id 缺失）时自动退化为全量压缩；
 * - 摘要结果按「历史消息集合」做进程内 TTL 缓存（复用 AiReplyCache）：
 *   同一份旧消息只在第一次真正调用 AI，重试/重复构建上下文时直接回放，
 *   避免反复为同一份历史付费；
 * - 只缓存成功结果：AI 失败时走确定性兜底且不写缓存（下次仍尝试语义压缩）。
 *
 * 【健壮性设计】
 * 语义压缩复用 AiService.generateWithRetry（超时真正 abort、可重试错误指数退避），
 * 但把重试上限降到 1、超时降到 8s：摘要只是上下文的前置加工，不值得拖长主回复延迟；
 * 任何异常（超时/网络/限流/空结果）都收敛为确定性兜底并记录结构化日志。
 */
import { logger } from '../../lib/logger.js';
import type { AiService } from './ai.service.js';
import { AiReplyCache, cacheKey } from './cache.js';
import { summarizeMessages, type AiHistoryMessage, type HistorySummarizer } from './context.js';
import { SUMMARY_INCREMENTAL_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from './prompts.js';

// 语义压缩输入预算（字符）：一次送入模型的文本上限（全量=全部旧消息；
// 增量=已有摘要 + 新增消息）。超过预算时截断并标注，防止超长历史推高请求成本与延迟。
const SUMMARY_INPUT_BUDGET = 8000;
// 语义压缩单次调用配置：1 次重试 + 8s 超时（比主回复更保守，见文件头说明）
const SUMMARY_RETRY_OPTIONS = { maxRetries: 1, timeoutMs: 8_000 } as const;
// 会话级增量状态上限：超过后淘汰最早一条（Map 按插入序迭代），防止长期运行内存膨胀
const MAX_SCOPE_STATES = 500;

/**
 * 会话级增量摘要状态
 *
 * @property summary       上一次语义压缩产出的摘要文本
 * @property lastMessageId 该摘要覆盖到的最后一条消息 id（用于下次增量衔接）
 */
interface SummaryState {
  summary: string;
  lastMessageId: string;
}

/**
 * 历史消息语义摘要器
 *
 * @param aiService 可用的 AI 服务（DeepSeek 配置后传入；null 表示未配置 → 恒走确定性兜底）
 * @param cache     可选的进程内缓存（复用 AI 回复缓存实例；缺省不缓存）
 */
export class SemanticSummarizer implements HistorySummarizer {
  // 会话作用域 id（conversationId / groupId）→ 最近一次语义摘要状态
  private readonly states = new Map<string, SummaryState>();

  constructor(
    private readonly aiService: AiService | null,
    private readonly cache?: AiReplyCache | null,
  ) {}

  /**
   * 生成历史消息摘要（语义优先，失败降级确定性）
   *
   * @param messages 需要折叠进摘要的历史消息（时间升序，content 已带发言者前缀）
   * @param scopeId  可选会话作用域 id（conversationId / groupId）：用于增量衔接，
   *                 第二次及以后触发时只压缩「上次摘要 + 新增消息」而非全量重压
   * @returns Promise<string> 摘要文本
   * 主要逻辑：
   * 1. 未配置 AI → 直接走确定性摘要（原方案）；
   * 2. 缓存命中 → 回放上次语义摘要（键 = 会话 + 角色 + 内容全集的哈希）；
   * 3. 增量路径：存在上次摘要状态，且其覆盖的最后一条消息能在本次集合中找到
   *    （且不是最后一条）→ 以「上次摘要 + 新增消息」做增量融合；
   * 4. 全量路径：把消息拼成单段文本（带 [user]/[assistant] 角色标记），
   *    以 SUMMARY_SYSTEM_PROMPT 覆盖系统提示词调用 AI 压缩；
   * 5. 任意路径成功且非空 → 写缓存 + 更新增量状态并返回；
   *    全部失败/空结果 → 确定性兜底。
   */
  async summarize(messages: AiHistoryMessage[], scopeId?: string): Promise<string> {
    // 未配置 DeepSeek：语义压缩不可用，直接使用确定性摘要（原方案）
    if (!this.aiService) {
      logger.debug(
        { count: messages.length },
        'summary: semantic summarizer disabled (no API key), using deterministic',
      );
      return summarizeMessages(messages);
    }

    // 空集合无需压缩（防御分支）
    if (messages.length === 0) {
      return summarizeMessages(messages);
    }

    // 缓存键：会话 + 历史消息全集（角色 + 内容）的哈希——内容变了就重新压缩；
    // 与 AI 回复缓存共用同一实例，键前缀 history-summary 保证不会互相覆盖
    const cacheKeyStr = cacheKey([
      'history-summary',
      scopeId ?? '',
      ...messages.map((m) => `${m.role}:${m.content}`),
    ]);
    const cached = this.cache?.get<string>(cacheKeyStr);
    if (cached) {
      logger.debug(
        { scopeId, count: messages.length, cacheKey: cacheKeyStr },
        'summary: semantic summary cache hit',
      );
      return cached;
    }

    // 本次待压缩集合的最后一条消息 id：增量状态记录到它为止
    const lastMessageId = messages[messages.length - 1]?.id;

    // ── 增量路径（仅当有会话作用域、有上次状态、且能衔接上）──
    if (scopeId && lastMessageId) {
      const state = this.states.get(scopeId);
      if (state) {
        // 在本次集合中定位「上次摘要覆盖到的最后一条消息」：
        // 找到且不是最后一条 → 其后即为新增消息，可做增量融合
        const anchorIndex = messages.findIndex((m) => m.id === state.lastMessageId);
        if (anchorIndex >= 0 && anchorIndex < messages.length - 1) {
          const appended = messages.slice(anchorIndex + 1);
          const input = `已有摘要：\n${state.summary}\n\n新增消息：\n${formatMessages(appended)}`;
          const summary = await this.compressWithAi(input, SUMMARY_INCREMENTAL_SYSTEM_PROMPT);
          if (summary) {
            this.states.set(scopeId, { summary, lastMessageId });
            this.cache?.set(cacheKeyStr, summary);
            logger.info(
              {
                scopeId,
                count: messages.length,
                appendedCount: appended.length,
                cacheKey: cacheKeyStr,
                summaryLength: summary.length,
              },
              'summary: incremental semantic summary generated',
            );
            return summary;
          }
          // 增量调用失败：不立即降级确定性，继续尝试全量压缩（质量优先）
          logger.warn(
            { scopeId, count: messages.length },
            'summary: incremental summary failed, retrying full compression',
          );
        }
      }
    }

    // ── 全量路径 ──
    const summary = await this.compressWithAi(formatMessages(messages), SUMMARY_SYSTEM_PROMPT);
    if (summary) {
      // 只缓存成功结果：下次命中直接回放，避免同一份历史重复付费
      this.cache?.set(cacheKeyStr, summary);
      // 更新增量状态（带 id 才可衔接；无 id 时删除旧状态，避免误衔接）
      if (scopeId) {
        if (lastMessageId) {
          this.rememberState(scopeId, { summary, lastMessageId });
        } else {
          this.states.delete(scopeId);
        }
      }
      logger.info(
        { scopeId, count: messages.length, cacheKey: cacheKeyStr, summaryLength: summary.length },
        'summary: semantic summary generated',
      );
      return summary;
    }

    // AI 失败（超时/网络/限流）或返回空文本：绝不阻塞对话，降级为确定性摘要
    logger.warn(
      { scopeId, count: messages.length },
      'summary: semantic summary failed, falling back to deterministic',
    );
    return summarizeMessages(messages);
  }

  /**
   * 记录会话级增量状态（带容量上限，防止长期运行内存膨胀）
   *
   * @param scopeId 会话作用域 id
   * @param state   摘要状态（摘要文本 + 覆盖到的最后一条消息 id）
   * @returns void
   * 逻辑：Map 超限时删除最早插入的一条（Map 按键插入顺序迭代），再写入新状态。
   */
  private rememberState(scopeId: string, state: SummaryState): void {
    if (this.states.size >= MAX_SCOPE_STATES) {
      const oldestKey = this.states.keys().next().value;
      if (oldestKey) {
        this.states.delete(oldestKey);
      }
    }
    this.states.set(scopeId, state);
  }

  /**
   * 调用 AI 生成摘要（全量/增量共用），失败或空结果返回 null
   *
   * @param inputText   送入模型的文本（全量=全部消息；增量=已有摘要 + 新增消息）
   * @param systemPrompt 摘要系统提示词（全量 / 增量各自专用）
   * @returns Promise<string | null> 非空摘要文本；AI 失败或空结果返回 null
   * 逻辑：截断超长输入（预算保护）→ generateWithRetry（超时/重试）→ trim；
   * 空文本视为失败（与主回复「空内容可重试」同理），由调用方决定兜底。
   */
  private async compressWithAi(inputText: string, systemPrompt: string): Promise<string | null> {
    // 输入预算保护：超过阈值截断并标注，防止超长历史推高请求成本与延迟
    const content =
      inputText.length > SUMMARY_INPUT_BUDGET
        ? `${inputText.slice(0, SUMMARY_INPUT_BUDGET)}\n…（超出预算，已截断）`
        : inputText;
    try {
      // systemPromptOverride 让这次调用走「摘要器」提示词而非闲聊人设；
      // 思考模式关闭、鉴权与错误分类全部由 DeepSeekProvider 统一处理
      const result = await this.aiService!.generateWithRetry(
        { content, history: [], systemPromptOverride: systemPrompt },
        SUMMARY_RETRY_OPTIONS,
      );
      const summary = result.trim();
      return summary || null;
    } catch (err) {
      logger.warn({ err }, 'summary: ai call failed');
      return null;
    }
  }
}

/**
 * 把历史消息拼成单段文本（带 [user]/[assistant] 角色标记）
 *
 * @param messages 历史消息（时间升序）
 * @returns string 模型可直接压缩的文本
 * 说明：群组内容本身已带「名字：」前缀，角色标记用于个人对话区分用户/AI 发言；
 * 单条消息过长时由 compressWithAi 的总预算统一截断。
 */
function formatMessages(messages: AiHistoryMessage[]): string {
  return messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
}
