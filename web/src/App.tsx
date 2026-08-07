/**
 * 应用根组件与路由
 *
 * 【页面路由】
 * - /login                登录/注册页；
 * - /                     对话列表页（需登录）；
 * - /conversations/:id    聊天页（需登录）；
 * - /groups               群组列表/创建页（需登录）；
 * - /groups/:id           群组详情/群聊页（需登录）。
 *
 * 【鉴权守卫】
 * RequireAuth：未登录访问受保护页面时重定向到 /login。
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { AuthProvider, useAuth } from './auth/AuthContext.js';
import ChatPage from './pages/ChatPage.js';
import ConversationsPage from './pages/ConversationsPage.js';
import GroupDetailPage from './pages/GroupDetailPage.js';
import GroupsPage from './pages/GroupsPage.js';
import LoginPage from './pages/LoginPage.js';

/**
 * 登录守卫：会话恢复完成后，未登录用户重定向到登录页
 *
 * @param children 受保护的页面
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="center-screen">加载中…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <ConversationsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/conversations/:id"
            element={
              <RequireAuth>
                <ChatPage />
              </RequireAuth>
            }
          />
          <Route
            path="/groups"
            element={
              <RequireAuth>
                <GroupsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/groups/:id"
            element={
              <RequireAuth>
                <GroupDetailPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
