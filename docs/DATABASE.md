# 数据库设计文档

## 概览

- 数据库：SQLite（本地文件 `prisma/dev.db`；测试库 `prisma/test.db`），通过 Prisma 6 管理。
- Schema 源文件：`prisma/schema.prisma`；迁移：`prisma/migrations/`。
- 设计原则：
  1. **数据隔离**：所有用户数据通过 `user_id` 外键关联，查询强制携带用户条件；
  2. **规范化**：标签等可复用数据按用户去重存储，避免冗余；
  3. **一致性优先**：消息表携带状态字段，支撑 AI 失败时的占位与重试；
  4. **角色预设与群组解耦**：NPC 角色是全局预设（`bots`），群组通过关联表引用——
     移除群组 NPC 只删关联不删预设，历史消息与新增角色都因此更简单；
  5. **索引匹配查询**：每个列表/筛选查询都有对应索引；
  6. **约束即防线**：唯一约束/复合主键/外键策略在数据库层兜底并发与数据完整性。

## 通用设计约定

### 主键：cuid 而非自增整数

- cuid 全局唯一、**不可枚举**：自增 id 会向外部暴露「第 N 条数据」的数据量信息，
  且可被遍历猜测；cuid 无规律，配合 ACL 的 404 语义，即使 id 泄露也无法越权；
- 分布式友好：多实例/分库时不依赖全局计数器；
- 代价：比整数略长（25 字符）、索引略大——SQLite 单表万级数据下差异可忽略。

### 时间戳

- 所有表统一 `createdAt` / `updatedAt`（Prisma `@default(now())` / `@updatedAt`）；
- `updatedAt` 承担「最近活跃排序」语义（对话列表按它倒序），消息发送时同步刷新；
- SQLite 时间戳精度为毫秒，因此**排序键统一用 `(时间, id)` 复合**（见索引设计），
  同毫秒多条消息也能稳定排序。

### 枚举：Prisma enum → SQLite TEXT + 应用层类型

- SQLite 没有原生枚举，Prisma 将 enum 落为 TEXT 列；
- 数据库层不做 CHECK 约束（Prisma 不直接支持），由「应用层 TS 枚举类型 + Zod 校验 +
  服务层业务逻辑」共同保证取值合法；
- 迁移到 PostgreSQL 时，Prisma 会自动改为真正的 enum 类型。

### 外键删除策略：Cascade 与 SetNull 的选择原则

- **Cascade（级联删除）**：子记录是父记录的「私有容器」时使用——
  删除对话连消息一起删、删除用户连对话/标签/成员关系一起删；
- **SetNull（置空保留）**：子记录属于「共享/历史」语义，作者删除不应摧毁历史时使用——
  消息的作者（用户/NPC）被删除时，消息记录保留、外键置空，避免聊天历史整体丢失。

## 表结构（含设计思路）

### users（用户）

| 字段                  | 类型        | 说明                           |
| --------------------- | ----------- | ------------------------------ |
| id                    | TEXT PK     | cuid 主键                      |
| username              | TEXT UNIQUE | 登录名（全局唯一、大小写敏感） |
| passwordHash          | TEXT        | bcrypt 哈希，绝不存明文        |
| displayName           | TEXT        | 展示昵称                       |
| createdAt / updatedAt | DATETIME    | 创建/更新时间                  |

**设计思路**：

- `username` 全局唯一且**大小写敏感**（不做小写归一化，`Alice` 与 `alice` 是两个账号）：
  用户名是身份标识而非展示文本，归一化会改变用户注册时的选择；
  数据库 unique 约束按精确字符串比较，登录时精确匹配；
- `passwordHash` 只存 bcrypt 哈希（10 轮）：即使数据库泄露也无法还原明文；
- `displayName` 冗余存储（不实时 join）：昵称与用户名分离——用户名承担登录标识、
  昵称承担展示（群组消息 `senderName` 直接读它，无需额外查询）；
- 刻意未加 email/phone：题目要求用户名/密码登录，保持最小字段。

### conversations（个人对话）

| 字段                  | 类型            | 说明                                           |
| --------------------- | --------------- | ---------------------------------------------- |
| id                    | TEXT PK         | cuid                                           |
| userId                | TEXT FK → users | 所属用户（ACL 关键字段，ON DELETE CASCADE）    |
| title                 | TEXT            | 默认「新对话」，仅默认标题会被首条用户消息替换 |
| isDefaultTitle        | BOOLEAN         | 是否仍为默认标题；手动改标题后置 false         |
| createdAt / updatedAt | DATETIME        | updatedAt 驱动列表倒序；发送消息时同步刷新     |

