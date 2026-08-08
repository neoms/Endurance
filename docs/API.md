# API 文档

> 本文档与实现保持一致；原始 OpenAPI 规范以 `/api-docs.json`（Swagger UI：`/api-docs`）为事实源，
> 路由源码中的 `@openapi` 注释即文档。

## API 设计思路

### 风格：RESTful（资源 + 方法）

- 以**资源**为中心建模：`users`（通过 auth 表达）、`conversations`、`groups`、`messages`、`bots`、`tags`；
- 方法语义：`POST` 创建/触发动作、`GET` 查询、`PATCH` 局部更新、`DELETE` 删除；
- 嵌套资源表达归属：`/api/conversations/:id/messages`（对话下的消息）、
  `/api/groups/:id/members`（群组成员）——路径即所有权关系的表达；
- 为什么不用 GraphQL：CRUD 为主的业务 REST 最直观，Swagger 文档成熟，评审成本低。

### 路径与命名规范

- 资源名一律复数（`/conversations`、`/groups`、`/bots`）；
- 资源 id 用路径参数（`:id`），不使用查询参数定位单个资源；
- 「动作」用子路径 + POST 表达：`/api/messages/:id/retry`（重试）、`/api/groups/:id/members/me`（离开群组）；
- 查询参数只用于过滤/分页（`?tag=`、`?limit=`、`?cursor=`、`?before=`）。

### 版本策略

- 统一前缀 `/api`，暂不引入 `/v1`：单体应用、接口由前后端同步演进，无多版本并存需求；
  若未来需要破坏性变更，再升级为 `/api/v2`（路由层加一层前缀即可，不影响业务代码）。

### 鉴权设计

- `Authorization: Bearer <token>`（JWT，默认 24h 过期），不用 Cookie——
  无状态、跨端（Web/移动/脚本）通用，且天然规避 CSRF；
- 服务端鉴权中间件验签后**回查数据库**确认用户仍存在（删号即失效）；
- 登录/注册返回 `token` 与 `user`，前端自行保存 token；
- 除注册、登录、健康检查外，所有接口都必须携带 token（否则 401）。

### 统一响应与错误结构

- **成功**：返回资源对象本身或 `{ 资源名: 资源 }` 包装（如 `{ conversation }`、
  `{ userMessage, aiMessage }`）——不套统一的 `{ data }` 壳，减少一层心智；
- **错误**：统一 `{ error: { code, message, details? } }`——`code` 是稳定的业务错误码
  （前端可精确分支），`message` 是给用户/调用方看的描述，`details` 是字段级明细
  （如 Zod 校验问题、非法 @ 列表）；
- **双轨错误语义**：HTTP 状态码表达类别（4xx 客户端问题/5xx 服务端问题），
  业务码表达精确原因——两者组合供调用方分层处理；
- 未知服务端错误统一 500 + 通用文案（不泄露内部细节），日志记录完整堆栈。

### 幂等设计（clientRequestId）

- 发送消息/群组消息可携带 `clientRequestId`（8-64 字符）；
- 唯一约束限定在**同一对话/群组内**：相同键重复提交直接返回首次结果（不产生重复消息）；
- 为什么限定在对话/群组内而非全局：若全局唯一，用户 B 复用用户 A 的幂等键会命中 A 的消息
  （跨用户数据泄露），且 B 的消息不落库（丢失）；
- 应用场景：前端网络重试、用户双击发送、弱网下的重复请求。

### 游标分页（为什么不用 offset）

- 深翻页时 `OFFSET` 要扫描丢弃前 N 行，越翻越慢；且新消息插入会让「第 N 页」内容漂移；
- 游标分页以 `(createdAt, id)` 复合键排序：`cursor`（正向翻页）/ `before`（反向加载更早），
  顺序稳定、不重复不遗漏；
- 游标必须是当前对话/群组内的消息 id（否则 400 `INVALID_CURSOR`），
  同时防止用他人消息 id 试探。

### 限流

- 认证接口（注册/登录）按**客户端 IP**：10 次/15 分钟（防暴力撞库）；
- AI 接口（发消息/群组消息/重试）按**用户 id**：30 次/分钟（`RATE_LIMIT_WINDOW_MS` /
  `RATE_LIMIT_MAX` 可配置，防高频消耗 AI 额度）；
