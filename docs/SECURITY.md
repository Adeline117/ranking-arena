# Security Guide

This document covers security headers and best practices implemented in Arena.

## Security Headers

Security headers are configured in `next.config.ts`:

### Content Security Policy (CSP)

Controls which resources can be loaded:

```
default-src 'self'
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://challenges.cloudflare.com
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
img-src 'self' data: blob: https: http:
font-src 'self' https://fonts.gstatic.com
connect-src 'self' https://*.supabase.co https://*.stripe.com https://*.sentry.io wss://*.supabase.co https://api.coingecko.com
frame-src 'self' https://js.stripe.com https://challenges.cloudflare.com
frame-ancestors 'none'
form-action 'self'
base-uri 'self'
object-src 'none'
upgrade-insecure-requests
```

### HTTP Strict Transport Security (HSTS)

Forces HTTPS connections:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

### Additional Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS protection |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Control referrer information |
| `Permissions-Policy` | (see below) | Restrict browser features |

### Permissions Policy

Restricts access to browser features:

```
camera=(), microphone=(), geolocation=(), interest-cohort=()
```

## Authentication

Arena uses Supabase Auth for authentication:

- Session management via HTTP-only cookies
- Row Level Security (RLS) on all database tables
- JWT tokens for API authentication

### Protected Routes

Server-side protection pattern:

```typescript
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function ProtectedPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // ... render protected content
}
```

## Database Security

### Row Level Security (RLS)

All Supabase tables have RLS policies. See `docs/RLS_POLICIES.md` for details.

Example policy pattern:

```sql
-- Users can only read their own data
CREATE POLICY "Users can read own data"
ON user_settings FOR SELECT
USING (auth.uid() = user_id);

-- Users can only update their own data
CREATE POLICY "Users can update own data"
ON user_settings FOR UPDATE
USING (auth.uid() = user_id);
```

## API Security

### Rate Limiting

API routes implement rate limiting via Upstash Redis:

```typescript
import { ratelimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  const { success } = await ratelimit.limit(ip)
  if (!success) {
    return new Response('Too Many Requests', { status: 429 })
  }
  // ... handle request
}
```

### Input Validation

All API inputs are validated using Zod:

```typescript
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  handle: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
})

const result = schema.safeParse(input)
if (!result.success) {
  return new Response('Invalid input', { status: 400 })
}
```

## Client-Side Security

### XSS Prevention

- Use React's built-in escaping for dynamic content
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Sanitize user-generated HTML with DOMPurify when needed

### CSRF Protection

- Supabase handles CSRF for auth endpoints
- Custom APIs should validate origin headers

## Sensitive Data Handling

### Environment Variables

- Never commit `.env` files
- Use `.env.local` for local development
- Set production secrets in Vercel dashboard

### Logging

Never log sensitive data:

```typescript
// BAD
logger.info('User logged in', { email, password })

// GOOD
logger.info('User logged in', { userId: user.id })
```

## Security Checklist

- [ ] CSP headers configured and tested
- [ ] HTTPS enforced via HSTS
- [ ] RLS policies on all tables
- [ ] API rate limiting enabled
- [ ] Input validation on all endpoints
- [ ] Sensitive data excluded from logs
- [ ] Auth tokens stored in HTTP-only cookies
- [ ] Permissions Policy restricts unnecessary features
