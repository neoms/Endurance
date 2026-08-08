# Endurance Chat — 星际穿越主题在线聊天应用

这是一个在线聊天 Web 应用，以科幻电影《星际穿越》为故事背景：你作为永恒号（Endurance）飞船的乘客，可以与库珀、布兰德、罗米利、道尔（人类角色）以及塔斯、凯斯（机器人角色）进行多轮对话，也可以创建多成员 + 多 NPC 的群组对话。

后端为 Express + TypeScript REST API，前端为 Vite + React SPA；支持真实 DeepSeek 大模型接入（未配置 API Key 时自动回退到内置 Mock 模拟回复，零配置可运行）。

## 功能特性

- **用户认证与 ACL**：用户名/密码注册登录（JWT + bcrypt），用户名全局唯一、大小写敏感；所有个人数据强制 `userId` 隔离，跨用户访问统一返回 404，群组按 OWNER / MEMBER 角色管理权限。
- **个人对话**：创建、列表、改标题（默认取首条用户输入并**立即同步到侧边栏**，手动改过后不再覆盖）、删除（级联清理消息与标签关联），一用户可拥有多个对话。
- **对话标签**：每个对话可添加多个自定义标签（规范化标签表 + 关联表），支持多标签 AND 筛选（SQL 层完成，不依赖内存过滤）。
- **多轮问答**：用户消息 + AI 回复双写落库，历史消息按时间顺序游标分页；发送即刷新对话 `updatedAt`，最近活跃对话置顶。
- **DeepSeek 真实 AI**：配置 `DEEPSEEK_API_KEY` 后接入 DeepSeek（默认 `deepseek-v4-flash`，关闭思考模式）；未配置自动回退 Mock。
- **SSE 流式输出**：个人与群组消息均支持 `?stream=true`，AI 回复逐字推送（群组按 NPC 逐个流式输出），先 PENDING 占位、完成/失败后落库 SENT/FAILED。
- **AI 调用健壮性**：超时真正 abort（默认 10s，流式为空闲超时）、失败重试（指数退避 + 抖动，共 3 次）、重试耗尽后 FAILED 占位（用户消息不丢失）且可重试、`clientRequestId` 幂等防重复提交。
- **上下文滑动窗口 + 语义压缩**：AI 上下文最多携带 20 条历史，消息满 20 条时把最早 15 条压缩成 1 条摘要、保留最新 5 条原文（压缩后剩 6 条），继续积累到 20 条再触发下一轮；配置 DeepSeek 后由 `deepseek-v4-flash`（关闭思考模式）做语义压缩，后续轮次采用「上次摘要 + 新增消息」的增量压缩（输入更小、更快），未配置或压缩失败自动降级为内置确定性摘要；只影响上下文，不改变聊天界面展示。
- **AI 回复缓存**：同一对话/群组内相同问题在 TTL 内（默认 1 小时）直接回放上次回复；群组按「选中 NPC 组合」整轮缓存并整轮回放，一次提问多人回答也能命中。
- **接口限流**：认证接口按 IP（10 次/15 分钟）、AI 接口按用户（默认 30 次/分钟），超限返回 429 + `Retry-After`。
- **群组对话**：多成员 + 多 NPC、三种响应策略（全部回复 / 随机一个 / 内容路由）、`@NPC名` 点名定向回复（按 @ 顺序）、`@成员用户名` 合法提及、三层防循环机制、兜底保证必有回复、聊天气泡内 @ 高亮；回复落库前自动剥离开头/内容中的任意角色名前缀（提示词约束 + 后处理双保险），保证每个角色只说自己的话。
- **接口文档**：Swagger/OpenAPI（`/api-docs`）+ Markdown（`docs/API.md`），接口源码中的 `@openapi` 注释即文档，并有一致性测试兜底。
- **生产级日志**：结构化 JSON + 请求关联 id（requestId/userId 自动贯穿业务日志）+ 文件轮转（pino-roll）+ 状态分层/采样/慢请求标记，便于线上定位问题。

## 技术栈及版本

