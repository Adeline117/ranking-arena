# API 路由最佳实践

## 统一错误处理

所有新 API 路由必须使用 `lib/api/response.ts` 中的统一响应函数。

### 导入

```typescript
import {
  success,
  created,
  successNoContent,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  validationError,
  handleError,
} from '@/lib/api/response'
import { ApiError, ErrorCode } from '@/lib/api/errors'
```

### 标准 API 路由模板

```typescript
import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import {
  success,
  unauthorized,
  badRequest,
  handleError,
} from '@/lib/api/response'
import { ApiError, ErrorCode } from '@/lib/api/errors'

export async function GET(request: NextRequest) {
  try {
    // 1. 认证检查
    const supabase = createServerClient(/* ... */)
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return unauthorized('请先登录')
    }

    // 2. 参数验证
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return badRequest('缺少必要参数: id')
    }

    // 3. 业务逻辑
    const { data, error } = await supabase
      .from('some_table')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      throw ApiError.database('查询失败', error)
    }

    if (!data) {
      throw ApiError.notFound('资源不存在')
    }

    // 4. 返回成功响应
    return success(data)

  } catch (error) {
    // 5. 统一错误处理（自动上报 Sentry）
    return handleError(error, 'api/example')
  }
}
```

### 错误类型使用指南

| 场景 | 使用函数 | HTTP 状态码 |
|------|----------|------------|
| 未登录 | `unauthorized()` | 401 |
| 无权限 | `forbidden()` | 403 |
| 资源不存在 | `notFound()` | 404 |
| 参数错误 | `badRequest()` | 400 |
| 验证失败 | `validationError()` | 400 |
| 数据库错误 | `ApiError.database()` + `handleError()` | 500 |
| 限流 | `rateLimitError()` | 429 |
| 第三方服务错误 | `providerError()` | 502 |

### 成功响应

```typescript
// 返回数据
return success({ trader: traderData })

// 创建资源 (201)
return created({ id: newId })

// 删除成功 (204)
return successNoContent()

// 带分页
return successWithPagination(items, {
  limit: 20,
  offset: 0,
  has_more: true,
  total: 100
})
```

### 抛出 ApiError

```typescript
// 使用静态工厂方法
throw ApiError.unauthorized('登录已过期')
throw ApiError.forbidden('仅 Pro 用户可访问')
throw ApiError.notFound('交易员不存在')
throw ApiError.validation('邮箱格式不正确', { field: 'email' })
throw ApiError.database('查询失败', originalError)
throw ApiError.rateLimitExceeded(60) // 60秒后重试

// 自定义错误码
throw new ApiError('自定义错误消息', {
  code: ErrorCode.OPERATION_FAILED,
  details: { reason: 'xxx' }
})
```

## Stripe API 特殊处理

Stripe 相关 API 应额外处理 Stripe 特有错误：

```typescript
import Stripe from 'stripe'

try {
  // Stripe 操作
} catch (error) {
  if (error instanceof Stripe.errors.StripeError) {
    // 根据 error.type 处理
    switch (error.type) {
      case 'StripeCardError':
        return badRequest(error.message)
      case 'StripeInvalidRequestError':
        return badRequest('请求参数错误')
      case 'StripeRateLimitError':
        return providerRateLimitError(60, 'Stripe')
      default:
        return providerError(error.message)
    }
  }
  return handleError(error, 'api/stripe')
}
```

## 日志记录

使用 `createLogger` 记录关键操作：

```typescript
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api/example')

// 信息日志
logger.info('Operation started', { userId: user.id })

// 警告（4xx 错误）
logger.warn('Invalid request', { params })

// 错误（5xx 错误，自动上报 Sentry）
logger.error('Database error', error, { context: 'query' })
```

## 认证模式

### 方式 1：Cookie 认证（推荐用于 Web 前端）

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const supabase = createServerClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    cookies: {
      getAll() {
        return cookies().getAll()
      },
    },
  }
)
```

### 方式 2：Bearer Token 认证（用于 API 调用）

```typescript
const authHeader = request.headers.get('authorization')
if (authHeader?.startsWith('Bearer ')) {
  const token = authHeader.substring(7)
  const { data, error } = await supabaseAdmin.auth.getUser(token)
}
```

## 缓存控制

```typescript
import { success, withCache } from '@/lib/api/response'

// 添加缓存头
return withCache(success(data), {
  maxAge: 60,              // 客户端缓存 60 秒
  staleWhileRevalidate: 300, // 过期后 300 秒内可用旧数据
  isPublic: true           // 公开缓存（CDN）
})
```

---

最后更新: 2026-01-21
