/**
 * OpenAPI 文档生成器
 * 从 Zod schemas 生成 OpenAPI 规范
 */

import { z } from 'zod'

// ============================================
// 类型定义
// ============================================

interface OpenAPIInfo {
  title: string
  version: string
  description?: string
  contact?: {
    name?: string
    email?: string
    url?: string
  }
  license?: {
    name: string
    url?: string
  }
}

interface OpenAPIServer {
  url: string
  description?: string
}

interface OpenAPITag {
  name: string
  description?: string
}

interface OpenAPIPathItem {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody
  responses: Record<string, OpenAPIResponse>
  security?: Array<Record<string, string[]>>
  deprecated?: boolean
}

interface OpenAPIParameter {
  name: string
  in: 'query' | 'path' | 'header' | 'cookie'
  description?: string
  required?: boolean
  schema: Record<string, unknown>
  example?: unknown
}

interface OpenAPIRequestBody {
  description?: string
  required?: boolean
  content: {
    [mediaType: string]: {
      schema: Record<string, unknown>
      example?: unknown
    }
  }
}

interface OpenAPIResponse {
  description: string
  content?: {
    [mediaType: string]: {
      schema: Record<string, unknown>
      example?: unknown
    }
  }
}

interface OpenAPISpec {
  openapi: string
  info: OpenAPIInfo
  servers: OpenAPIServer[]
  tags?: OpenAPITag[]
  paths: Record<string, Record<string, OpenAPIPathItem>>
  components?: {
    schemas?: Record<string, Record<string, unknown>>
    securitySchemes?: Record<string, Record<string, unknown>>
  }
}

interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  summary: string
  description?: string
  tags?: string[]
  operationId?: string
  querySchema?: z.ZodTypeAny
  pathSchema?: z.ZodTypeAny
  bodySchema?: z.ZodTypeAny
  responseSchema?: z.ZodTypeAny
  auth?: boolean
  deprecated?: boolean
}

// ============================================
// Zod 到 JSON Schema 转换
// ============================================

/**
 * 获取 Zod schema 的内部类型
 * 兼容 Zod v3 和 v4
 */
function getZodInnerType(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const def = schema._def as unknown as Record<string, unknown>
  // Zod v4 使用 innerType，v3 使用 innerType 或 schema
  return (def.innerType ?? def.schema ?? null) as z.ZodTypeAny | null
}

/**
 * 获取 ZodDefault 的默认值
 */
function getDefaultValue(schema: z.ZodTypeAny): unknown {
  const def = schema._def as unknown as Record<string, unknown>
  // Zod v4 使用 defaultValue 函数
  if (typeof def.defaultValue === 'function') {
    return def.defaultValue()
  }
  return def.defaultValue
}

/**
 * 获取 ZodLiteral 的值
 */
function getLiteralValue(schema: z.ZodTypeAny): unknown {
  const def = schema._def as unknown as Record<string, unknown>
  return def.value
}

