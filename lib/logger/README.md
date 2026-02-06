# Logger Utility - Quick Reference

## Overview

The logger utility (`lib/logger.ts`) provides production-safe logging that outputs to console in development and sends errors to Sentry in production.

## Basic Usage

```typescript
import { logger } from '@/lib/logger'

// Simple error logging
logger.error('Something went wrong', { userId, action })

// API route errors
logger.apiError('/api/users/follow', error, { userId, targetId })

// Database operation errors
logger.dbError('Fetch user data', error, { userId })

// Warnings (development only)
logger.warn('Deprecated API called', { endpoint, version })

// Info logs (development only)
logger.info('Cache hit', { key, ttl })
```

## API Reference

### `logger.error(message, context?, error?)`
Log general errors. Always logs to console in dev, sends to Sentry in prod.

**Parameters:**
- `message` (string): Human-readable error message
- `context` (object, optional): Additional context (user IDs, operation details, etc.)
- `error` (Error, optional): Original error object for stack trace

**Example:**
```typescript
try {
  await riskyOperation()
} catch (error) {
  logger.error('Risky operation failed', { operation: 'import', count: 100 }, error)
  throw error
}
```

### `logger.apiError(endpoint, error, context?)`
Log API route errors with endpoint information.

**Parameters:**
- `endpoint` (string): API route path (e.g., '/api/users/follow')
- `error` (unknown): The caught error
- `context` (object, optional): Request context (user ID, params, etc.)

**Example:**
```typescript
export async function POST(request: Request) {
  try {
    // ... your logic
  } catch (error) {
    logger.apiError('/api/users/follow', error, {
      userId: session.user.id,
      targetUserId: body.targetUserId
    })
    return NextResponse.json({ error: 'Follow failed' }, { status: 500 })
  }
}
```

### `logger.dbError(operation, error, context?)`
Log database operation errors.

**Parameters:**
- `operation` (string): Database operation description (e.g., 'Fetch user', 'Update post')
- `error` (unknown): The caught error
- `context` (object, optional): Query context (IDs, filters, etc.)

**Example:**
```typescript
const { data, error: dbError } = await supabase
  .from('users')
  .select('*')
  .eq('id', userId)
  .single()

if (dbError) {
  logger.dbError('Fetch user by ID', dbError, { userId })
  throw new Error('User not found')
}
```

### `logger.warn(message, context?)`
Log warnings. Only outputs in development.

**Parameters:**
- `message` (string): Warning message
- `context` (object, optional): Additional context

**Example:**
```typescript
if (response.data.length === 0) {
  logger.warn('Empty response from API', { endpoint, params })
}
```

### `logger.info(message, context?)`
Log informational messages. Only outputs in development.

**Parameters:**
- `message` (string): Info message
- `context` (object, optional): Additional context

**Example:**
```typescript
logger.info('Cache hit', { key: cacheKey, ttl: 3600 })
```

## Best Practices

### ✅ DO

```typescript
// Include relevant context
logger.error('Payment failed', { userId, amount, currency }, error)

// Use specific operation names for dbError
logger.dbError('Update user subscription status', error, { userId, newStatus })

// Preserve original error for stack traces
logger.apiError('/api/webhook', error, { webhookType, timestamp })

// Use appropriate log levels
logger.warn('Rate limit approaching', { userId, requestCount, limit })
```

### ❌ DON'T

```typescript
// Don't use console.error directly
console.error('Error:', error) // ❌

// Don't log sensitive data
logger.error('Login failed', { password: userPassword }) // ❌

// Don't use generic messages without context
logger.error('Error') // ❌ Not helpful

// Don't duplicate logging
logger.error('Failed', {}, error)
console.error(error) // ❌ Redundant
```

## Migration from console.error

### Before:
```typescript
console.error('[API] Error fetching user:', error)
console.error('Database query failed:', error, { userId })
```

### After:
```typescript
logger.apiError('/api/users/[id]', error, { userId })
logger.dbError('Fetch user data', error, { userId })
```

## Environment Behavior

### Development (`NODE_ENV=development`)
- All logs output to console with color coding
- Errors include full stack traces
- Warnings and info logs are visible

### Production (`NODE_ENV=production`)
- Errors sent to Sentry with context
- Warnings and info logs are suppressed
- Console remains clean (no pollution)
- Full error context preserved in Sentry

## Sentry Integration

When errors are sent to Sentry in production, they include:

- Error message and stack trace
- Full context object as Sentry extras
- User information (if available)
- Environment and timestamp
- Breadcrumbs for debugging

This makes production debugging significantly easier than console.error.

## Common Patterns

### API Route Pattern
```typescript
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const session = await getSession()

    if (!session) {
      logger.warn('Unauthorized API access attempt', { endpoint: '/api/action' })
      return new Response('Unauthorized', { status: 401 })
    }

    // ... business logic

  } catch (error) {
    logger.apiError('/api/action', error, {
      userId: session?.user?.id,
      hasBody: !!body
    })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
```

### Database Query Pattern
```typescript
async function fetchUserWithPosts(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*, posts(*)')
    .eq('id', userId)
    .single()

  if (error) {
    logger.dbError('Fetch user with posts', error, { userId })
    throw new Error('Failed to load user data')
  }

  return data
}
```

### Async Operation Pattern
```typescript
async function processJob(jobId: string) {
  try {
    logger.info('Starting job', { jobId })

    const result = await performWork(jobId)

    logger.info('Job completed', { jobId, duration: result.duration })
    return result

  } catch (error) {
    logger.error('Job processing failed', { jobId, stage: 'processing' }, error)
    throw error
  }
}
```

## Troubleshooting

### "Logger not found" import error
Make sure you're importing from the correct path:
```typescript
import { logger } from '@/lib/logger'  // ✅
import { logger } from '../logger'     // ❌ Might break
```

### Sentry not receiving errors in production
Check:
1. `NEXT_PUBLIC_SENTRY_DSN` environment variable is set
2. Sentry is initialized in `app/layout.tsx` or similar
3. Production build is running (`NODE_ENV=production`)

### Logs not showing in development
Make sure `NODE_ENV` is not set to 'production' in your .env.local

---

**Remember:** Always prefer `logger` over `console.error` in production code!
