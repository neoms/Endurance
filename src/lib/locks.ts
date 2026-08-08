/**
 * 键级互斥锁工具
 *
 * 【模块职责】
 * 提供以字符串为键的进程内互斥（Promise 链锁）：
 * - 同一键的任务串行执行（前一个完成后才启动下一个）；
 * - 不同键的任务互不影响（并行执行）；
 * - 前一个任务无论成败都不会阻塞后续任务（失败也释放锁）。
 *
 * 【使用场景】
 * - 群组消息：同一群组同时只允许一个「机器人回复轮次」在跑；
 * - 个人对话发送：同一对话的幂等检查 + 用户消息落库 + AI 调用 + 回复落库
 *   必须串行，避免并发提交撞唯一约束（幂等键）或回复顺序交错。
 */

/**
 * 创建一把「键级锁」
 *
 * @returns withLock(key, task) 函数：同一 key 的任务串行，不同 key 并行
 * 说明：锁表按 key 存储尾部 Promise；任务结束后若仍是最新尾部则清理条目，
 * 避免 Map 无限增长（并发低峰期自动回收）。
 */
export function createKeyedLock(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<void>>();

  return async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    // 取上一个排队任务的尾部 Promise；没有则直接开始
    const previous = locks.get(key) ?? Promise.resolve();
    // 无论上一个任务成败，都继续执行当前任务（失败不能阻塞队列）
    const run = previous.then(task, task);
    // 尾部 Promise：吞掉当前任务的结果/错误，只用于排队
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    // 当前任务结束后清理锁（仅当仍是最新尾部时删除，防止误删后续排队任务）
    void tail.then(() => {
      if (locks.get(key) === tail) {
        locks.delete(key);
      }
    });
    return run;
  };
}
