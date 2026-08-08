/**
 * 服务入口文件
 *
 * 【模块职责】
 * 组装 Express 应用并监听端口，注册进程信号处理以实现优雅停机：
 * 1. 收到 SIGINT/SIGTERM 后停止接收新连接；
 * 2. 等待在途请求处理完成后退出进程；
 * 3. 关键生命周期事件（启动/关闭）均记录日志，便于排查。
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger, logFilePath } from './lib/logger.js';

// 创建 Express 应用（中间件与路由的装配见 src/app.ts）
const app = createApp();

/**
 * 启动 HTTP 服务
 *
 * @param env.PORT 监听端口（来自环境变量，默认 3000）
 * @param callback 监听成功后的回调：输出启动日志（端口、环境、Node 版本）
 */
const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, node: process.version, logFile: logFilePath },
    'server started',
  );
});

/**
 * 优雅停机
 *
 * @param signal 触发停机的信号名（SIGINT / SIGTERM），用于日志区分来源
 * 执行流程：记录日志 → server.close() 停止接收新请求 → 在途请求完成后退出。
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    logger.info({ signal }, 'server closed, exiting');
    process.exit(0);
  });
}

// 监听常见终止信号：Ctrl+C（SIGINT）与容器/kill 命令（SIGTERM）
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