索引：`(userId, updatedAt DESC)`。

**设计思路**：

- `userId` 是所有对话查询的强制过滤条件（ACL 的数据库层落点）——服务层查询永远带它，
  配合唯一资源 id，从根本上杜绝水平越权；
- `title + isDefaultTitle` 分离：标题是「展示值」，`isDefaultTitle` 是「是否可被自动替换的标记」。
  若不分离，无法区分「用户手动改回‘新对话’」与「从未改过」——自动替换逻辑会误伤手动标题；
- `updatedAt` 承担「最近活跃」排序：发送消息时主动刷新它，最近活跃的对话置顶；
- `ON DELETE CASCADE`：对话是用户私有数据，删除用户时应整体清理（含消息与标签关联）；
- 索引 `(userId, updatedAt DESC)`：过滤条件（userId）在前、排序字段（updatedAt）在后，
  一次索引扫描直接得到「我的对话按最近活跃排序」的结果，无需回表排序。

### tags / conversation_tags（标签：规范化 + 关联）

`tags`：

| 字段   | 类型            | 说明                            |
| ------ | --------------- | ------------------------------- |
| id     | TEXT PK         | cuid                            |
| userId | TEXT FK → users | 标签归属用户                    |
| name   | TEXT            | 标签名（trim + 小写归一化存储） |

唯一约束：`(userId, name)`。

`conversation_tags`：

| 字段           | 类型     | 说明              |
| -------------- | -------- | ----------------- |
| conversationId | TEXT FK  | ON DELETE CASCADE |
| tagId          | TEXT FK  | ON DELETE CASCADE |
| createdAt      | DATETIME | 关联时间          |

复合主键 `(conversationId, tagId)`；`tagId` 索引。

**设计思路（为什么是两级结构）**：

- **为什么不用 JSON 数组列**（`tags = "工作,学习"`）：无法建关联索引、无法按标签聚合、
  多标签筛选只能 LIKE 全表扫描、违反第一范式、改标签名要遍历所有对话；
- **为什么不用冗余外键**（每个对话直接存一份标签名）：同一标签名在每行重复存储浪费空间、
  改名要全表更新，且无法区分同名标签；
- **tags 表按「用户 + 名称」唯一**：标签属于用户而非全局（不同用户的「工作」互不干扰），
  同名标签只存一行，改标签名只改这一行，关联自动生效；
- **conversation_tags 复合主键**：同一对话不能重复关联同一标签（幂等添加的数据库兜底）；
- **`tagId` 索引**：支撑「按标签找对话」方向；「按对话找标签」由复合主键的前缀覆盖；
- **双向级联删除**：删对话/删标签自动清理关联行，配合孤儿标签清理（见关键设计考虑），
  不残留脏数据。

多标签 AND 筛选：为每个标签生成一个 `EXISTS` 条件
（`tags.some(tag.name = X AND tag.userId = 当前用户)`）再 AND 组合，SQL 层完成。

### messages（个人对话消息）

| 字段                     | 类型                      | 说明                               |
| ------------------------ | ------------------------- | ---------------------------------- |
| id                       | TEXT PK                   | cuid                               |
| conversationId           | TEXT FK                   | ON DELETE CASCADE                  |
| senderType               | TEXT(HUMAN/BOT)           | 发送者类型                         |
| senderUserId             | TEXT? FK                  | 人类消息作者（ON DELETE SET NULL） |
| content                  | TEXT                      | 消息内容                           |
| status                   | TEXT(PENDING/SENT/FAILED) | 消息状态                           |
| errorCode / errorMessage | TEXT?                     | AI 失败错误码与描述                |
| clientRequestId          | TEXT? 复合唯一            | 幂等键（同一对话内唯一）           |
| createdAt                | DATETIME                  | 发送时间                           |

索引：`(conversationId, createdAt)`；唯一约束：`(conversationId, clientRequestId)`。

**设计思路**：

- `senderType` 区分人类与 AI：BOT 消息的 `senderUserId` 为 null——同一张表承载两类消息，
  历史按时间顺序天然混排，避免「用户消息表 + AI 消息表」两张表排序合并的复杂度；
- `status` 状态机（PENDING/SENT/FAILED）是 AI 失败一致性的数据库基础：
  用户消息先落库（SENT），AI 回复重试耗尽后以 FAILED 占位（携带 errorCode/errorMessage），
  前端可见「回复失败，可重试」——消息顺序与对话结构不因失败而残缺；
- `clientRequestId` 复合唯一限定在**同一对话内**：幂等键若全局唯一，
  用户 B 复用用户 A 的幂等键会命中 A 的消息（数据泄露）且 B 的消息不落库（数据丢失）；
  复合键 + 对话归属校验后，幂等天然按用户隔离；
