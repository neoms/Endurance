# 部署说明

## 部署架构

本项目采用**一体化单进程部署**（不需要反向代理到多个服务）：

```text
                 ┌──────────────────────────── Express 服务（单进程）────────────────────────────┐
浏览器/客户端 ──> │  /api/*   REST API + SSE（业务路由）                                          │
                 │  /api-docs Swagger UI（接口文档）                                               │
                 │  /*       前端 SPA（web/dist 静态资源，未构建时回退提示）                       │
                 └──────────────┬───────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │ SQLite（prisma/dev.db）│  DeepSeek API（可选）   stdout 日志（生产采集）
                    └───────────────────────┘
```

设计要点：

- 前端构建产物（`web/dist`）由 Express 直接托管，**一个端口同时提供 API 与页面**，
  无跨域/CORS 问题、部署最简单；
- 生产环境日志走 **stdout**（JSON），由平台日志面板或日志采集器收集——应用不写文件、
  不轮转，避免多副本写同一文件交错损坏；
- SQLite 是文件型数据库，**必须使用带持久磁盘的平台**（见「平台选择」）；
- 依赖外部服务只有 DeepSeek API（可选）：未配置 `DEEPSEEK_API_KEY` 时自动回退 Mock，
  零外部依赖也能完整演示。

## 环境要求

- Node.js **24.13.0**（仓库 `.nvmrc` / `engines` 双重固定；`nvm use` 可自动切换，或手动安装对应版本）；
- npm 11+（`packageManager` 已声明 `npm@11.6.2`）；
- 磁盘：SQLite 数据库 + 前端构建产物 + node_modules，本地约 300MB；
- 网络：安装依赖需要 npm registry；配置 `DEEPSEEK_API_KEY` 后需要能访问 DeepSeek API。

## 环境变量

复制 `.env.example` 为 `.env` 并按需修改。按用途分组如下：

### 服务

| 变量     | 默认值      | 说明                            |
| -------- | ----------- | ------------------------------- |
| NODE_ENV | development | development / test / production |
| PORT     | 3000        | HTTP 服务端口                   |

### 日志（生产可观测性）

| 变量                      | 默认值                | 说明                                                                            |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| LOG_LEVEL                 | info                  | pino 日志级别（排查时可调低为 debug）                                           |
| LOG_FILE                  | （开发 logs/app.log） | 留空：开发默认写文件、生产不写（stdout 采集）；显式指定路径则写文件；`off` 关闭 |
| LOG_FILE_MAX_SIZE         | 10m                   | 单个日志文件大小上限（pino-roll 语法），达到后轮转（仅写文件时生效）            |
| LOG_FILE_KEEP             | 7                     | 日志轮转保留的历史文件数（仅写文件时生效）                                      |
| REQUEST_LOG_SAMPLE_RATE   | 1                     | 成功请求日志采样率（0-1）；生产高流量建议调低（如 0.1），4xx/5xx 始终全量       |
| SLOW_REQUEST_THRESHOLD_MS | 2000                  | 慢请求阈值（毫秒），超过则请求日志标记 `slow: true`                             |

### 数据库

| 变量         | 默认值        | 说明                                                           |
| ------------ | ------------- | -------------------------------------------------------------- |
| DATABASE_URL | file:./dev.db | SQLite 连接串（相对 prisma/ 目录解析）；生产必须指向持久卷路径 |

### 认证（生产必改）

| 变量           | 默认值             | 说明                                                                   |
| -------------- | ------------------ | ---------------------------------------------------------------------- |
| JWT_SECRET     | dev-only-secret... | **生产必须替换为强随机值**：`openssl rand -hex 32`，绝不提交到代码仓库 |
| JWT_EXPIRES_IN | 24h                | JWT 有效期（jsonwebtoken 时间字符串）                                  |

### AI（可选）

| 变量              | 默认值                   | 说明                                                                           |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------ |
| DEEPSEEK_API_KEY  | （空）                   | 配置后接入真实 DeepSeek；留空回退 Mock 模拟回复                                |
| DEEPSEEK_BASE_URL | https://api.deepseek.com | 兼容网关/代理时覆盖                                                            |
| DEEPSEEK_MODEL    | deepseek-v4-flash        | 默认 V4 快速模型，请求体自动携带 `thinking: { type: "disabled" }` 关闭思考模式 |
| AI_CACHE_TTL_MS   | 3600000                  | AI 回复缓存 TTL（毫秒）；0 关闭缓存                                            |

### 限流

| 变量                 | 默认值 | 说明                                                      |
| -------------------- | ------ | --------------------------------------------------------- |
| RATE_LIMIT_WINDOW_MS | 60000  | AI 接口限流窗口（毫秒）                                   |
| RATE_LIMIT_MAX       | 30     | AI 接口每窗口每用户上限；认证接口按 IP 固定 10 次/15 分钟 |

> **生产必改清单**：`NODE_ENV=production`、`JWT_SECRET=<强随机值>`、
> `DATABASE_URL=<持久卷路径>`；按需配置 `DEEPSEEK_API_KEY` 启用真实 AI。