/**
 * 将 Zod schema 转换为 JSON Schema
 * 使用 instanceof 检查，兼容 Zod v4
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // String
  if (schema instanceof z.ZodString) {
    return handleStringSchema(schema)
  }
  // Number
  if (schema instanceof z.ZodNumber) {
    return handleNumberSchema(schema)
  }
  // Boolean
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }
  // Array
  if (schema instanceof z.ZodArray) {
    return handleArraySchema(schema)
  }
  // Object
  if (schema instanceof z.ZodObject) {
    return handleObjectSchema(schema)
  }
  // Enum
  if (schema instanceof z.ZodEnum) {
    return handleEnumSchema(schema)
  }
  // Union
  if (schema instanceof z.ZodUnion) {
    return handleUnionSchema(schema)
  }
  // Optional
  if (schema instanceof z.ZodOptional) {
    const inner = getZodInnerType(schema)
    return inner ? zodToJsonSchema(inner) : { type: 'object' }
  }
  // Nullable
  if (schema instanceof z.ZodNullable) {
    const inner = getZodInnerType(schema)
    return {
      ...(inner ? zodToJsonSchema(inner) : {}),
      nullable: true,
    }
  }
  // Default
  if (schema instanceof z.ZodDefault) {
    const inner = getZodInnerType(schema)
    return {
      ...(inner ? zodToJsonSchema(inner) : {}),
      default: getDefaultValue(schema),
    }
  }
  // Literal
  if (schema instanceof z.ZodLiteral) {
    return { const: getLiteralValue(schema) }
  }
  // Effects (transforms, refinements) - check by _def.typeName for Zod v4 compatibility
  const typeName = (schema._def as unknown as Record<string, unknown>)?.typeName
  if (typeName === 'ZodEffects' || typeName === 'ZodPipeline') {
    const inner = getZodInnerType(schema)
    return inner ? zodToJsonSchema(inner) : { type: 'object' }
  }
  // Default fallback
  return { type: 'object' }
}

function handleStringSchema(schema: z.ZodString): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'string' }
  
  // 安全访问 checks，兼容 Zod v3 和 v4
  const def = schema._def as unknown as Record<string, unknown>
  const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; regex?: RegExp }>
  
  for (const check of checks) {
    switch (check.kind) {
      case 'min':
        result.minLength = check.value
        break
      case 'max':
        result.maxLength = check.value
        break
      case 'email':
        result.format = 'email'
        break
      case 'url':
        result.format = 'uri'
        break
      case 'uuid':
        result.format = 'uuid'
        break
      case 'datetime':
        result.format = 'date-time'
        break
      case 'regex':
        if (check.regex) {
          result.pattern = check.regex.source
        }
        break
    }
  }
  
  return result
}

function handleNumberSchema(schema: z.ZodNumber): Record<string, unknown> {
  const result: Record<string, unknown> = { type: 'number' }
  
  // 安全访问 checks，兼容 Zod v3 和 v4
  const def = schema._def as unknown as Record<string, unknown>
  const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>
  
  for (const check of checks) {
    switch (check.kind) {
      case 'min':
        result.minimum = check.value
        break
      case 'max':
        result.maximum = check.value
        break
      case 'int':
        result.type = 'integer'
        break
    }
  }
  
  return result
}

function handleArraySchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as Record<string, unknown>
  // Zod v4 使用 element，v3 使用 type
  const itemType = (def.element ?? def.type) as z.ZodTypeAny | undefined
  const minLength = def.minLength as { value: number } | undefined
  const maxLength = def.maxLength as { value: number } | undefined

  return {
    type: 'array',
    ...(itemType && { items: zodToJsonSchema(itemType) }),
    ...(minLength && { minItems: minLength.value }),
    ...(maxLength && { maxItems: maxLength.value }),
  }
}

function handleObjectSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as Record<string, unknown>
  // shape 可能是函数（v3）或直接对象（v4）
  const shapeOrFn = def.shape
  const shape = typeof shapeOrFn === 'function' ? shapeOrFn() : shapeOrFn
  
  if (!shape || typeof shape !== 'object') {
    return { type: 'object' }
  }
  
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny
    properties[key] = zodToJsonSchema(zodValue)
    
    // 检查是否必填
    const isOptional = typeof zodValue.isOptional === 'function' ? zodValue.isOptional() : false
    const isNullable = typeof zodValue.isNullable === 'function' ? zodValue.isNullable() : false
    if (!isOptional && !isNullable) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  }
}

function handleEnumSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as Record<string, unknown>
  // Zod v4 使用 entries，v3 使用 values
  const values = (def.entries ?? def.values) as string[] | Record<string, string> | undefined

  // entries 可能是对象 { a: 'a', b: 'b' }，需要获取值
  const enumValues = Array.isArray(values) ? values : values ? Object.values(values) : []

  return {
    type: 'string',
    enum: enumValues,
  }
}

function handleUnionSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as Record<string, unknown>
  const options = (def.options ?? []) as z.ZodTypeAny[]

  return {
    oneOf: options.map((opt: z.ZodTypeAny) => zodToJsonSchema(opt)),
  }
}

// ============================================
// OpenAPI 生成器类
// ============================================

export class OpenAPIGenerator {
  private spec: OpenAPISpec
  private routes: RouteDefinition[] = []

  constructor(info: OpenAPIInfo, servers: OpenAPIServer[] = []) {
    this.spec = {
      openapi: '3.0.3',
      info,
      servers: servers.length > 0 ? servers : [{ url: '/api', description: '默认 API 服务器' }],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'sb-access-token',
          },
        },
      },
    }
  }

  /**
   * 添加标签
   */
  addTag(name: string, description?: string): this {
    if (!this.spec.tags) {
      this.spec.tags = []
    }
    this.spec.tags.push({ name, description })
    return this
  }

  /**
   * 添加路由定义
   */
  addRoute(route: RouteDefinition): this {
    this.routes.push(route)
    return this
  }

  /**
   * 添加 Schema 到 components
   */
  addSchema(name: string, schema: z.ZodTypeAny): this {
    if (!this.spec.components) {
      this.spec.components = { schemas: {} }
    }
    if (!this.spec.components.schemas) {
      this.spec.components.schemas = {}
    }
    this.spec.components.schemas[name] = zodToJsonSchema(schema)
    return this
  }

  /**
   * 生成 OpenAPI 规范
   */
  generate(): OpenAPISpec {
    for (const route of this.routes) {
      const pathItem = this.buildPathItem(route)
      
      if (!this.spec.paths[route.path]) {
        this.spec.paths[route.path] = {}
      }
      this.spec.paths[route.path][route.method] = pathItem
    }

    return this.spec
  }

  /**
   * 生成 JSON 字符串
   */
  toJSON(pretty = true): string {
    const spec = this.generate()
    return pretty ? JSON.stringify(spec, null, 2) : JSON.stringify(spec)
  }

  private buildPathItem(route: RouteDefinition): OpenAPIPathItem {
    const pathItem: OpenAPIPathItem = {
      summary: route.summary,
      description: route.description,
      operationId: route.operationId,
      tags: route.tags,
      deprecated: route.deprecated,
      responses: {
        '200': {
          description: '成功响应',
          ...(route.responseSchema && {
            content: {
              'application/json': {
                schema: zodToJsonSchema(route.responseSchema),
              },
            },
          }),
        },
        '400': {
          description: '请求参数错误',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', const: false },
                  error: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        '401': {
          description: '未授权',
        },
        '500': {
          description: '服务器错误',
        },
      },
    }

    // 添加认证要求
    if (route.auth) {
      pathItem.security = [{ bearerAuth: [] }, { cookieAuth: [] }]
    }

    // 添加参数
    const parameters: OpenAPIParameter[] = []

    // 路径参数
    if (route.pathSchema) {
      const pathParams = this.extractPathParams(route.path, route.pathSchema)
      parameters.push(...pathParams)
    }

    // 查询参数
    if (route.querySchema) {
      const queryParams = this.extractQueryParams(route.querySchema)
      parameters.push(...queryParams)
    }

    if (parameters.length > 0) {
      pathItem.parameters = parameters
    }

    // 请求体
    if (route.bodySchema && ['post', 'put', 'patch'].includes(route.method)) {
      pathItem.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: zodToJsonSchema(route.bodySchema),
          },
        },
      }
    }

    return pathItem
  }

  private extractPathParams(path: string, schema: z.ZodTypeAny): OpenAPIParameter[] {
    const params: OpenAPIParameter[] = []
    const pathParamRegex = /\{(\w+)\}/g
    let match

    while ((match = pathParamRegex.exec(path)) !== null) {
      const paramName = match[1]
      const paramSchema = (schema as z.ZodObject<any>).shape?.[paramName]
      
      params.push({
        name: paramName,
        in: 'path',
        required: true,
        schema: paramSchema ? zodToJsonSchema(paramSchema) : { type: 'string' },
      })
    }

    return params
  }

  private extractQueryParams(schema: z.ZodTypeAny): OpenAPIParameter[] {
    const params: OpenAPIParameter[] = []
    
    if (schema instanceof z.ZodObject) {
      const def = schema._def as unknown as Record<string, unknown>
      // shape 可能是函数（v3）或直接对象（v4）
      const shapeOrFn = def.shape
      const shape = typeof shapeOrFn === 'function' ? shapeOrFn() : shapeOrFn
      
      if (shape && typeof shape === 'object') {
        for (const [key, value] of Object.entries(shape)) {
          const zodValue = value as z.ZodTypeAny
          const isOptional = typeof zodValue.isOptional === 'function' ? zodValue.isOptional() : false
          params.push({
            name: key,
            in: 'query',
            required: !isOptional,
            schema: zodToJsonSchema(zodValue),
          })
        }
      }
    }

    return params
  }
}