- 超限返回 `429 RATE_LIMITED` + `Retry-After` 响应头（建议调用方按此值退避重试）。

### SSE 流式协议

- 发送消息带 `?stream=true` 时，响应类型为 `text/event-stream`；
- 事件命名用业务语义：`user_message` / `ai_delta` / `ai_done` / `ai_error`、
  `bot_start` / `bot_delta` / `bot_done` / `round_done`；
- 每个事件 `data:` 携带 JSON 负载，事件之间以空行分隔（标准 SSE 格式）；
- 前置校验错误（404/400/409 等）在首个事件前以 `error` 事件返回；
- 客户端断开时服务端通过 `clientSignal` 中止底层 AI 调用（不浪费额度）。

### 文档一致性机制

- 接口源码中的 `@openapi` JSDoc 即文档（swagger-jsdoc 自动收集到 `/api-docs.json`）；
- 集成测试断言 `/api-docs.json` 中每个接口都有对应声明——文档与实现漂移会在 CI 失败。

## 通用约定

### 请求约定

- Base URL：`/api`（如 `POST /api/auth/login`）；
- 请求体：`Content-Type: application/json`，UTF-8 编码；
- 时间：响应中的时间一律 ISO 8601 UTC（如 `2026-08-08T00:00:00.000Z`）；
- 字段命名：camelCase（`senderType`、`clientRequestId`、`responseMode`）；
- 用户名/机器人名**大小写敏感**：`Alice` 与 `alice` 是两个账号，`@库珀` 与 `@库珀` 精确匹配。

### 长度限制汇总

| 字段            | 限制                         |
| --------------- | ---------------------------- |
| username        | 3-32 位，`^[a-zA-Z0-9_]+$`   |
| password        | 8-72 位                      |
| displayName     | 1-32 位（可选）              |
| 对话标题 title  | 1-100 位                     |
| 标签名 name     | 1-30 位（trim + 小写归一化） |
| 消息 content    | 1-4000 字符                  |
| clientRequestId | 8-64 字符（可选）            |
| 分页 limit      | 1-100（默认 50）             |
| 群组名 name     | 1-100 位                     |

### 错误码

| 错误码                                                                           | 状态码                    | 场景                                                          |
| -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| VALIDATION_ERROR                                                                 | 422                       | 入参校验失败（details 含字段级问题）                          |
| UNAUTHORIZED                                                                     | 401                       | 未登录 / token 缺失、无效或过期                               |
| INVALID_CREDENTIALS                                                              | 401                       | 登录用户名或密码错误                                          |
| USERNAME_TAKEN                                                                   | 409                       | 用户名已注册                                                  |
| CONVERSATION_NOT_FOUND                                                           | 404                       | 对话不存在或不属于当前用户                                    |
| TAG_NOT_FOUND                                                                    | 404                       | 标签不存在或不在该对话上                                      |
| MESSAGE_NOT_FOUND                                                                | 404                       | 消息不存在或不属于当前用户                                    |
| MESSAGE_NOT_RETRYABLE                                                            | 409                       | 消息不是 FAILED 的 AI 消息                                    |
| INVALID_CURSOR                                                                   | 400                       | cursor/before 不是当前对话或群组内的消息 id                   |
| GROUP_NOT_FOUND                                                                  | 404                       | 群组不存在或当前用户不是成员                                  |
| FORBIDDEN                                                                        | 403                       | 群组内权限不足（非创建者管理 / 创建者不可移除、不可离开）     |
| USER_NOT_FOUND                                                                   | 404                       | 添加成员时目标用户不存在                                      |
| ALREADY_MEMBER                                                                   | 409                       | 目标用户已是群组成员                                          |
| MEMBER_NOT_FOUND                                                                 | 404                       | 移除成员时目标不是成员                                        |
| BOT_NOT_FOUND                                                                    | 404                       | NPC不存在或不在群组中                                         |
| LAST_BOT                                                                         | 409                       | 移除后群组将没有启用状态的NPC，不可移除                       |
| NO_ACTIVE_BOT                                                                    | 409                       | 群组内没有启用状态的NPC，无法回复                             |
| MENTION_NOT_FOUND                                                                | 400                       | 消息中的 @名称不在当前群组内（details.mentions 列出非法名称） |
| AI_TIMEOUT / AI_ABORTED / AI_UNAVAILABLE / AI_INVALID_REQUEST / AI_UNKNOWN_ERROR | 200（消息 status=FAILED） | AI 调用失败标记（见消息接口）                                 |
| CONFLICT                                                                         | 409                       | 唯一约束冲突（并发幂等竞态）                                  |
| RESOURCE_NOT_FOUND                                                               | 404                       | 记录不存在竞态（Prisma P2025）                                |
| INVALID_PARAM                                                                    | 400                       | 路径参数非法                                                  |
| RATE_LIMITED                                                                     | 429                       | 请求过于频繁（响应带 Retry-After）                            |
| NOT_FOUND                                                                        | 404                       | 未匹配路由                                                    |
| INTERNAL_ERROR                                                                   | 500                       | 未知服务端错误                                                |