| 层次     | 技术                                     | 版本                    |
| -------- | ---------------------------------------- | ----------------------- |
| 运行时   | Node.js（`.nvmrc` / engines 固定）       | 24.13.0                 |
| 包管理   | npm                                      | 11.6.2                  |
| 语言     | TypeScript（后端 / 前端）                | 6.0.3 / 7.0.2           |
| 后端框架 | Express                                  | 5.2.1                   |
| 数据库   | SQLite + Prisma ORM                      | Prisma 6.19.3           |
| 认证     | jsonwebtoken + bcryptjs                  | 9.x / 3.x               |
| 输入校验 | Zod                                      | 4.4.3                   |
| 日志     | pino + pino-roll（请求日志为自研中间件） | 10.3.1 / 4.0.0          |
| 测试     | Vitest + Supertest                       | 4.1.10 / 7.x            |
| 接口文档 | swagger-jsdoc + swagger-ui-express       | 6.x / 5.x               |
| 前端     | Vite + React + react-router-dom          | 8.2.1 / 19.2.8 / 7.18.2 |
| 代码规范 | ESLint + Prettier（2 空格缩进）          | 10.x / 3.x              |

## 项目结构

```text
Endurance/
├── README.md            # 本文件
├── docs/                # 文档：API / 设计思路 / 数据库 / 部署
├── plan/PLAN.md         # 项目计划书（本地文件）
├── prisma/              # schema、迁移 SQL 与种子数据（2 个测试账号 + 6 个角色）
├── src/                 # 后端 Express API 源码
│   ├── api/             # 路由（@openapi 注释）、中间件、校验器
│   ├── services/        # 业务逻辑（auth / conversation / message / ai / group / bot）
│   ├── lib/             # 基础设施（logger/request-logger/log-context、错误处理、JWT、限流、Prisma 单例）
│   ├── config/          # 环境变量与 Swagger 配置
│   └── types/           # 共享类型定义
├── scripts/             # 一次性数据修复脚本（如清理群组消息残留的角色名前缀）
├── tests/               # 单元 + 集成测试（Vitest + Supertest，独立测试库）
├── web/                 # 前端 Vite + React SPA
├── package.json         # 后端脚本与依赖
└── .env.example         # 环境变量模板
```

## API 端点列表及说明

所有接口位于 `/api` 前缀下；除注册、登录与健康检查外均需请求头 `Authorization: Bearer <token>`。完整字段、请求/响应示例与错误码见 [docs/API.md](docs/API.md)，Swagger UI 见 `/api-docs`。