## 本地运行

### 开发模式（热更新）

```bash
# 1. 安装依赖（后端 + 前端）
npm install
npm --prefix web install

# 2. 准备环境变量（可选：填入 DEEPSEEK_API_KEY 接入真实 AI，否则走 Mock）
cp .env.example .env

# 3. 初始化数据库并写入种子数据（alice/bob 测试账号 + 6 个 NPC 角色）
npm run db:migrate -- --name init   # 首次：创建数据库并应用全部迁移
npm run db:seed                     # 写入种子数据（幂等，可重复执行）

# 4. 启动（两个终端）
npm run dev      # 终端 1：后端（tsx watch，3000，代码改动自动重载）
npm run dev:web  # 终端 2：前端（Vite，5173，/api 代理到 3000）
```

访问 `http://localhost:5173`（前端）、`http://localhost:3000/api-docs`（接口文档）。
开发日志默认同时写入控制台与 `logs/app.log`（`tail -f logs/app.log` 可实时查看）。

### 生产模式（一体化）

```bash
npm install
npm --prefix web install
cp .env.example .env
# 按需修改 .env（NODE_ENV=production、强随机 JWT_SECRET 等）

npm run db:deploy   # 应用迁移（生产推荐 db:deploy，不会执行 migrate dev 的交互式操作）
npm run db:seed     # 写入种子数据（幂等）
npm run build       # 编译后端（tsc → dist/）
npm run build:web   # 构建前端（→ web/dist）
npm start           # node dist/server.js，同一端口托管 API + 前端 SPA
```

访问 `http://localhost:3000`（前端 SPA）与 `http://localhost:3000/api-docs`（接口文档）。

> `db:migrate`（dev）与 `db:deploy`（production）的区别：
> `migrate dev` 会对比 schema 生成新迁移并可交互式重置数据，只适合开发；
> `deploy` 只应用已存在的迁移，适合生产与 CI。

## 生产部署到公网

### Docker 一键部署（推荐，消除环境差异）

仓库根目录提供 `Dockerfile`（多阶段构建）与 `docker-compose.yml`（一键编排），
本地/服务器只需安装 Docker 即可运行，无需手动安装 Node、处理依赖与构建：

```bash
# 1. 准备环境变量（可选：填入 DEEPSEEK_API_KEY 启用真实 AI；JWT_SECRET 建议替换）
cp .env.example .env

# 2. 构建镜像并后台启动（首次构建需拉取 node:24.13.0-alpine，视网络约 3-10 分钟）
docker compose up -d --build

# 3. 查看启动日志（迁移/种子/启动过程）
docker compose logs -f
```

访问 `http://localhost:3000`（前端 SPA + API）与 `http://localhost:3000/api-docs`（接口文档）。

**数据持久化**：SQLite 文件写入命名卷 `endurance-data`（挂载到容器 `/data`）——
重启、重建、删除容器数据都不丢失；彻底清理用 `docker compose down -v`（会删除数据卷）。

**环境变量**：`docker-compose.yml` 从当前 shell / `.env` 读取（如 `DEEPSEEK_API_KEY`、
`JWT_SECRET`、`RATE_LIMIT_MAX` 等，均有默认值）；`NODE_ENV`、`DATABASE_URL` 已固定为
生产配置（stdout 日志 + 卷内数据库），无需手动改。

**常用命令**：

```bash
docker compose up -d --build   # 构建并启动
docker compose logs -f         # 查看日志
docker compose restart         # 重启
docker compose down            # 停止（保留数据）
docker compose down -v         # 停止并删除数据卷（慎用）
```

**镜像拉取失败的排查**：国内网络拉取 `node:24.13.0-alpine` 失败时，
可切换 Docker 镜像源（daemon 配置 `registry-mirrors`）或手动 `docker pull` 基础镜像后重试；
也可将 `Dockerfile` 的 `FROM node:24.13.0-alpine` 换为本机可访问的 node:24 镜像。

**镜像结构说明**：多阶段构建——阶段 1 安装全量依赖（含 prisma/tsx）并构建前后端；
阶段 2 只保留运行文件与全量 `node_modules`（运行时需要 prisma CLI 执行 `db:deploy` /
`db:seed`），以镜像体积换取部署可靠性；启动命令自动执行「迁移 → 种子 → 启动」，
`HEALTHCHECK` 每 30s 探活 `/api/health`。

### 平台选择

推荐支持**持久磁盘**的 PaaS 平台：

| 平台      | 特点                                                                |
| --------- | ------------------------------------------------------------------- |
| Railway   | 支持卷挂载，免费额度有限，部署简单                                  |
| Render    | 支持持久磁盘（付费），Web Service 自动构建，免费层无持久化          |
| Fly.io    | 支持卷（volumes），按需付费，适合有 Docker 经验的用户               |
| VPS + PM2 | 完全可控（Nginx/Caddy + systemd/PM2），需要自己维护 Node 环境与证书 |

