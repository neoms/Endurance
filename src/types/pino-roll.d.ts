/**
 * pino-roll 模块类型声明（该包未内置 TypeScript 类型）
 *
 * 【作用】
 * pino-roll 是 CJS 包且无 .d.ts；这里按实际 API 声明最小类型，
 * 使项目内可以安全地 `import pinoRoll from 'pino-roll'` 并类型检查通过。
 */
declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  /**
   * pino-roll 配置项（仅声明用到的字段）
   *
   * @property file     日志文件路径（相对项目根或绝对路径）
   * @property size     单个文件大小上限（如 '10m'），达到后轮转
   * @property limit    保留策略：count = 保留的历史文件数
   * @property mkdir    父目录不存在时自动创建
   * @property sync     是否同步写（默认 false，异步缓冲性能更好）
   */
  interface PinoRollOptions {
    file: string;
    size?: string | number;
    limit?: { count?: number; bytes?: string | number };
    mkdir?: boolean;
    sync?: boolean;
    dateFormat?: string;
    extension?: string;
  }

  /**
   * 创建带轮转能力的日志输出流（异步初始化）
   *
   * @param options 轮转配置
   * @returns Promise<DestinationStream> 可直接用于 pino multistream 的流
   */
  const pinoRoll: (options: PinoRollOptions) => Promise<DestinationStream>;

  export default pinoRoll;
}