- `(conversationId, createdAt)` 索引支撑历史游标分页（`(createdAt, id)` 复合排序，
  见「索引设计总览」）；
- 外键策略对比：`conversationId → CASCADE`（对话是消息容器，删对话连消息删，符合需求）；
  `senderUserId → SET NULL`（用户是消息作者，作者删除不应摧毁聊天历史，记录保留、作者置空）。

### bots（NPC 角色预设）

| 字段          | 类型        | 说明                                                               |
| ------------- | ----------- | ------------------------------------------------------------------ |
| id            | TEXT PK     | cuid                                                               |
| code          | TEXT UNIQUE | 稳定标识（cooper / romilly / tars 等）                             |
| name          | TEXT        | 展示名                                                             |
| personality   | TEXT        | 完整人设提示词（身份/性格/知识/说话风格/行为逻辑/时间线/知识禁区） |
| replyTendency | TEXT        | 关键词（逗号分隔），用于内容路由                                   |
| isActive      | BOOLEAN     | 是否可用                                                           |
| createdAt     | DATETIME    | 创建时间                                                           |

**设计思路**：

- `code` 唯一且独立于展示名 `name`：种子脚本用 code 做 upsert 去重、
  内容路由引用 code 不受改名影响——「稳定标识与展示名分离」避免改名波及关联与路由；
- `personality` / `replyTendency` 存库而非硬编码：**提示词与代码解耦**，
  新增/调整角色只需插一条种子数据或改一行配置，无需发版；
- `isActive` 软禁用：停用角色不移除历史关联（历史消息仍显示其名），只是不再参与回复；
- 角色是**全局预设**而非群组私有：同一角色可被多个群组引用（见 group_bots）。

### groups（群组）

| 字段                     | 类型                                     | 说明                           |
| ------------------------ | ---------------------------------------- | ------------------------------ |
| id                       | TEXT PK                                  | cuid                           |
| name                     | TEXT                                     | 群组名                         |
| creatorId                | TEXT FK → users                          | 创建者（OWNER）                |
| responseMode             | TEXT(ALL_BOTS/RANDOM_ONE/CONTENT_ROUTED) | NPC 响应策略                   |
| maxConsecutiveBotReplies | INTEGER                                  | 每轮回复上限（防循环，默认 3） |
| createdAt / updatedAt    | DATETIME                                 | 时间                           |

索引：`(creatorId)`。

**设计思路**：

- `creatorId` 冗余存储而非 join 成员表找 OWNER：创建者身份是群组的**固有属性**，
  直接字段查询更高效，且不会出现「群组存在但无 OWNER」的非法状态；
- `responseMode` + `maxConsecutiveBotReplies` 作为群组级配置存库：
  防循环参数可按群组调整（默认 3），响应策略可在运行时切换，无需改代码；
- `ON DELETE CASCADE`：创建者（用户）被删除时群组整体清理（含成员、NPC 关联、消息）；
- `(creatorId)` 索引支撑「我创建的群组」列表。

### group_members（群组成员）

| 字段     | 类型               | 说明              |
| -------- | ------------------ | ----------------- |
| groupId  | TEXT FK            | ON DELETE CASCADE |
| userId   | TEXT FK            | ON DELETE CASCADE |
| role     | TEXT(OWNER/MEMBER) | 角色（权限矩阵）  |
| joinedAt | DATETIME           | 加入时间          |

复合主键 `(groupId, userId)`；`userId` 索引。

**设计思路**：

- 复合主键 `(groupId, userId)`：同一用户不能重复加入同一群组（数据库层防重）；
- `role` 承担权限矩阵（OWNER 可管理、MEMBER 只读/发言）——角色是群组成员关系的属性，
  与用户全局角色分离（用户在不同群组可以是不同角色）；
- `userId` 索引支撑「我参与的群组」：按用户反向查群组，主键前缀不支持这个方向，必须补索引；
- 双向级联删除：删群组/删用户自动清理成员关系，不留孤儿行。

### group_bots（群组 NPC 关联）

| 字段    | 类型     | 说明              |
| ------- | -------- | ----------------- |
| groupId | TEXT FK  | ON DELETE CASCADE |
| botId   | TEXT FK  | ON DELETE CASCADE |
| addedAt | DATETIME | 添加时间          |

复合主键 `(groupId, botId)`；`botId` 索引。

**设计思路**：

- 多对多关联表：一个群组可挂多个 NPC、一个 NPC 可被多个群组使用；
- 复合主键防止重复添加同一 NPC；
- `ON DELETE CASCADE` 语义是「移除群组 NPC = 删关联行」——**不删 bots 预设**，
  这是历史消息可追溯的关键（见关键设计考虑）；
