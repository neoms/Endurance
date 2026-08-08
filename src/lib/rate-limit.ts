/**
 * 轻量内存限流中间件（滑动窗口）
 *
 * 【模块职责】
 * 提供接口级限流，防止滥用（刷注册、刷登录、高频调用 AI 消耗额度）：
 * - 滑动窗口：记录每个 key 在窗口内的请求时间戳，超过 max 则拒绝（429）；
 * - 按 key 隔离：认证接口按 IP（登录前没有用户身份），AI 接口按用户 id
 *   （同一 NAT 下的不同用户不会被彼此拖累，也比 IP 更精确）；
 * - 进程内 Map + 惰性淘汰 + 定时清理：不会无限增长内存；
 * - 拒绝时返回 `Retry-After` 响应头与结构化错误码 RATE_LIMITED，
 *   与全局错误格式一致，前端可统一解析。
 *
 * 【为什么不引入 express-rate-limit】
 * 需求只需一个轻量滑动窗口；自研约 80 行、零依赖、可单测，
 * 避免为单个中间件引入第三方包（部署体积与供应链面更小）。
 * 若后续需要分布式限流（多实例），可平滑替换为 Redis 实现（键结构不变）。
 */
import type { NextFunction, Request, Response } from 'express';

import { AppError } from './errors.js';
import { logger } from './logger.js';

/**
 * 限流中间件选项
 *
 * @property windowMs 窗口时长（毫秒）
 * @property max      窗口内允许的最大请求数（超过即 429）
 * @property keyPrefix 键前缀（区分「认证限流」与「AI 限流」两类）
 * @property keyFrom   从请求中提取限流键（IP / 用户 id）
 * @property message   拒绝时的提示文案（可选）
 */
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyFrom: (req: Request) => string;
  message?: string;
}

/**
 * 限流中间件类型：Express 中间件 + 提供 reset() 供测试复位状态
 */
export interface RateLimiterMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  /** 清空全部限流状态（测试用） */
  reset(): void;
}

/**
 * 创建滑动窗口限流中间件
 *
 * @param options 限流配置（窗口/上限/键提取）
 * @returns RateLimiterMiddleware 可挂载到 Express 路由的中间件
 *
 * 主要逻辑（同步执行，不阻塞事件循环）：
 * 1. 取出该 key 在窗口内的历史时间戳（先惰性剪掉过期项）；
 * 2. 已达上限 → 计算最快可重试时间，写 Retry-After 并抛出 429 AppError；
 * 3. 未达上限 → 记录本次时间戳放行。
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiterMiddleware {
  // key → 窗口内请求时间戳数组（升序；数组可能较长，但上限 max 通常很小）
  const store = new Map<string, number[]>();

  /**
   * 定时清理过期 key：避免长期运行后内存被「只来了一次请求」的 key 占满。
   * unref() 保证定时器不阻塞进程退出（Node 端标准做法）。
   */
  const sweepTimer = setInterval(() => {
    cleanupExpired();
  }, options.windowMs);
  sweepTimer.unref?.();

  /**
   * 清理全部过期条目
   *
   * @returns void
   * 逻辑：逐 key 过滤窗口内的时间戳；全过期则整键删除。
   */
  function cleanupExpired(): void {
    const cutoff = Date.now() - options.windowMs;
    for (const [key, times] of store) {
      const alive = times.filter((t) => t > cutoff);
      if (alive.length === 0) {
        store.delete(key);
      } else {
        store.set(key, alive);
      }
    }
  }

  const middleware: RateLimiterMiddleware = (req, res, next) => {
    const key = `${options.keyPrefix}:${options.keyFrom(req)}`;
    const now = Date.now();
    const cutoff = now - options.windowMs;
    // 惰性剪枝：只保留窗口内的时间戳
    const times = (store.get(key) ?? []).filter((t) => t > cutoff);

    // 已达上限：计算最早一次请求何时滑出窗口，作为建议重试时间
    if (times.length >= options.max) {
      const retryAfterMs = (times[0] ?? now) + options.windowMs - now;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      logger.warn({ key, windowMs: options.windowMs, max: options.max }, 'rate-limit: blocked');
      next(
        new AppError(429, 'RATE_LIMITED', options.message ?? '请求过于频繁，请稍后再试', {
          retryAfterMs,
        }),
      );
      return;
    }

    // 未达上限：记录本次请求时间戳并放行
    times.push(now);
    store.set(key, times);
    next();
  };

  middleware.reset = () => {
    store.clear();
  };
  return middleware;
}

/**
 * 按 IP 提取限流键（认证接口：注册/登录前没有用户身份）
 *
 * @param req Express 请求对象
 * @returns string 客户端 IP；拿不到时回退到 socket 地址
 * 说明：生产环境若部署在反向代理后，需在 Express 设置 trust proxy
 * 才能拿到真实客户端 IP（见 docs/DEPLOYMENT.md）。
 */
export function ipKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * 按当前用户提取限流键（AI 接口：authRequired 之后调用）
 *
 * @param req Express 请求对象（应已挂载 req.user）
 * @returns string 用户 id；未登录时回退到 IP（防御性兜底）
 */
export function userKey(req: Request): string {
  return req.user?.id ?? ipKey(req);
}
