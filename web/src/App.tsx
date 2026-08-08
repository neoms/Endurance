/**
 * 应用根组件与路由
 *
 * 【页面路由】
 * - /login                登录/注册页；
 * - 以下路由由 AppLayout（左侧边栏 + 主区域）包裹，需登录：
 *   - /                     欢迎页（建议问题）；
 *   - /conversations/:id    个人对话聊天页；
 *   - /groups               群组创建页；
 *   - /groups/:id           群组详情/群聊页。
 *
 * 【鉴权守卫】
 * RequireAuth：未登录访问受保护页面时重定向到 /login。
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { AuthProvider, useAuth } from './auth/AuthContext.js';
import AppLayout from './components/AppLayout.js';
import ChatPage from './pages/ChatPage.js';
import GroupDetailPage from './pages/GroupDetailPage.js';
import GroupsPage from './pages/GroupsPage.js';
import LoginPage from './pages/LoginPage.js';
import WelcomePage from './pages/WelcomePage.js';

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
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<WelcomePage />} />
            <Route path="/conversations/:id" element={<ChatPage />} />
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/groups/:id" element={<GroupDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