**错误响应示例**：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": ["content"], "message": "Message must not be empty" }]
  }
}
```

## 认证

| 方法 | 路径                 | 说明                                                               |
| ---- | -------------------- | ------------------------------------------------------------------ |
| POST | `/api/auth/register` | 注册（username / password / displayName?），返回 `{ token, user }` |
| POST | `/api/auth/login`    | 登录，返回 `{ token, user }`                                       |
| GET  | `/api/auth/me`       | 当前用户信息，返回 `{ user }`                                      |

### 注册

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice123456","displayName":"Alice"}'
```

成功 `201`：

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "cmxxxxxxx", "username": "alice", "displayName": "Alice" }
}
```

错误：`422 VALIDATION_ERROR`（字段不合规）、`409 USERNAME_TAKEN`（用户名已存在）。

### 登录

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice123456"}'
```

成功 `200`：结构同注册。错误：`422 VALIDATION_ERROR`、`401 INVALID_CREDENTIALS`
（用户名或密码错误，不区分具体哪个，防用户枚举）、`429 RATE_LIMITED`。

### 当前用户

```bash
curl http://localhost:3000/api/auth/me -H 'Authorization: Bearer <token>'
```

成功 `200`：`{ "user": { "id", "username", "displayName" } }`。错误：`401 UNAUTHORIZED`。

## 个人对话与标签