**为什么必须持久磁盘**：SQLite 是文件型数据库，重启/重建实例后若文件不持久，数据全部丢失；
免费层无持久化的平台只能用于临时演示（数据会重置，见下文替代方案）。

### 通用部署步骤（以 Railway/Render 为例）

1. 代码推送到 Git 仓库；
2. 在平台创建服务，选择 Node.js 构建环境，**Build Command** 与 **Start Command**：

   ```bash
   # Build Command
   npm install && npm --prefix web install && npm run build && npm run build:web

   # Start Command
   npm run db:deploy && npm run db:seed && npm start
   ```

   > 将迁移与种子放在 Start Command：确保每次部署（新实例）先建表再启动服务；
   > `db:seed` 幂等，重复执行无副作用。

3. 配置环境变量（见上表）：
   - `NODE_ENV=production`；
   - `JWT_SECRET=$(openssl rand -hex 32)`（强随机，平台密钥管理保存）；
   - `DATABASE_URL=file:/data/app.db`（持久卷路径，并在平台把 `/data` 挂载为持久磁盘）；
   - 按需 `DEEPSEEK_API_KEY`、限流/日志参数；
4. 平台会自动分配域名并启用 HTTPS；等待构建完成；
5. 健康检查：`GET /api/health` 返回 `{ "status": "ok", ... }` 即部署成功。

### 无持久磁盘平台的替代方案

若只能使用无持久化免费容器，二选一：

- **切换到 PostgreSQL**：`docs/DATABASE.md`「切换 PostgreSQL」——Prisma 零代码改动，
  数据库由平台托管（Railway/Render/Neon 等），彻底解决持久化；
- **接受演示数据重置**：仅用于评审演示，重启后 `db:seed` 会重建测试账号与 NPC，
  但用户产生的对话/消息会丢失（提交说明中明确该权衡）。

### 日志与监控（生产）

- 生产日志走 stdout（JSON），直接在平台日志面板查看；
- 检索建议：`LOG_LEVEL=debug` 临时开启细节；按 `requestId` 串联一次请求的完整链路；
  `slow: true` 标记定位慢接口；5xx 自动为 error 级别；
- 健康检查接口可接入平台监控：`GET /api/health`（返回 uptime），持续失败触发自动重启。

### 进程管理与 HTTPS（VPS 场景）

- 进程管理：`pm2 start dist/server.js --name endurance` 或 systemd unit，
  配置 `Restart=always`；
- 反向代理：Nginx/Caddy 把 80/443 转发到 3000（Caddy 自动签发 HTTPS 证书）；
- 建议 `ulimit`/日志交给 systemd journal 或 pm2 日志模块，应用保持 stdout 输出。

## 部署后验证清单

- [ ] `GET /api/health` 返回 200；
- [ ] `alice/alice123456`、`bob/bob123456` 均可登录；
- [ ] 创建对话 → 发消息 → 收到 AI 回复（未配 Key 时为 Mock 回复）；
- [ ] 添加标签 → 按标签筛选命中；
- [ ] 创建群组 → 发送消息 → NPC 回复；
- [ ] `bob` 无法访问 `alice` 的对话/群组（404，数据隔离）；
- [ ] `/api-docs` 文档可访问且与接口一致；
- [ ] 日志面板可见结构化 JSON（含 requestId）；
- [ ] 重启实例后数据仍在（验证持久卷挂载正确）。

## 故障排查

| 现象                         | 排查方向                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| 部署后数据丢失/重置          | `DATABASE_URL` 未指向持久卷；确认平台卷挂载路径与连接串一致               |
| 接口返回 500                 | 查看日志 `unhandled error`（含堆栈）；多为迁移未执行或环境变量缺失        |
| 登录返回 401 / 401 一直失效  | `JWT_SECRET` 变更导致旧 token 失效（重新登录即可）；确认环境变量已注入    |
| AI 回复像「复读机」/固定话术 | 未配置 `DEEPSEEK_API_KEY`，正在走 Mock——确认环境变量已设置并重启          |
| 前端页面 404 或空白          | `web/dist` 未构建；确认执行过 `npm run build:web`                         |
| 请求频繁返回 429             | 触发限流：确认 `RATE_LIMIT_MAX` 配置合理，查看 `Retry-After` 头           |
| 日志面板空白                 | 确认 `LOG_LEVEL` 不为 silent；生产日志走 stdout，检查平台 stdout 采集设置 |
| 端口被占用                   | 修改 `PORT` 环境变量；本地确认无残留进程                                  |

## 提交物说明（面试提交）

按题目提交指南，交付内容包含：

- 完整代码的 Git 仓库压缩包（命名【姓名_TypeScript 后端工程师】）；
- 可访问的部署链接（尽力提供）与至少 2 个测试账号（`alice` / `bob`）；
- 本仓库 README、API 文档、设计文档与数据库文档。

> 若因网络/平台限制无法公网部署，请提供本地启动步骤（见上文）与关键流程录屏，
> 并在提交说明中明确该权衡。
