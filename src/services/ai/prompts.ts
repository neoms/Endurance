/**
 * AI 提示词（Prompt）模块
 *
 * 【模块职责】
 * 集中管理全部 AI 提示词模板与消息组装，与 Provider（API 传输适配器）解耦：
 * - 提示词属于「产品文案/提示工程」，应独立于具体 AI 服务商（DeepSeek/OpenAI/…）
 *   维护与演进——Provider 只负责把 messages 发出去；
 * - 提示词独立成文件后拥有独立的 git 历史，便于单独评审、回滚与版本控制；
 * - 全部为纯函数：只依赖入参 context，无外部状态，可直接单元测试。
 *
 * 【维护约定】
 * 修改提示词时只改本文件（及对应单测），Provider 内不应再出现提示词文案。
 * 若后续需要「提示词模板文件」（如 prompts/*.md）按环境加载，也只需替换本模块内部实现，
 * 对外函数签名保持不变。
 */
import type { AiGenerateContext } from './types.js';
import type { AiHistoryMessage } from './context.js';

// OpenAI 兼容接口的消息角色（system 人设/摘要、user 人类、assistant 机器人/AI）
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * 构建系统提示词
 *
 * @param context AI 生成上下文（botName / personality 用于群组机器人人设）
 * @returns string 系统提示词：
 *   - 群组机器人（有 personality）：名字 + 角色扮演指令 + 完整人设提示词（原样注入）；
 *   - 群组机器人（无 personality）：仅名字 + 通用群聊约束（兜底）；
 *   - 个人对话（无 botName）：通用助手提示。
 */
export function buildSystemPrompt(context: AiGenerateContext): string {
  if (context.botName && context.personality) {
    // 人设提示词来自数据库 bots.personality（完整角色设定，见 prisma/seed.ts），
    // 原样注入并附加「群聊沉浸」通用规则：第一人称扮演、口语化对话、
    // 不替别人发言、不用 emoji，避免模型把长设定当普通上下文忽略或写成书面报告。
    // 【重要】这里统一用「角色」而不是「机器人」：预设里既有机器人（塔斯/凯斯），
    // 也有人类角色（库珀/布兰德/罗米利/道尔），身份由人设提示词自行声明。
    // 包装层若写死「你是机器人」，会盖过人设、让人类角色也以机械口吻回答。
    return `你是群聊中的角色「${context.botName}」。请严格按照以下角色设定扮演，用中文回复：
- 始终以第一人称、角色本人的身份与口吻说话，保持人设与说话风格；
- 像真实群聊一样自然交流：口语化、有来有往，回复长度适中，不要写长篇报告；
- 不要替其他角色或用户发言，不要跳出角色，不要自称是 AI 助手；
- 不使用 emoji 或网络流行语。
角色设定：\n${context.personality}`;
  }
  if (context.botName) {
    // 无人设兜底：同样使用中性「角色」表述，避免强加机器人身份
    return `你是群聊中的角色「${context.botName}」。请用中文简洁自然地回复群聊消息，不要自称是 AI 助手。`;
  }
  return '你是一个乐于助人的 AI 助手，请用中文简洁、准确地回答用户问题。';
}

/**
 * 历史消息语义压缩的系统提示词
 *
 * 【用途】
 * 上下文滑动窗口达到总结阈值时（见 context.ts），由 SemanticSummarizer 调用
 * DeepSeek 把最早部分压缩成语义摘要（替代确定性截断摘要）。
 *
 * 【设计要点】
 * - 明确要求「只输出摘要本身」：避免模型在摘要前后附加解释文字或角色前缀；
 * - 要求保留关键事实、结论与说话者脉络：语义压缩的意义在于保留确定性算法
 *   会丢失的「语义关联」；
 * - 限制摘要长度：控制上下文占用，与确定性摘要的总量预算（800 字符）目的一致；
 * - 思考模式关闭由 DeepSeekProvider 统一处理（V4 模型显式 thinking.disabled），
 *   此处不涉及具体服务商。
 */
export const SUMMARY_SYSTEM_PROMPT = `你是聊天历史摘要器。请把用户提供的一段多轮对话历史压缩成简洁的中文摘要，要求：
- 保留关键事实、结论、问题与回答的脉络，以及主要说话者的身份；
- 用要点式短句概括，不要逐条复述原话，不要遗漏重要转折；
- 只输出摘要本身，不要任何解释、标题、前缀或引号；
- 摘要控制在 300 字以内。`;

/**
 * 历史消息「增量」语义压缩的系统提示词
 *
 * 【用途】
 * 上下文滑动窗口第二次及以后触发时（见 context.ts），上一轮已把较早消息压缩成
 * 一份摘要。此时不必对全部旧消息重新压缩，只需把「已有摘要 + 新追加的少量消息」
 * 合并成一份覆盖全部内容的新摘要——输入更小、调用更快、语义连贯。
 *
 * 【设计要点】
 * - 输入固定为「已有摘要 + 新增消息」两段，模型负责把二者融成一份连贯新摘要，
 *   避免输出「旧摘要 + 追加」的拼接感；
 * - 输出约束与 SUMMARY_SYSTEM_PROMPT 一致（只输出摘要、控制长度）。
 */
export const SUMMARY_INCREMENTAL_SYSTEM_PROMPT = `你是聊天历史摘要器。用户会提供「已有摘要」和「新增的多轮对话消息」：
- 已有摘要：之前压缩过的早期对话，需要保留其中的关键事实与脉络；
- 新增消息：已有摘要之后新发生的对话。
请把两者融合成一份覆盖全部内容的简洁中文摘要，要求：
- 保留已有摘要中的关键事实、结论与说话者脉络，并纳入新增消息中的新信息；
- 不要重复已有摘要的原文，也不要把新增消息逐条复述；
- 用要点式短句概括，只输出融合后的摘要本身，不要任何解释、标题、前缀或引号；
- 摘要控制在 300 字以内。`;

/**
 * 组装 Chat Completions 的完整 messages（系统提示 + 历史 + 当前用户消息）
 *
 * @param context AI 生成上下文
 * @returns Array<{ role: ChatRole; content: string }> 可直接提交给模型的 messages
 * 说明：
 * - 系统提示由 buildSystemPrompt 生成（人设）；
 * - 历史消息按原顺序透传（含滑动窗口产生的 system 摘要，见 context.ts）；
 * - 当前用户消息在群组场景附带发送者用户名前缀（如「alice：你好」），
 *   帮助模型区分「谁在说话」。
 */
export function buildChatMessages(
  context: AiGenerateContext,
): Array<{ role: ChatRole; content: string }> {
  const messages: Array<{ role: ChatRole; content: string }> = [
    // 允许调用方覆盖系统提示词（如历史摘要任务不需要闲聊人设）；
    // 缺省时仍按 botName/personality 生成人设提示词
    { role: 'system', content: context.systemPromptOverride ?? buildSystemPrompt(context) },
  ];
  for (const item of context.history ?? []) {
    messages.push({ role: item.role, content: item.content });
  }
  const userContent = context.userName
    ? `${context.userName}：${context.content}`
    : context.content;
  messages.push({ role: 'user', content: userContent });
  return messages;
}

// 重新导出历史消息类型，方便提示词模块调用方统一引用
export type { AiHistoryMessage };
