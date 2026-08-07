/**
 * Swagger / OpenAPI 文档配置模块
 *
 * 【模块职责】
 * 基于 swagger-jsdoc 生成 OpenAPI 3.0 规范文档：
 * - 基础信息（标题/版本/描述）与全局组件（鉴权方案、通用错误响应模型）在此定义；
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
    // 服务地址：路径统一写全路径（如 /api/health）
    servers: [{ url: '/', description: '本地开发服务' }],
    // 全局组件：鉴权方案与通用错误响应模型
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