| 方法   | 路径                                   | 说明                                                            |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/conversations`                   | 创建对话（title 可选，缺省「新对话」），返回 `{ conversation }` |
| GET    | `/api/conversations?tag=工作&tag=学习` | 对话列表（多标签 AND 筛选），返回 `{ conversations }`           |
| GET    | `/api/conversations/:id`               | 对话详情（含标签）                                              |
| PATCH  | `/api/conversations/:id`               | 修改标题（`{ title }`）                                         |
| DELETE | `/api/conversations/:id`               | 删除对话（级联删除消息与标签关联），204                         |
| POST   | `/api/conversations/:id/tags`          | 添加标签（`{ name }`，幂等），返回 `{ tag }`                    |
| DELETE | `/api/conversations/:id/tags/:tagId`   | 移除标签，204                                                   |

### 创建对话

```bash
curl -X POST http://localhost:3000/api/conversations \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"title":"学习计划"}'
```

成功 `201`：

```json
{
  "conversation": {
    "id": "cmxxxxxxx",
    "title": "学习计划",
    "isDefaultTitle": false,
    "createdAt": "2026-08-08T00:00:00.000Z",
    "updatedAt": "2026-08-08T00:00:00.000Z",
    "tags": []
  }
}
```

不传 `title` 时标题为「新对话」且 `isDefaultTitle=true`——**首条用户消息会把它替换为消息内容**
（超长截断 30 字符），接口返回 `isDefaultTitle` 供前端立即同步标题。

### 对话列表与标签筛选

```bash
# 全部对话
curl http://localhost:3000/api/conversations -H 'Authorization: Bearer <token>'
# 多标签 AND 筛选（同时属于「工作」和「学习」）
curl 'http://localhost:3000/api/conversations?tag=工作&tag=学习' -H 'Authorization: Bearer <token>'
```

成功 `200`：`{ "conversations": [...] }`，按 `updatedAt` 倒序（最近活跃置顶）。
说明：标签筛选参数与添加侧一致做 trim + 小写归一化；多标签为 AND 语义。

### 修改标题 / 添加标签 / 删除

```bash
PATCH  /api/conversations/:id                # body: { "title": "新标题" }
POST   /api/conversations/:id/tags           # body: { "name": "工作" }（幂等，重复添加返回同一标签）
DELETE /api/conversations/:id/tags/:tagId    # 204
DELETE /api/conversations/:id                # 204（级联删除消息与标签关联）
```

修改标题会置 `isDefaultTitle=false`（此后首条消息不再自动覆盖标题）。
错误：`404 CONVERSATION_NOT_FOUND`（不存在或不属于当前用户）、`404 TAG_NOT_FOUND`、
`422 VALIDATION_ERROR`。

## 消息（个人对话）

| 方法 | 路径                                                  | 说明                                                                                |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST | `/api/conversations/:id/messages`                     | 发送消息；默认返回 `{ userMessage, aiMessage }`，`?stream=true` 时改为 SSE 流式返回 |
| GET  | `/api/conversations/:id/messages?cursor&before&limit` | 历史消息（默认最近 limit 条，支持前后翻页），返回 `{ messages }`                    |
| POST | `/api/messages/:id/retry`                             | 重试 FAILED 的 AI 消息（携带失败消息之前的对话历史），返回 `{ aiMessage }`          |

### 发送消息（同步返回）

```bash
curl -X POST http://localhost:3000/api/conversations/:id/messages \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"content":"你好，请帮我总结一下","clientRequestId":"req-00000001"}'
```

成功 `201`：

```json
{
  "userMessage": {
    "id": "...",
    "senderType": "HUMAN",
    "senderUserId": "...",
    "content": "你好，请帮我总结一下",
    "status": "SENT",
    "errorCode": null,
    "errorMessage": null,
    "createdAt": "..."
  },
  "aiMessage": {
    "id": "...",
    "senderType": "BOT",
    "senderUserId": null,
    "content": "总结如下……",
    "status": "SENT",
    "errorCode": null,
    "errorMessage": null,
    "createdAt": "..."
  }
}
```

字段规则：`content`（1-4000，必填）、`clientRequestId`（8-64，可选，幂等）。

**AI 失败时的响应**（重试耗尽）：HTTP 仍为 `201`，但 `aiMessage.status = "FAILED"`
并携带 `errorCode`（如 `AI_UNAVAILABLE`）与 `errorMessage`——用户消息始终落库不丢失，
前端据此展示「回复失败，可重试」。

**AI 回复缓存**：同一对话内相同内容在 TTL（默认 1 小时，`AI_CACHE_TTL_MS`，0 关闭）内
重复提问直接回放上次回复（不重新调用 AI）；仅缓存成功回复，失败与手动重试不命中缓存。

### 发送消息（SSE 流式 `?stream=true`）

```bash
curl -N 'http://localhost:3000/api/conversations/:id/messages?stream=true' \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"content":"你好"}'
```

事件顺序：

1. `user_message` — 用户消息已落库（`data.message`）；
2. `ai_delta` × N — AI 回复增量（`data.delta`，逐块拼接即完整回复）；
3. `ai_done` — 回复完整落库（`data.message.status = "SENT"`），
   或 `ai_error` — 重试耗尽失败占位（`data.message.status = "FAILED"`，保留已产出内容）。

前置校验错误（如对话不存在）在首个事件前以 `error` 事件返回；
流式过程中 AI 回复先以 `PENDING` 落库（前端拿到稳定消息 id 显示打字气泡）。

### 历史消息分页

```bash
# 首屏：最近 50 条（升序）
curl 'http://localhost:3000/api/conversations/:id/messages' -H 'Authorization: Bearer <token>'
# 加载更早：before=当前最早一条消息 id
curl 'http://localhost:3000/api/conversations/:id/messages?before=<id>' -H 'Authorization: Bearer <token>'
# 正向翻页：cursor=当前最后一条消息 id
curl 'http://localhost:3000/api/conversations/:id/messages?cursor=<id>&limit=20' -H 'Authorization: Bearer <token>'
```

成功 `200`：`{ "messages": [...] }`（升序）。错误：`400 INVALID_CURSOR`、`404 CONVERSATION_NOT_FOUND`。

### 重试失败的 AI 消息

```bash
curl -X POST http://localhost:3000/api/messages/:id/retry \
  -H 'Authorization: Bearer <token>'
