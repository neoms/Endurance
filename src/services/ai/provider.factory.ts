/**
 * AI Provider 工厂：根据配置选择真实 DeepSeek 或 Mock 模拟回复
 *
 * 【选择规则】
 * - 配置了 DEEPSEEK_API_KEY → 创建 DeepSeekProvider（真实大模型）；
 * - 未配置（undefined / 空串）→ 回退 MockAiProvider（echo/随机），保证零配置可运行。
 *
 * 【设计说明】
 * 选择逻辑收敛为纯函数，便于单元测试覆盖两条分支；
 * 工厂只负责「选型」，重试/超时等健壮性逻辑统一由 AiService 处理。
 */
import { logger } from '../../lib/logger.js';
import { DeepSeekProvider } from './deepseek.provider.js';
import { MockAiProvider } from './mock.provider.js';
import type { AiProvider } from './types.js';

/**
 * 创建默认 AI Provider
 *
 * @param deepSeekApiKey DeepSeek API Key（来自 env；undefined/空串视为未配置）
 * @returns AiProvider DeepSeekProvider（已配置）或 MockAiProvider（未配置）
 * 说明：仅记录是否启用 DeepSeek，绝不记录 Key 本身。
 */
export function createDefaultAiProvider(deepSeekApiKey: string | undefined): AiProvider {
  if (deepSeekApiKey) {
    logger.info('ai: DEEPSEEK_API_KEY configured, using DeepSeek provider');
    return new DeepSeekProvider({ apiKey: deepSeekApiKey });
  }
  logger.info('ai: DEEPSEEK_API_KEY not configured, falling back to MockAiProvider');
  return new MockAiProvider();
}
