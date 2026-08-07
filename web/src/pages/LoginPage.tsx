/**
 * 登录/注册页
 *
 * 【交互】
 * - 登录/注册双 Tab 切换；
 * - 成功后自动跳转到对话列表页（/）；
 * - 错误信息展示后端 error.message（如 401 密码错误、409 用户名已存在）。
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

export default function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();

  // 当前 Tab：'login' 登录 / 'register' 注册
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /**
   * 提交表单：登录或注册
   *
   * @param e 表单提交事件（阻止默认刷新）
   */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, password, displayName || undefined);
      }
      navigate('/', { replace: true });
    } catch (err) {
      // 统一错误提示：ApiError 展示后端 message，其余展示兜底文案
      setError(err instanceof ApiError ? err.message : '请求失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <h2 style={{ marginTop: 0 }}>Endurance Chat</h2>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => setMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="username">用户名</label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-32 位字母/数字/下划线"
              autoComplete="username"
              required
            />
          </div>
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="displayName">昵称（可选）</label>
              <input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="展示昵称"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 8 位' : '请输入密码'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </div>
          <div className="error-text">{error}</div>
          <button type="submit" disabled={submitting} style={{ width: '100%' }}>
            {submitting ? '处理中…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>
      </div>
    </div>
  );
}