- `botId` 索引支撑反向查询（某 NPC 被哪些群组使用，管理后台/统计用）。

### group_messages（群组消息）

| 字段            | 类型                      | 说明                                                 |
| --------------- | ------------------------- | ---------------------------------------------------- |
| id              | TEXT PK                   | cuid                                                 |
| groupId         | TEXT FK                   | ON DELETE CASCADE                                    |
| roundId         | TEXT?                     | **轮次**：一条人类消息触发的一轮回复共享同一 roundId |
| senderType      | TEXT(HUMAN/BOT)           | 发送者类型                                           |
| userId / botId  | TEXT? FK                  | 人类发言者 / NPC（ON DELETE SET NULL）               |
| content         | TEXT                      | 消息内容                                             |
| status          | TEXT(PENDING/SENT/FAILED) | 状态                                                 |
| clientRequestId | TEXT? 复合唯一            | 幂等键（同一群组内唯一）                             |
| createdAt       | DATETIME                  | 时间                                                 |

索引：`(groupId, createdAt)`、`(groupId, roundId)`；唯一约束：`(groupId, clientRequestId)`。

**设计思路**：

- `roundId` 是本表最核心的设计：把「一条人类消息触发的一轮 NPC 回复」显式建模为一个字段——
  它同时是防循环计数边界（每轮回复数 ≤ maxConsecutiveBotReplies）、按轮聚合的查询键、
  以及排查日志中定位一轮回复的关联键；
- `userId / botId` 双外键 + `senderType`：HUMAN 消息写 userId、BOT 消息写 botId，
  一张表承载两类发言并按时间天然混排；`senderType` 决定读哪个外键；
- `ON DELETE SET NULL`：成员离开群组（删 group_members 行）**不删 group_messages**；
  即使未来真的删除用户/NPC 记录，消息也保留、外键置空——历史不因人员变动而消失；
- `(groupId, createdAt)` 支撑历史游标分页；`(groupId, roundId)` 支撑按轮查询；
  `(groupId, clientRequestId)` 复合唯一支撑群组内幂等（与个人消息一致）。

## 索引设计总览

设计原则：**每个索引对应至少一个真实查询路径**，不为「可能用」建索引；复合索引遵循
「过滤条件在前、排序/关联条件在后」的最左前缀规则。

| 索引                                       | 覆盖的查询                        |
| ------------------------------------------ | --------------------------------- |
| `(userId, updatedAt DESC)`                 | 我的对话列表（按最近活跃倒序）    |
| `(userId, name)` UNIQUE                    | 标签规范化去重、按名查找标签      |
| `(conversationId, tagId)` PK               | 某个对话的标签列表                |
| `(tagId)`                                  | 按标签筛对话（EXISTS 关联）       |
| `(conversationId, createdAt)`              | 个人消息历史分页（时间序 + 游标） |
| `(conversationId, clientRequestId)` UNIQUE | 个人消息幂等去重                  |
| `(creatorId)`                              | 我创建的群组                      |
| `(groupId, userId)` PK                     | 群组成员列表、成员资格校验        |
| `(userId)`                                 | 我参与的群组                      |
| `(groupId, botId)` PK                      | 群组 NPC 列表                     |
| `(botId)`                                  | 某 NPC 被哪些群组使用             |
| `(groupId, createdAt)`                     | 群组消息历史分页（时间序 + 游标） |
| `(groupId, roundId)`                       | 按轮查询/防循环计数               |
| `(groupId, clientRequestId)` UNIQUE        | 群组消息幂等去重                  |

关于排序稳定性：历史分页使用 `(createdAt, id)` 复合排序——SQLite 时间戳为毫秒级，
同毫秒多条消息时用 id 做次级排序，保证顺序稳定、游标不重复不遗漏。

## 关系概览

```text
users 1─N conversations 1─N messages
users 1─N tags 1─N conversation_tags N─1 conversations
users 1─N groups (creator) / group_members N─N users
bots 1─N group_bots N─N groups
groups 1─N group_messages (user 或 bot 发言，双外键 + senderType)
```

关系清晰、无循环：用户数据全部从 `users` 出发；NPC 预设独立于用户体系；
群组通过两张关联表（成员/NPC）与两个体系连接。

## 并发与一致性（数据库层）

- **唯一约束 = 并发的最终防线**：
  `username`（注册并发同名）、`(userId, name)`（并发建同名标签）、复合主键（重复入群/重复关联）、
  `(conversationId|groupId, clientRequestId)`（幂等）——应用层先查后插，
  数据库唯一约束兜底真正的并发竞争，冲突归一为 409；