```

成功 `200`：`{ "aiMessage": { ..., "status": "SENT", "errorCode": null } }`。
仅允许「本人对话内、BOT 类型、FAILED 状态」的消息重试；
错误：`404 MESSAGE_NOT_FOUND`、`409 MESSAGE_NOT_RETRYABLE`（不是 FAILED 的 AI 消息）。

## 群组与 NPC

| 方法   | 路径                                           | 说明                                                                                                                                                                                                                                           |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/groups`                                  | 创建群组（name / botIds[] 至少 1 个 / responseMode? / maxConsecutiveBotReplies?），返回 `{ group }`                                                                                                                                            |
| GET    | `/api/groups`                                  | 我参与的群组列表，返回 `{ groups }`                                                                                                                                                                                                            |
| GET    | `/api/groups/:id`                              | 群组详情（成员 + NPC）                                                                                                                                                                                                                         |
| PATCH  | `/api/groups/:id`                              | 更新名称/响应策略/防循环上限（创建者）                                                                                                                                                                                                         |
| POST   | `/api/groups/:id/members`                      | 添加成员（创建者），`{ username }`（全局唯一、大小写敏感）                                                                                                                                                                                     |
| DELETE | `/api/groups/:id/members/:userId`              | 移除成员（创建者；不能移除创建者）                                                                                                                                                                                                             |
| DELETE | `/api/groups/:id/members/me`                   | 离开群组（创建者不可离开，403）                                                                                                                                                                                                                |
| POST   | `/api/groups/:id/bots`                         | 添加NPC（创建者），`{ botId }`                                                                                                                                                                                                                 |
| DELETE | `/api/groups/:id/bots/:botId`                  | 移除NPC（创建者；至少保留 1 个）                                                                                                                                                                                                               |
| POST   | `/api/groups/:id/messages`                     | 发送群组消息：有 @ 时仅被 @ 的对象回复（@NPC名按 @ 顺序回复；只 @ 真人时本轮无NPC回复），无 @ 时才按响应策略；@名称必须在群组内；可带 `clientRequestId` 幂等；默认返回 `{ userMessage, botMessages }`，`?stream=true` 时按NPC逐个 SSE 流式返回 |
| GET    | `/api/groups/:id/messages?cursor&before&limit` | 群组历史消息（默认最近 limit 条，支持前后翻页），返回 `{ messages }`                                                                                                                                                                           |
| GET    | `/api/bots`                                    | 可用NPC角色预设列表，返回 `{ bots }`                                                                                                                                                                                                           |

### 创建群组

```bash
curl -X POST http://localhost:3000/api/groups \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"name":"技术讨论群","botIds":["<botId>"],"responseMode":"CONTENT_ROUTED","maxConsecutiveBotReplies":3}'
```

成功 `201`：`{ "group": { "id", "name", "responseMode", "maxConsecutiveBotReplies", "creatorId", "members": [...], "bots": [...] } }`
（创建者自动成为 OWNER）。
错误：`422 VALIDATION_ERROR`、`404 BOT_NOT_FOUND`（botId 不存在）。

### 群组消息（响应策略与 @提及）

```bash
curl -X POST http://localhost:3000/api/groups/:id/messages \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"content":"@库珀 规划一下飞行路线","clientRequestId":"req-00000002"}'
```

成功 `201`：`{ "userMessage": {...}, "botMessages": [{ ...库珀的回复... }] }`。

- **@提及优先**：有 @ 时仅被 @ 的对象回复（@NPC 按 @ 出现顺序、同一 NPC 去重；只 @ 真人时本轮无 NPC 回复）；
- **无 @ 时按响应策略**：`ALL_BOTS`（全部）/ `RANDOM_ONE`（随机一个）/
  `CONTENT_ROUTED`（按 `replyTendency` 关键词路由，无命中随机兜底一个）；
- **防循环**：只有人类消息开启新轮次；每轮回复数 ≤ `maxConsecutiveBotReplies`（默认 3）；
  同一群组一次只允许一个生成轮次；