// ============================================
// 预定义 API 文档
// ============================================

/**
 * 创建 Arena API 文档
 */
export function createRankingArenaOpenAPI(): OpenAPIGenerator {
  const generator = new OpenAPIGenerator(
    {
      title: 'Arena API',
      version: '1.0.0',
      description: '交易员排行榜和社区平台 API',
      contact: {
        name: 'Arena Team',
        url: 'https://www.arenafi.org',
      },
    },
    [
      { url: '/api', description: '生产环境' },
      { url: 'http://localhost:3000/api', description: '本地开发' },
    ]
  )

  // 添加标签
  generator
    .addTag('traders', '交易员相关接口')
    .addTag('posts', '帖子相关接口')
    .addTag('groups', '小组相关接口')
    .addTag('users', '用户相关接口')
    .addTag('market', '市场数据接口')
    .addTag('notifications', '通知相关接口')

  // 添加路由定义
  generator
    .addRoute({
      method: 'get',
      path: '/traders',
      summary: '获取交易员排行榜',
      tags: ['traders'],
      querySchema: z.object({
        source: z.string().optional(),
        season_id: z.enum(['7D', '30D', '90D']).optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    })
    .addRoute({
      method: 'get',
      path: '/trader/{handle}',
      summary: '获取交易员详情',
      tags: ['traders'],
      pathSchema: z.object({
        handle: z.string(),
      }),
    })
    .addRoute({
      method: 'get',
      path: '/posts',
      summary: '获取帖子列表',
      tags: ['posts'],
      querySchema: z.object({
        group_id: z.string().uuid().optional(),
        author_handle: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    })
    .addRoute({
      method: 'post',
      path: '/posts',
      summary: '创建新帖子',
      tags: ['posts'],
      auth: true,
      bodySchema: z.object({
        title: z.string().min(1).max(200),
        content: z.string().max(10000).optional(),
        group_id: z.string().uuid().optional(),
        images: z.array(z.string().url()).max(9).optional(),
      }),
    })
    .addRoute({
      method: 'get',
      path: '/market',
      summary: '获取市场数据',
      tags: ['market'],
    })
    .addRoute({
      method: 'get',
      path: '/notifications',
      summary: '获取用户通知',
      tags: ['notifications'],
      auth: true,
    })

  return generator
}

// ============================================
// 导出
// ============================================

export type {
  OpenAPIInfo,
  OpenAPIServer,
  OpenAPITag,
  OpenAPIPathItem,
  OpenAPIParameter,
  OpenAPIRequestBody,
  OpenAPIResponse,
  OpenAPISpec,
  RouteDefinition,
}
