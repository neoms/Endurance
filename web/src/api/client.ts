/**
 * 前端 API 客户端
 *
 * 【模块职责】
 * 统一封装 fetch 调用：
 * - 自动附加 JWT（Authorization: Bearer <token>）；
 * - 统一 JSON 序列化/反序列化；
 * - 错误归一化：后端统一错误结构 { error: { code, message } } 转为 ApiError，
 *   组件可按 error.code 做精确分支（如 401 跳登录）。
 *
 * 【Token 存储】
 * 使用 localStorage（简单直观）；XSS 防护依赖 React 默认转义 + 后端 CSP/输入限制。
 */

// 统一 API 错误（携带 HTTP 状态码与业务错误码）
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'endurance_token';

/** 读取本地保存的 JWT */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 保存 JWT（登录/注册成功后调用） */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** 清除 JWT（登出或会话失效时调用） */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * 通用 API 请求
 *
 * @param path    接口路径（不含 /api 前缀，如 '/auth/login'）
 * @param options { method?, body? }
 * @returns Promise<T> 解析后的响应数据
 * @throws ApiError 后端返回非 2xx 时抛出（含状态码与业务错误码）
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // 204 No Content：无响应体
  if (res.status === 204) {
    return undefined as T;
  }

  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'UNKNOWN_ERROR',
      data?.error?.message ?? '请求失败，请稍后重试',
    );
  }
  return data as T;
}

/**
 * SSE 事件处理器集合：事件名 → 回调（data 为已解析的 JSON）
 */
export interface SseHandlers {
  [event: string]: (data: unknown) => void;
}

/**
 * 流式 API 请求（SSE over fetch）
 *
 * @param path    接口路径（不含 /api 前缀；会自动追加 ?stream=true）
 * @param body    请求体（JSON 序列化）
 * @param handlers 事件处理器：按 SSE 事件名分发（user_message / ai_delta / …）
 * @returns Promise<void> 流正常结束或收到 error 事件后 resolve
 * @throws ApiError 请求未发出/HTTP 非 2xx（此时响应体是普通 JSON 错误）
 *
 * 说明：
 * - 手动解析 SSE 帧（event: 行 + data: 行 + 空行分隔），不依赖 EventSource——
 *   EventSource 只能 GET，而发送消息是 POST；
 * - 用 fetch 的 ReadableStream 逐块读取，TextDecoder 处理 UTF-8 边界；
 * - 无法解析的 data 帧直接跳过，不让单个脏帧打断整个流。
 */
export async function apiStream(path: string, body: unknown, handlers: SseHandlers): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}?stream=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // 非 2xx：SSE 未建立（如 401/422），响应体是普通 JSON 错误
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'UNKNOWN_ERROR',
      data?.error?.message ?? '请求失败，请稍后重试',
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * 解析并分发一个 SSE 帧
   *
   * @param event 事件名（缺省为 message）
   * @param dataText data 行内容（可能多行，用换行拼接）
   * 说明：单个帧解析失败只跳过，不中断整个流。
   */
  const dispatch = (event: string, dataText: string) => {
    if (!dataText.trim()) {
      return;
    }
    try {
      handlers[event]?.(JSON.parse(dataText));
    } catch {
      // 忽略无法解析的事件帧
    }
  };

  // 循环读取响应字节流，按空行切分 SSE 帧
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行（\n\n）分隔；逐帧切出并解析
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
      dispatch(event, dataLines.join('\n'));
    }
  }
}