- **保证回复**：NPC 生成失败以「我暂时无法回答，请稍后再试。」占位，人类消息后必有回复；
- **回复内容纯净**：`botMessages[].content` 为纯发言文本，不含「角色名：」前缀；
- 错误：`404 GROUP_NOT_FOUND`、`409 NO_ACTIVE_BOT`、`400 MENTION_NOT_FOUND`（details.mentions 列出非法名称）、
  `429 RATE_LIMITED`。

### 群组消息流式事件（`?stream=true`）

每个被选中的 NPC 按顺序依次输出：

1. `user_message` — 人类消息已落库；
2. `bot_start` — 某 NPC 开始回复（`data.message.status = "PENDING"`，携带稳定消息 id）；
3. `bot_delta` × N — 该 NPC 回复增量（`data = { messageId, delta }`）；
4. `bot_done` — 该 NPC 回复完成落库（`data.message.status = "SENT"`；失败时内容为兜底文案）；
5. `round_done` — 本轮全部 NPC 回复完成。

校验类错误（群组不存在 / 无启用 NPC / 非法 @）以 `error` 事件返回。

**AI 回复缓存**：同一群组内相同内容（且本轮选中的 NPC 组合一致）在 TTL 内重复提问时，
**整轮回放全部 NPC 回复**（顺序与内容与首次一致）；仅整轮全部成功才写缓存，
任一 NPC 走了兜底文案则整轮不缓存。

### 群组消息结构

```json
{
  "id": "cmxxxxxxx",
  "groupId": "cmxxxxxxx",
  "roundId": "5f9d9d2a-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "senderType": "BOT",
  "userId": null,
  "botId": "cmxxxxxxx",
  "senderName": "库珀",
  "content": "从数据上看，这颗星球确实存在大气层。",
  "status": "SENT",
  "createdAt": "2026-08-08T00:00:00.000Z"
}
```

`senderName`（真人=用户名，机器人=角色名）随消息连表带出：
成员离开群组或 NPC 被移除后历史消息仍显示原发言者（历史可追溯）。

### 成员与 NPC 管理

```bash
POST   /api/groups/:id/members        # body: { "username": "bob" }（按用户名，大小写敏感，创建者）
DELETE /api/groups/:id/members/:userId # 移除成员（创建者；不能移除创建者）
DELETE /api/groups/:id/members/me      # 离开群组（创建者不可离开，403）
POST   /api/groups/:id/bots            # body: { "botId": "<botId>" }（添加 NPC，创建者）
DELETE /api/groups/:id/bots/:botId     # 移除 NPC（创建者；至少保留 1 个启用 NPC）
PATCH  /api/groups/:id                 # body: { name? / responseMode? / maxConsecutiveBotReplies? }（创建者）
```

错误：`403 FORBIDDEN`（非创建者管理）、`404 USER_NOT_FOUND` / `404 MEMBER_NOT_FOUND` /
`404 BOT_NOT_FOUND`、`409 ALREADY_MEMBER`、`409 LAST_BOT`（移除后无启用 NPC）。

### NPC 角色预设

```bash
curl http://localhost:3000/api/bots -H 'Authorization: Bearer <token>'
```

成功 `200`：`{ "bots": [{ "id", "code", "name", "replyTendency", "isActive" }] }`
（personality 人设提示词不对外暴露）。

## 系统

| 方法 | 路径             | 说明                                      |
| ---- | ---------------- | ----------------------------------------- |
| GET  | `/api/health`    | 健康检查，返回 `{ status: "ok", uptime }` |
| GET  | `/api-docs`      | Swagger UI 文档页                         |
| GET  | `/api-docs.json` | 原始 OpenAPI 规范                         |

## 权限说明（群组）

| 操作                      | 创建者(OWNER)  | 成员(MEMBER) | 非成员 |
| ------------------------- | -------------- | ------------ | ------ |
| 查看群组/消息/发消息      | ✅             | ✅           | 404    |
| 修改配置/管理成员/管理NPC | ✅             | 403          | 404    |
| 移除创建者                | 不可           | —            | —      |
| 离开群组                  | 403（v1 限制） | ✅           | 404    |

个人数据（对话/消息/标签）的 ACL 语义：跨用户访问一律返回 404（不暴露资源存在性）。