- **条件更新保证「只有一个请求成功」**：标题默认值用
  `updateMany({ id, isDefaultTitle: true })` 更新——复合条件在数据库层原子判定，
  并发首条消息只有一个能消费掉默认标题；
- **外键策略区分容器与历史**：容器关系（对话→消息、群组→消息、用户→私有数据）用 Cascade；
  作者关系（消息→用户/NPC）用 SetNull——保证删除操作不会意外摧毁聊天历史；
- **SQLite 单写者 + 应用层键级锁**：对话/群组的写路径在进程内互斥锁内串行执行，
  实际并发写压力远低于 SQLite 上限；迁移 PostgreSQL 后可换分布式锁（见关键设计考虑）。

## 性能考虑

- 所有列表查询都有对应复合索引（见索引设计总览），避免全表扫描；
- 多标签筛选在 SQL 层完成（EXISTS + AND），不把全量数据拉到内存过滤；
- 游标分页（`cursor/before + limit`）比 offset 分页在大数据量下更稳定（避免深翻页扫描）；
  消息历史默认返回最近一页，`before` 反向取更早、`cursor` 正向翻页；无效游标返回 400；
- 群组历史按 `(groupId, createdAt)` 索引 + 游标分页；
- `senderName` 随消息连表带出（include user/bot 的 username/displayName/name），
  避免前端依赖当前成员/NPC 列表做二次映射。

## 关键设计考虑

### 群组与机器人管理（全局预设 + 关联引用）

- NPC 角色（`bots`）是**全局预设**，`code` 唯一、`personality`（完整人设）与
  `replyTendency`（内容路由关键词）都存库——新增角色只需插一条种子数据，不需要改代码；
- 群组通过 `group_bots` 关联引用预设：**从群组移除 NPC 只删关联行、不删预设**，
  因此群组消息（`group_messages.botId` 外键）在 NPC 被移除后仍能连表解析出原名，
  历史消息的发言者不会变成「机器人」或丢失；
- 群组消息落库时连表带出 `senderName`（真人=用户名、机器人=角色名）随响应返回：
  前端展示历史消息不依赖「当前成员/机器人列表」，成员离开或 NPC 移除不影响历史可读性。

### 对话标题默认值（isDefaultTitle 标记）

- 创建对话时不传标题 → `title='新对话'` 且 `isDefaultTitle=true`；
- 发送首条用户消息时用 `updateMany({ isDefaultTitle: true })` 条件更新标题——
  复合条件保证并发安全（只有一个请求能消费掉默认标题），且用户手动改过标题
  （`isDefaultTitle=false`）后永不被动覆盖；
- 前端拿到 `isDefaultTitle` 后可在首条消息发出时**立即同步标题**，无需重新拉取详情。

### 幂等键的隔离设计

- 个人消息 `(conversationId, clientRequestId)`、群组消息 `(groupId, clientRequestId)` 均为复合唯一；
- 幂等键**限定在对话/群组内**而非全局唯一：若全局唯一，用户 B 复用用户 A 的幂等键
  会命中 A 的消息（跨用户泄露）且 B 的消息不落库（丢失）；
- 复合唯一约束 + 服务层键级互斥锁双保险：并发重复提交返回首次结果，不撞唯一约束。

## 可扩展性

- **新增 NPC 角色**：向 `bots` 插种子数据即可，无需迁移/发版；
- **新增标签维度**（颜色/分组）：扩展 `tags` 表字段，关联结构不变；
- **群组转让创建者**：`group_members.role` 已有 OWNER/MEMBER，加接口改角色即可；
- **软删除/归档**：加 `deletedAt` 字段（当前需求是物理删除对话连消息，符合题目要求）；
- **大表拆分**：消息量大时可将 `messages` / `group_messages` 按时间分区或迁移历史表，
  索引与查询结构不变；
- **切换 PostgreSQL**：见下节，代码零改动。

## 切换 PostgreSQL

如需切换 PostgreSQL（例如公网部署需要持久化、并发写较高）：

1. `prisma/schema.prisma` 中 `datasource db.provider` 改为 `"postgresql"`；
2. `DATABASE_URL` 改为 PostgreSQL 连接串；
3. 执行 `npm run db:migrate -- --name migrate_to_postgres` 生成新迁移；
4. 重新执行 `npm run db:seed`。

代码层无需其他改动（Prisma 抽象了方言差异）；切换后枚举会升级为 PG 原生 enum，
可进一步补充 CHECK 约束与部分索引（PG 特有能力）。
