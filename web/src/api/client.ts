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
