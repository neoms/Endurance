/**
 * 认证上下文（React Context）
 *
 * 【模块职责】
 * 全局管理登录状态：
 * - 启动时若本地存在 token，调用 /auth/me 恢复会话（失效则清除）；
 * - 提供 login / register / logout 操作；
 * - 页面通过 useAuth() 获取 user 与操作函数。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { api, clearToken, getToken, setToken } from '../api/client.js';
import type { AuthResult, User } from '../api/types.js';

// 认证上下文值
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 认证 Provider：包裹应用根组件
 *
 * @param children 子组件树
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // 启动时恢复会话：有 token 则拉取当前用户，失败（过期/无效）则清除
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  /** 登录：成功后保存 token 与用户信息 */
  const login = async (username: string, password: string) => {
    const result = await api<AuthResult>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    setToken(result.token);
    setUser(result.user);
  };

  /** 注册：成功后自动登录 */
  const register = async (username: string, password: string, displayName?: string) => {
    const result = await api<AuthResult>('/auth/register', {
      method: 'POST',
      body: { username, password, displayName },
    });
    setToken(result.token);
    setUser(result.user);
  };

  /** 登出：清除 token 与本地用户状态 */
  const logout = () => {
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * 获取认证上下文
 *
 * @returns AuthContextValue
 * @throws 在 AuthProvider 之外使用时报错
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
