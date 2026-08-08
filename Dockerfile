# ============================================================================
# Endurance Chat — 多阶段 Dockerfile
#
# 阶段 1（build）：安装依赖、生成 Prisma Client、构建后端（tsc）与前端（Vite）
# 阶段 2（runtime）：只保留运行所需文件；复用构建阶段的全量 node_modules
#   （运行时需要 prisma CLI 与 tsx 执行 db:deploy / db:seed，因此保留含 dev 依赖的
#   node_modules，以镜像体积换取部署可靠性）
#
# 数据持久化：SQLite 文件写入 /data（docker-compose 挂载卷，见 docker-compose.yml）
# 日志：NODE_ENV=production 时输出 stdout（docker logs 查看）
# ============================================================================

# ---------- 构建阶段 ----------
FROM node:24.13.0-alpine AS build
WORKDIR /app

# Prisma generate 需要 DATABASE_URL 环境变量（schema 引用 env；generate 不会真实连接）
ENV DATABASE_URL=file:./dev.db

# 先复制依赖清单，利用 Docker 层缓存：package.json/lock 未变化时跳过 npm ci
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

# 安装全部依赖（含 dev：typescript / prisma / tsx / vitest 等构建与迁移工具）
RUN npm ci && npm --prefix web ci

# 复制源码（.dockerignore 已排除 node_modules/dist/日志/数据库等）
COPY . .

# 生成 Prisma Client 并构建后端 + 前端
RUN npx prisma generate \
    && npm run build \
    && npm --prefix web run build

# ---------- 运行时阶段 ----------
FROM node:24.13.0-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/app.db

# 复用构建阶段的全量依赖（含 prisma CLI 与 tsx）
COPY --from=build /app/node_modules ./node_modules

# 只复制运行所需文件
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/tsconfig.json ./tsconfig.json

# 持久数据目录（docker-compose 挂载命名卷到此路径）
RUN mkdir -p /data

EXPOSE 3000

# 健康检查：alpine 自带 wget
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# 启动：应用迁移 → 写入种子数据（幂等，重建测试账号与 NPC）→ 启动服务
CMD ["sh", "-c", "npx prisma migrate deploy && npm run db:seed && npm start"]
