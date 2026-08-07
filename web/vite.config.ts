/**
 * Vite 配置
 *
 * 【模块职责】
 * - 开发服务器：端口 5173，/api 请求代理到后端（默认 http://localhost:3000），
 *   避免开发期跨域问题；
 * - 构建产物输出到 web/dist（生产模式下由后端 Express 托管）。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发代理：所有 /api 请求转发到本地后端服务
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
