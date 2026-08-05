# Logger Utility - Quick Reference

## Overview

The canonical logger utility (`lib/utils/logger.ts`) writes all enabled levels to
the development console. In production, server-side `warn`/`error` entries are
structured JSON, while browser entries use the native console. When
`logger.error`, `logger.apiError`, or `logger.dbError` receives an `Error`
instance, it also attempts to capture that exception in Sentry. `lib/logger.ts`
is a compatibility shim for existing imports only.

## Basic Usage

```typescript
import { logger } from '@/lib/utils/logger'

// Simple error logging
logger.error('Something went wrong', { userId, action })

// API route errors
logger.apiError('/api/users/follow', error, { userId, targetId })

// Database operation errors
logger.dbError('Fetch user data', error, { userId })

// Warnings (development and production)
logger.warn('Deprecated API called', { endpoint, version })

// Info logs (development only)
logger.info('Cache hit', { key, ttl })
```

## API Reference

### `logger.error(message, ...data)`

Log general errors. Output goes to the development console, structured console
on the production server, or native console in the production browser. Passing
an `Error` instance in the data arguments also attempts Sentry capture; context
objects alone do not.

**Parameters:**

- `message` (string): Human-readable error message
- `data` (unknown[]): Optional context values and `Error` objects; any supplied
  `Error` triggers best-effort Sentry capture

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
      targetUserId: body.targetUserId,
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
const { data, error: dbError } = await supabase.from('users').select('*').eq('id', userId).single()

if (dbError) {
  logger.dbError('Fetch user by ID', dbError, { userId })
  throw new Error('User not found')
}
```

### `logger.warn(message, context?)`

Log warnings. Outputs in development and as structured production logs.

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
- `Error` objects passed as data retain the native console stack display
- Warnings and info logs are visible

### Production (`NODE_ENV=production`)

- Server-side `warn` and `error` output as structured JSON for the configured
  log collector; browser-side entries use the native console
- `debug`, `log`, and `info` are suppressed by the default minimum level
- An `Error` passed to `logger.error`, `logger.apiError`, or `logger.dbError`
  triggers a best-effort Sentry exception capture
- Context-only error logs remain console entries (structured server-side) and do
  not invent a Sentry exception

## Sentry Integration

When an `Error` instance is captured in Sentry, the logger supplies:

- Error message and stack trace
- `apiError` and `dbError` context as Sentry extras
- For direct `logger.error`, the log message and logger identity as Sentry
  extras; adjacent context objects are not automatically copied into the event
- Sentry's configured environment and event metadata

Breadcrumbs are recorded only by call sites that explicitly use
`addBreadcrumb`; they are not synthesized for every log entry.

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
      hasBody: !!body,
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

Make sure new code imports the canonical module:

```typescript
import { logger } from '@/lib/utils/logger' // ✅ canonical
import { logger } from '@/lib/logger' // ⚠️ compatibility shim; do not add new imports
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