| 方法   | 路径                                   | 说明                                                               |
| ------ | -------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/api/auth/register`                   | 注册（username / password / displayName?），返回 `{ token, user }` |
| POST   | `/api/auth/login`                      | 登录，返回 `{ token, user }`                                       |
| GET    | `/api/auth/me`                         | 当前用户信息                                                       |
| POST   | `/api/conversations`                   | 创建个人对话（title 可选，缺省「新对话」）                         |
| GET    | `/api/conversations?tag=工作&tag=学习` | 个人对话列表，多标签 AND 筛选                                      |
| GET    | `/api/conversations/:id`               | 对话详情（含标签）                                                 |
| PATCH  | `/api/conversations/:id`               | 修改标题                                                           |
| DELETE | `/api/conversations/:id`               | 删除对话（级联删除消息与标签关联）                                 |
| POST   | `/api/conversations/:id/tags`          | 添加标签（幂等，名称小写归一化）                                   |
| DELETE | `/api/conversations/:id/tags/:tagId`   | 移除标签                                                           |
| POST   | `/api/conversations/:id/messages`      | 发送消息；`?stream=true` 时 SSE 流式返回 AI 回复                   |
| GET    | `/api/conversations/:id/messages`      | 历史消息（`cursor` / `before` / `limit` 游标分页）                 |
| POST   | `/api/messages/:id/retry`              | 重试 FAILED 的 AI 回复                                             |
| POST   | `/api/groups`                          | 创建群组（botIds 至少 1 个，可选响应策略与防循环上限）             |
| GET    | `/api/groups`                          | 我参与的群组列表                                                   |
| GET    | `/api/groups/:id`                      | 群组详情（成员 + NPC）                                             |
| PATCH  | `/api/groups/:id`                      | 更新名称 / 响应策略 / 防循环上限（创建者）                         |
| POST   | `/api/groups/:id/members`              | 添加成员（按用户名，创建者）                                       |
| DELETE | `/api/groups/:id/members/:userId`      | 移除成员（创建者；创建者不可被移除）                               |
| DELETE | `/api/groups/:id/members/me`           | 离开群组（创建者不可离开）                                         |
| POST   | `/api/groups/:id/bots`                 | 添加 NPC（创建者）                                                 |
| DELETE | `/api/groups/:id/bots/:botId`          | 移除 NPC（至少保留 1 个）                                          |
| POST   | `/api/groups/:id/messages`             | 发送群组消息（@提及 / 响应策略 / 幂等）；`?stream=true` SSE        |
| GET    | `/api/groups/:id/messages`             | 群组历史消息（游标分页）                                           |
| GET    | `/api/bots`                            | 可用 NPC 角色预设列表                                              |
| GET    | `/api/health`                          | 健康检查                                                           |
| GET    | `/api-docs` / `/api-docs.json`         | Swagger UI / 原始 OpenAPI 规范                                     |

## 数据库 Schema 设计说明

数据库为 SQLite（`prisma/schema.prisma` 即 Schema 文档，迁移 SQL 见 `prisma/migrations/`，详细设计见 [docs/DATABASE.md](docs/DATABASE.md)）。共 10 张核心表：

| 表                  | 说明                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `users`             | 用户（username 全局唯一、大小写敏感；只存 bcrypt 哈希）                                             |
| `conversations`     | 个人对话（userId 归属 + `(userId, updatedAt)` 索引；isDefaultTitle 标记默认标题，可被首条消息替换） |
| `tags`              | 标签（每用户内名称唯一，规范化存储）                                                                |
| `conversation_tags` | 对话-标签关联（复合主键，tagId 索引）                                                               |
| `messages`          | 个人对话消息（status / errorCode / 幂等键，`(conversationId, createdAt)` 索引）                     |
| `bots`              | NPC 角色预设（code 唯一，独立于群组，移除群组引用不影响历史消息显示）                               |
| `groups`            | 群组（responseMode / maxConsecutiveBotReplies）                                                     |
| `group_members`     | 群组成员（复合主键 + userId 索引）                                                                  |
| `group_bots`        | 群组-NPC 关联（复合主键 + botId 索引）                                                              |
| `group_messages`    | 群组消息（roundId / 幂等键，`(groupId, createdAt)` 与 `(groupId, roundId)` 索引）                   |

关键设计考虑：

- **对话标签**：采用「规范化标签表 + 关联表」两级结构。`tags` 按「用户 + 名称」唯一，同名标签不重复存储；`conversation_tags` 以 `(conversationId, tagId)` 为复合主键、`tagId` 加索引，多标签 AND 筛选在 SQL 层通过按 `conversationId` 分组计数完成，既避免反范式冗余（用户改标签名只需改一行），又保证筛选性能与数据一致性。
- **群组与机器人管理**：NPC 角色是全局预设（`bots.code` 唯一、带性格与关键词路由倾向），群组通过 `group_bots` 关联引用——从群组移除 NPC 只删关联、不删预设，因此历史消息仍能显示其原名。群组消息用 `roundId` 显式建模「一条人类消息触发的一轮回复」，配合 `(groupId, roundId)` 索引支撑按轮聚合与防循环计数。
- **数据隔离与一致性**：所有用户数据表都带 `userId` 归属并在服务层强制条件查询；`clientRequestId` 幂等键限定在「同一对话/群组」内唯一（复合唯一约束），从数据库层面杜绝重复提交。

## 快速开始

### 环境要求

- Node.js **24.13.0**（仓库提供 `.nvmrc`，执行 `nvm use` 即可）
- npm 11+

### 安装与启动（开发模式）

```bash
# 1. 安装依赖（后端 + 前端）
npm install
npm --prefix web install

# 2. 准备环境变量（可选：填入 DEEPSEEK_API_KEY 接入真实 AI，否则走 Mock）
cp .env.example .env

# 3. 初始化数据库并写入种子数据（alice / bob 两个测试账号 + 6 个角色）
npm run db:migrate
npm run db:seed

# 4. 启动后端（3000）与前端（5173，/api 代理到 3000）
npm run dev
npm run dev:web
```

浏览器访问 `http://localhost:5173`（前端）或 `http://localhost:3000/api-docs`（接口文档）。

