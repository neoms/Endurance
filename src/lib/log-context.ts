/**
 * 请求日志上下文（AsyncLocalStorage）
 *
 * 【模块职责】
 * 把「请求级上下文」（requestId / userId）通过 Node 的 AsyncLocalStorage 注入到
 * 当前异步调用链，使**业务日志自动携带关联字段**，无需在每个 logger 调用处手动传参：
 * - requestId：每个请求的全局唯一 id（UUID），请求日志与业务日志用它关联；
 * - userId：鉴权通过后写入，同一请求内的后续业务日志自动带上操作者。
 *
 * 【工作原理】
 * requestLogger 中间件在请求入口调用 runWithLogContext 建立上下文；
 * AsyncLocalStorage 会随 async/await 调用链自动传播（Node 20+ 支持 Promise 链传播），
 * logger 的 mixin 在写每条日志时从 getLogContext 读取并注入字段——
 * 因此无论日志发生在多深的服务调用里，都能定位到「哪个请求、哪个用户」。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级日志上下文
 *
 * @property requestId 请求唯一 id（UUID，多实例间不冲突）
 * @property userId    当前登录用户 id（鉴权通过后写入，可空）
 */
export interface LogContext {
  requestId: string;
  userId?: string;
}

// 全局单例：AsyncLocalStorage 本身是线程安全的上下文载体
const storage = new AsyncLocalStorage<LogContext>();

/**
 * 在指定上下文中执行回调（请求入口调用一次）
 *
 * @param ctx 请求上下文（requestId 必填；userId 后续由鉴权写入）
 * @param fn  请求处理回调（含后续所有异步调用）
 * @returns T 回调返回值（透传）
 * 说明：storage.run 会在回调及其异步后代中保持 ctx 可读；
 * 回调结束后自动恢复外层上下文，避免上下文串扰。
 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 读取当前请求上下文
 *
 * @returns LogContext | undefined 当前调用链的上下文；非请求处理期间为 undefined
 */
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * 向当前请求上下文写入用户 id（鉴权通过后调用）
 *
 * @param userId 当前登录用户 id
 * @returns void
 * 说明：直接修改 store 对象；该请求内随后的业务日志即可携带 userId。
 */
export function setContextUserId(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx.userId = userId;
  }
}
