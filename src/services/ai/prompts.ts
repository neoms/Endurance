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
 *   - 群组机器人（有 personality）：名字 + 性格/回复倾向 + 通用群聊约束；
 *   - 群组机器人（无 personality）：仅名字 + 通用群聊约束（兜底）；
 *   - 个人对话（无 botName）：通用助手提示。
 */
export function buildSystemPrompt(context: AiGenerateContext): string {
  if (context.botName && context.personality) {
    return `你是群组机器人「${context.botName}」。性格/回复倾向：${context.personality}。请用中文简洁自然地回复群聊消息，不要自称是 AI 助手。`;
  }
  if (context.botName) {
    return `你是群组机器人「${context.botName}」。请用中文简洁自然地回复群聊消息。`;
  }
  return '你是一个乐于助人的 AI 助手，请用中文简洁、准确地回答用户问题。';
}

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
    { role: 'system', content: buildSystemPrompt(context) },
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