### 一体化运行（生产构建）

```bash
npm run build && npm run build:web
npm start
```

访问 `http://localhost:3000`：前端 SPA 与 API 由同一服务托管。

## 测试账号

| 用户名  | 密码          | 说明                                     |
| ------- | ------------- | ---------------------------------------- |
| `alice` | `alice123456` | 测试用户 A                               |
| `bob`   | `bob123456`   | 测试用户 B（用于验证数据隔离与群组协作） |

## 测试与常用命令

```bash
npm test                # 运行全部测试（自动重建独立测试库 prisma/test.db）
npm run test:coverage   # 覆盖率报告
npm run typecheck       # 后端类型检查（tsc --noEmit）
npm run lint            # ESLint
npm run format          # Prettier 格式化
npm run db:clean-prefixes  # 清理群组消息中残留的「角色名：」前缀（幂等，可重复运行）
```

测试覆盖（24 个文件、192 个用例）：认证全流程、对话/标签 CRUD 与 ACL 负向用例、消息发送与 AI 失败一致性（重试/超时/幂等/缓存回放）、群组权限矩阵与 NPC 响应策略/防循环/兜底/@提及、SSE 流式、限流、日志（请求关联 id / 分层 / 采样 / 慢请求）、Swagger 文档一致性。

## 设计思路与考量

技术选型（框架、数据库、API 风格）与三大核心逻辑（对话标签、AI 调用健壮性、群组对话）的完整设计思路、权衡与决策过程见 [docs/DESIGN.md](docs/DESIGN.md)，这里给出结论性摘要：

- **技术选型**：Node.js 24 + TypeScript 保证类型安全与生态统一；Express 5 轻量、中间件成熟，最贴合「重点考察后端处理流程」的定位；SQLite + Prisma 零配置可跑、Schema 即文档、参数化查询防 SQL 注入，且可平滑切换 PostgreSQL；RESTful + Zod 校验 + `@openapi` 注释即文档，保证 API 与文档一致；JWT + bcrypt 无状态会话便于演示；pino 结构化日志 + 请求关联 id（AsyncLocalStorage）+ pino-roll 轮转，便于线上定位问题。
- **对话标签**：用规范化标签表 + 关联表（而非在对话表存逗号分隔字符串）换取名副其实的「多标签筛选」能力与数据一致性——多标签 AND 在 SQL 层完成，量大后仍可走索引；标签按用户隔离，不跨用户共享。
- **AI 调用健壮性**：用户消息先落库保证不丢；每次调用带超时并真正 abort；仅对可重试错误（超时/网络/5xx）做指数退避重试（共 3 次）；重试耗尽后写 FAILED 占位消息（保留错误码与已产出内容），前端可一键重试；`clientRequestId` 幂等键防重复提交；进程内 TTL 缓存回放相同问题；接口限流防滥用。流式场景额外做「空闲超时」与「首块产出前才重试」，避免长回复被误杀或重试导致内容重复。
- **群组对话**：响应策略（ALL_BOTS / RANDOM_ONE / CONTENT_ROUTED）+ `@提及` 优先级高于策略（@NPC 按 @ 顺序定向回复，@真人则本轮 NPC 不抢话）；防循环用三层机制——只有人类消息开启新轮次（roundId）、每轮回复数硬上限 `maxConsecutiveBotReplies`、同群组一次只允许一个生成轮次（进程内锁）；保证回复靠「至少保留 1 个 NPC」校验 + 生成失败兜底文案 + 无启用 NPC 时 409 拒绝，绝不静默返回零回复；模型模仿历史格式输出「角色名：」时，提示词约束 + 全局前缀剥离双保险，确保消息里不出现别人的名字。

## 文档入口

- 在线接口文档：`/api-docs`（Swagger UI），原始规范：`/api-docs.json`
- [API 说明](docs/API.md)：端点、错误码、分页、请求/响应示例
- [设计文档](docs/DESIGN.md)：技术选型与三大核心逻辑的设计思路与权衡
- [数据库设计](docs/DATABASE.md)：表结构、索引与性能考虑、切换 PostgreSQL 说明
- [部署说明](docs/DEPLOYMENT.md)：环境变量、本地/公网部署、部署后验证清单
