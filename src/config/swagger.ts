/**
 * Swagger / OpenAPI 文档配置模块
 *
 * 【模块职责】
 * 基于 swagger-jsdoc 生成 OpenAPI 3.0 规范文档：
 * - 基础信息（标题/版本/描述）与全局组件（鉴权方案、通用模型）在此定义；
 * - 每个接口的详细文档写在对应路由文件的 `@openapi` JSDoc 注释中（注释即文档），
 *   swagger-jsdoc 启动时会扫描这些文件并自动收集进规范；
 * - 生成结果通过 src/app.ts 挂载：`/api-docs`（可视化 UI）与 `/api-docs.json`（原始 JSON）。
 *
 * 【使用约定】
 * 新增/修改接口时，必须在路由处理函数上方同步维护 `@openapi` 注释，
 * 否则文档与实现会不一致（验收要求「实际 API 与文档一致」）。
 */
import swaggerJsdoc from 'swagger-jsdoc';

// swagger-jsdoc 配置：definition 为规范基础，apis 为扫描路径
const options: swaggerJsdoc.Options = {
  definition: {
    // OpenAPI 规范版本
    openapi: '3.0.0',
    // 文档基础信息（展示在 Swagger UI 顶部）
    info: {
      title: 'Endurance Chat API',
      version: '0.1.0',
      description:
        '类 ChatGPT 在线聊天应用 REST API 文档。接口注释即文档（swagger-jsdoc 自动收集），' +
        '请保持注释与实现一致。',
    },
    // 服务地址：路径统一写全路径（如 /api/auth/register）
    servers: [{ url: '/', description: '本地开发服务' }],
    // 全局组件：鉴权方案与通用请求/响应模型
    components: {
      securitySchemes: {
        // Bearer JWT 鉴权：登录/注册接口返回 token，后续接口携带 Authorization: Bearer <token>
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: '登录/注册后返回的 JWT，请求头格式：Authorization: Bearer <token>',
        },
      },
      schemas: {
        // 全站统一的错误响应模型：{ error: { code, message, details? } }
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                  description: '业务错误码，如 VALIDATION_ERROR / UNAUTHORIZED / AI_TIMEOUT',
                  example: 'VALIDATION_ERROR',
                },
                message: {
                  type: 'string',
                  description: '人类可读的错误描述',
                  example: 'Request validation failed',
                },
                details: {
                  description: '可选的补充信息（如字段级校验问题列表）',
                },
              },
            },
          },
        },
        // 公开用户信息（脱敏，不含密码哈希）
        User: {
          type: 'object',
          required: ['id', 'username', 'displayName', 'createdAt'],
          properties: {
            id: { type: 'string', description: '用户 id', example: 'cmxxxxxxx' },
            username: { type: 'string', description: '登录名', example: 'alice' },
            displayName: { type: 'string', description: '展示昵称', example: 'Alice' },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: '注册时间',
              example: '2026-08-07T08:57:35.176Z',
            },
          },
        },
        // 登录/注册成功响应：JWT + 用户信息
        AuthResult: {
          type: 'object',
          required: ['token', 'user'],
          properties: {
            token: {
              type: 'string',
              description: 'JWT，后续请求头携带 Authorization: Bearer <token>',
              example: 'eyJhbGciOiJIUzI1NiIs...',
            },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        // 注册请求体
        RegisterRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: {
              type: 'string',
              minLength: 3,
              maxLength: 32,
              description: '登录名（仅字母/数字/下划线）',
              example: 'alice',
            },
            password: {
              type: 'string',
              format: 'password',
              minLength: 8,
              maxLength: 72,
              description: '密码（8-72 位）',
              example: 'alice123456',
            },
            displayName: {
              type: 'string',
              maxLength: 32,
              description: '展示昵称（可选，缺省时取用户名）',
              example: 'Alice',
            },
          },
        },
        // 登录请求体
        LoginRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', description: '登录名', example: 'alice' },
            password: {
              type: 'string',
              format: 'password',
              description: '密码',
              example: 'alice123456',
            },
          },
        },
        // 对话标签（对外输出）
        ConversationTag: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string', description: '标签 id', example: 'cmxxxxxxx' },
            name: { type: 'string', description: '标签名', example: '工作' },
          },
        },
        // 个人对话（含标签列表）
        Conversation: {
          type: 'object',
          required: ['id', 'title', 'createdAt', 'updatedAt', 'tags'],
          properties: {
            id: { type: 'string', description: '对话 id', example: 'cmxxxxxxx' },
            title: { type: 'string', description: '对话标题', example: '学习计划' },
            createdAt: { type: 'string', format: 'date-time', description: '创建时间' },
            updatedAt: { type: 'string', format: 'date-time', description: '最近更新时间' },
            tags: {
              type: 'array',
              description: '对话标签列表',
              items: { $ref: '#/components/schemas/ConversationTag' },
            },
          },
        },
        // 创建对话请求体（标题可缺省）
        CreateConversationRequest: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              maxLength: 100,
              description: '对话标题（可选，缺省时为「新对话」，首条消息会替换它）',
              example: '学习计划',
            },
          },
        },
        // 修改对话标题请求体
        UpdateConversationTitleRequest: {
          type: 'object',
          required: ['title'],
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              description: '新的对话标题',
              example: '工作备忘',
            },
          },
        },
        // 添加标签请求体
        AddTagRequest: {
          type: 'object',
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 30,
              description: '标签名（按用户去重存储）',
              example: '工作',
            },
          },
        },
        // 对话列表响应
        ConversationList: {
          type: 'object',
          required: ['conversations'],
          properties: {
            conversations: {
              type: 'array',
              items: { $ref: '#/components/schemas/Conversation' },
            },
          },
        },
        // 消息（对外输出，含状态与 AI 错误信息）
        Message: {
          type: 'object',
          required: ['id', 'senderType', 'senderUserId', 'content', 'status', 'createdAt'],
          properties: {
            id: { type: 'string', description: '消息 id', example: 'cmxxxxxxx' },
            senderType: {
              type: 'string',
              enum: ['HUMAN', 'BOT'],
              description: '发送者类型：HUMAN 人类 / BOT 机器人',
            },
            senderUserId: {
              type: 'string',
              nullable: true,
              description: '人类消息的作者 id；机器人消息为 null',
            },
            content: { type: 'string', description: '消息内容（AI 失败时为空串）' },
            status: {
              type: 'string',
              enum: ['PENDING', 'SENT', 'FAILED'],
              description: '消息状态：FAILED 表示 AI 重试后仍失败',
            },
            errorCode: {
              type: 'string',
              nullable: true,
              description: 'AI 失败错误码（如 AI_TIMEOUT / AI_UNAVAILABLE）',
            },
            errorMessage: {
              type: 'string',
              nullable: true,
              description: 'AI 失败错误描述',
            },
            createdAt: { type: 'string', format: 'date-time', description: '发送时间' },
          },
        },
        // 发送消息请求体
        SendMessageRequest: {
          type: 'object',
          required: ['content'],
          properties: {
            content: {
              type: 'string',
              minLength: 1,
              maxLength: 4000,
              description: '消息内容（1-4000 字符）',
              example: '你好，请帮我制定一个学习计划',
            },
            clientRequestId: {
              type: 'string',
              minLength: 8,
              maxLength: 64,
              description:
                '幂等键（可选）：同一对话内相同键重复提交不会产生重复消息；' +
                '不同对话可使用相同幂等键，互不影响',
              example: 'req-00000001',
            },
          },
        },
        // 发送消息响应：用户消息 + AI 回复
        SendMessageResult: {
          type: 'object',
          required: ['userMessage', 'aiMessage'],
          properties: {
            userMessage: { $ref: '#/components/schemas/Message' },
            aiMessage: {
              allOf: [{ $ref: '#/components/schemas/Message' }],
              nullable: true,
              description: 'AI 回复（同步流程下必有；失败时为 FAILED 状态）',
            },
          },
        },
        // 消息列表响应
        MessageList: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/Message' },
            },
          },
        },
        // 机器人角色预设（对外输出）
        Bot: {
          type: 'object',
          required: ['id', 'code', 'name', 'personality'],
          properties: {
            id: { type: 'string', description: '机器人 id', example: 'cmxxxxxxx' },
            code: { type: 'string', description: '稳定标识', example: 'customer-service' },
            name: { type: 'string', description: '机器人名称', example: '客服机器人' },
            personality: { type: 'string', description: '性格/回复倾向描述' },
          },
        },
        // 群组成员（对外输出）
        GroupMember: {
          type: 'object',
          required: ['userId', 'displayName', 'role', 'joinedAt'],
          properties: {
            userId: { type: 'string', description: '成员用户 id' },
            displayName: { type: 'string', description: '成员昵称' },
            role: {
              type: 'string',
              enum: ['OWNER', 'MEMBER'],
              description: 'OWNER 创建者（可管理）/ MEMBER 普通成员',
            },
            joinedAt: { type: 'string', format: 'date-time', description: '加入时间' },
          },
        },
        // 群组详情（对外输出）
        Group: {
          type: 'object',
          required: [
            'id',
            'name',
            'creatorId',
            'responseMode',
            'maxConsecutiveBotReplies',
            'members',
            'bots',
          ],
          properties: {
            id: { type: 'string', description: '群组 id' },
            name: { type: 'string', description: '群组名称' },
            creatorId: { type: 'string', description: '创建者用户 id' },
            responseMode: {
              type: 'string',
              enum: ['ALL_BOTS', 'RANDOM_ONE', 'CONTENT_ROUTED'],
              description: '机器人响应策略',
            },
            maxConsecutiveBotReplies: {
              type: 'integer',
              description: '每轮机器人回复数上限（防循环）',
              example: 3,
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            members: {
              type: 'array',
              items: { $ref: '#/components/schemas/GroupMember' },
            },
            bots: {
              type: 'array',
              items: { $ref: '#/components/schemas/Bot' },
            },
          },
        },
        // 创建群组请求体
        CreateGroupRequest: {
          type: 'object',
          required: ['name', 'botIds'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 50,
              description: '群组名称',
              example: '技术讨论群',
            },
            botIds: {
              type: 'array',
              minItems: 1,
              description: '初始机器人 id 列表（至少 1 个）',
              items: { type: 'string', example: 'cmxxxxxxx' },
            },
            responseMode: {
              type: 'string',
              enum: ['ALL_BOTS', 'RANDOM_ONE', 'CONTENT_ROUTED'],
              description: '响应策略（缺省 ALL_BOTS）',
              default: 'ALL_BOTS',
            },
            maxConsecutiveBotReplies: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: '每轮回复数上限（缺省 3）',
              default: 3,
            },
          },
        },
        // 更新群组配置请求体
        UpdateGroupRequest: {
          type: 'object',
          description: '至少提供一个字段',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 50, description: '群组名称' },
            responseMode: {
              type: 'string',
              enum: ['ALL_BOTS', 'RANDOM_ONE', 'CONTENT_ROUTED'],
              description: '响应策略',
            },
            maxConsecutiveBotReplies: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: '每轮回复数上限',
            },
          },
        },
        // 添加成员请求体
        AddMemberRequest: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', description: '待添加的用户 id' },
          },
        },
        // 添加机器人请求体
        AddBotRequest: {
          type: 'object',
          required: ['botId'],
          properties: {
            botId: { type: 'string', description: '机器人 id' },
          },
        },
        // 群组消息（对外输出，含轮次标识）
        GroupMessage: {
          type: 'object',
          required: ['id', 'groupId', 'roundId', 'senderType', 'content', 'status', 'createdAt'],
          properties: {
            id: { type: 'string', description: '消息 id' },
            groupId: { type: 'string', description: '群组 id' },
            roundId: {
              type: 'string',
              nullable: true,
              description: '轮次 id：一条人类消息触发的一轮回复共享同一 roundId',
            },
            senderType: {
              type: 'string',
              enum: ['HUMAN', 'BOT'],
              description: 'HUMAN 人类 / BOT 机器人',
            },
            userId: { type: 'string', nullable: true, description: '人类发言者 id' },
            botId: { type: 'string', nullable: true, description: '机器人 id' },
            content: { type: 'string', description: '消息内容' },
            status: {
              type: 'string',
              enum: ['PENDING', 'SENT', 'FAILED'],
              description: '消息状态',
            },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        // 发送群组消息请求体
        SendGroupMessageRequest: {
          type: 'object',
          required: ['content'],
          properties: {
            content: {
              type: 'string',
              minLength: 1,
              maxLength: 4000,
              description: '消息内容（1-4000 字符）',
              example: '谁能帮我看看这个 bug？',
            },
          },
        },
        // 发送群组消息响应：人类消息 + 本轮机器人回复
        SendGroupMessageResult: {
          type: 'object',
          required: ['userMessage', 'botMessages'],
          properties: {
            userMessage: { $ref: '#/components/schemas/GroupMessage' },
            botMessages: {
              type: 'array',
              description: '本轮机器人回复列表（受防循环上限约束）',
              items: { $ref: '#/components/schemas/GroupMessage' },
            },
          },
        },
        // 群组消息列表响应
        GroupMessageList: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/GroupMessage' },
            },
          },
        },
      },
    },
  },
  // 扫描的源码路径：当前与未来所有路由文件都会被收集
  apis: ['src/routes/**/*.ts', 'src/api/routes/**/*.ts'],
};

/**
 * 生成的 OpenAPI 规范对象
 *
 * 导出后供 app.ts 使用：
 * - swaggerUi.setup(swaggerSpec) 渲染文档 UI；
 * - GET /api-docs.json 返回原始 JSON，供一致性检查与第三方工具使用。
 */
export const swaggerSpec = swaggerJsdoc(options);
