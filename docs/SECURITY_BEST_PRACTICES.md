# Security Best Practices

This document outlines security best practices for the Ranking Arena project.

---

## Table of Contents

1. [Authentication & Authorization](#authentication--authorization)
2. [Input Validation & Sanitization](#input-validation--sanitization)
3. [XSS Prevention](#xss-prevention)
4. [CSRF Protection](#csrf-protection)
5. [SQL Injection Prevention](#sql-injection-prevention)
6. [Environment Variables & Secrets](#environment-variables--secrets)
7. [API Security](#api-security)
8. [Rate Limiting](#rate-limiting)
9. [Dependency Management](#dependency-management)
10. [Security Headers](#security-headers)
11. [Monitoring & Incident Response](#monitoring--incident-response)

---

## Authentication & Authorization

### Supabase Authentication

**DO**:
- Always use Supabase Auth for user authentication
- Verify tokens server-side for sensitive operations
- Use Row Level Security (RLS) policies on all tables
- Implement proper session management

**DON'T**:
- Trust client-side authentication checks
- Store sensitive data in localStorage without encryption
- Expose service role keys to the client

**Example**:
```typescript
// ✅ GOOD: Server-side token verification
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(url, serviceKey)
const { data: { user }, error } = await supabase.auth.getUser(token)

if (!user) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
```

### Admin Authorization

**DO**:
- Use dual verification (email whitelist + database role)
- Store admin emails in environment variables
- Log all admin actions
- Implement rate limiting on admin endpoints

**DON'T**:
- Hardcode admin emails in source code
- Trust client-side role checks
- Skip authorization checks

**Example**:
```typescript
// ✅ GOOD: Dual admin verification
import { verifyAdmin } from '@/lib/admin/auth'

const admin = await verifyAdmin(supabase, authHeader)
if (!admin) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
```

---

## Input Validation & Sanitization

### Zod Schema Validation

**DO**:
- Define Zod schemas for all API inputs
- Validate before processing
- Use `.strip()` to remove unknown fields
- Limit string lengths to prevent DoS

**DON'T**:
- Trust user input without validation
- Use `any` types
- Skip validation for "trusted" sources

**Example**:
```typescript
// ✅ GOOD: Zod validation
import { z } from 'zod'

const createPostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10000),
  tags: z.array(z.string()).max(10).optional(),
}).strip()

const body = await req.json()
const validated = createPostSchema.parse(body)
```

### Search Input Sanitization

**DO**:
- Escape special characters in search queries
- Limit search term length
- Use parameterized queries
- Escape PostgREST filter injection characters (`%`, `_`)

**Example**:
```typescript
// ✅ GOOD: Search sanitization
const sanitizedSearch = search
  .slice(0, 100) // Limit length
  .replace(/[\\%_]/g, c => `\\${c}`) // Escape special chars
  .replace(/[.,()]/g, '') // Remove punctuation

query = query.or(`handle.ilike.%${sanitizedSearch}%`)
```

---

## XSS Prevention

### React Automatic Escaping

**DO**:
- Rely on React's automatic escaping for user content
- Use DOMPurify for sanitizing HTML
- Validate and sanitize URLs
- Use Content Security Policy headers

**DON'T**:
- Use `dangerouslySetInnerHTML` with user input
- Trust HTML from external sources
- Use inline event handlers

### Safe `dangerouslySetInnerHTML` Usage

**ONLY USE FOR**:
1. **Static SVG icons**: Hardcoded constants
2. **JSON-LD schema**: Server-generated, JSON.stringify escaped
3. **Server data injection**: Trusted server data only

**Example**:
```typescript
// ✅ GOOD: Static SVG
<div dangerouslySetInnerHTML={{ __html: EXCHANGE_SVG[exchange] }} />

// ✅ GOOD: JSON-LD schema (automatically escaped)
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
/>

// ❌ BAD: User input
<div dangerouslySetInnerHTML={{ __html: userComment }} />

// ✅ GOOD: Sanitized user input
import DOMPurify from 'isomorphic-dompurify'
<div dangerouslySetInnerHTML={{
  __html: DOMPurify.sanitize(userComment)
}} />
```

---

## CSRF Protection

### Supabase Built-in Protection

Supabase Auth provides CSRF protection through:
- Same-site cookies
- Token-based authentication
- CORS configuration

**DO**:
- Use Supabase client methods for mutations
- Verify `Origin` header for state-changing operations
- Use SameSite cookie attribute

**DON'T**:
- Accept mutations from any origin
- Skip CORS configuration

---

## SQL Injection Prevention

### Supabase PostgREST Safety

**DO**:
- Use Supabase client methods (automatically parameterized)
- Sanitize filter inputs
- Use RLS policies as defense-in-depth
- Validate all input parameters

**DON'T**:
- Build raw SQL queries from user input
- Trust client-provided filter strings

**Example**:
```typescript
// ✅ GOOD: Parameterized query
const { data } = await supabase
  .from('posts')
  .select('*')
  .eq('user_id', userId) // Safe: parameterized

// ❌ BAD: Raw SQL (if using pg directly)
const { rows } = await client.query(
  `SELECT * FROM posts WHERE user_id = ${userId}` // Vulnerable!
)

// ✅ GOOD: Parameterized raw SQL (if needed)
const { rows } = await client.query(
  'SELECT * FROM posts WHERE user_id = $1',
  [userId]
)
```

---

## Environment Variables & Secrets

### Secret Management

**DO**:
- Store secrets in `.env.local` (gitignored)
- Use `NEXT_PUBLIC_` prefix ONLY for client-safe variables
- Validate environment variables at startup
- Rotate secrets regularly
- Use different secrets for development/production

**DON'T**:
- Commit `.env.local` to git
- Expose server secrets to client
- Hardcode secrets in source code
- Share secrets in plain text

**Example**:
```typescript
// ✅ GOOD: Server-only secret
const stripeSecret = process.env.STRIPE_SECRET_KEY

// ✅ GOOD: Client-safe public key
const stripePublic = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

// ❌ BAD: Exposing server secret to client
const badPublic = process.env.STRIPE_SECRET_KEY // No NEXT_PUBLIC_ prefix!
```

### Environment Validation

**DO**:
- Use `lib/env.ts` for validation
- Fail fast on missing required variables
- Document all variables in `.env.example`

**Example**:
```typescript
// ✅ GOOD: Validated environment
import { validateEnv, env } from '@/lib/env'

validateEnv() // Throws if invalid

const apiKey = env.supabaseServiceKey // Type-safe
```

---

## API Security

### API Route Protection

**DO**:
- Verify authentication on all protected routes
- Implement rate limiting
- Validate request body/params
- Use proper HTTP status codes
- Log security events

**DON'T**:
- Trust request headers without verification
- Skip authentication checks
- Return detailed error messages to clients

**Example**:
```typescript
// ✅ GOOD: Protected API route
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  // 1. Rate limiting
  const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  // 2. Authentication
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 3. Input validation
  const body = await req.json()
  const validated = schema.parse(body)

  // 4. Authorization (if needed)
  if (validated.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Process request...
}
```

### Cron Job Security

**DO**:
- Require `CRON_SECRET` for all cron endpoints
- Verify `Authorization` header
- Log all cron executions
- Implement timeout limits

**Example**:
```typescript
// ✅ GOOD: Protected cron endpoint
import { isAuthorized } from '@/lib/cron/utils'

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Process cron job...
}
```

---

## Rate Limiting

### Upstash Rate Limiting

**DO**:
- Use rate limiting on all public endpoints
- Use stricter limits for sensitive operations
- Return proper 429 status code
- Include `Retry-After` header

**Presets**:
- `RateLimitPresets.strict`: 5 req/min (login, signup)
- `RateLimitPresets.sensitive`: 15 req/min (admin, password reset)
- `RateLimitPresets.write`: 30 req/min (create, update, delete)
- `RateLimitPresets.read`: 60 req/min (GET requests)

**Example**:
```typescript
// ✅ GOOD: Rate limited endpoint
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export async function POST(req: Request) {
  const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResponse) {
    return rateLimitResponse // 429 Too Many Requests
  }
  // Process request...
}
```

---

## Dependency Management

### NPM Audit

**DO**:
- Run `npm audit` weekly
- Update dependencies monthly
- Review breaking changes before updating
- Test thoroughly after updates
- Use Dependabot or Renovate for automation

**DON'T**:
- Ignore security advisories
- Run `npm audit fix --force` without testing
- Use outdated packages

**Workflow**:
```bash
# Weekly security check
npm audit

# Safe updates (patch/minor)
npm audit fix

# Review audit report
npm audit --json > audit-report.json

# Update specific package
npm install package@latest

# Test
npm run test
npm run build
```

### Dependency Review

**Before adding a dependency**:
1. Check npm security advisories
2. Review maintenance status (last update date)
3. Check download statistics
4. Review GitHub repository (stars, issues, PRs)
5. Consider bundle size impact

---

## Security Headers

### Next.js Configuration

Our `next.config.ts` includes comprehensive security headers:

**Content Security Policy (CSP)**:
- Prevents XSS attacks
- Restricts resource loading
- Blocks inline scripts (except necessary Next.js scripts)

**HTTP Security Headers**:
- `Strict-Transport-Security`: Forces HTTPS
- `X-Content-Type-Options`: Prevents MIME sniffing
- `X-Frame-Options`: Prevents clickjacking
- `X-XSS-Protection`: Browser XSS filter
- `Referrer-Policy`: Controls referrer information
- `Permissions-Policy`: Restricts browser features

**DO**:
- Keep CSP directives strict
- Use nonces for inline scripts (production)
- Review headers regularly
- Test headers with security scanners

**DON'T**:
- Use `unsafe-inline` without justification
- Allow `*` wildcards in CSP
- Disable security headers for debugging

---

## Monitoring & Incident Response

### Sentry Error Tracking

**DO**:
- Configure Sentry for production
- Set up error alerts
- Review errors weekly
- Include context in error logs
- Filter sensitive data from error reports

**Example**:
```typescript
// ✅ GOOD: Sanitized error logging
import * as Sentry from '@sentry/nextjs'

try {
  // Risky operation
} catch (error) {
  Sentry.captureException(error, {
    contexts: {
      operation: {
        type: 'payment',
        // Don't include sensitive data!
      },
    },
  })
}
```

### Security Logging

**DO**:
- Log authentication failures
- Log authorization failures
- Log rate limit violations
- Log suspicious activity patterns
- Use structured logging

**DON'T**:
- Log passwords or tokens
- Log sensitive user data
- Ignore security logs

**Example**:
```typescript
// ✅ GOOD: Security logging
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('auth')

if (failedLoginAttempts > 5) {
  logger.warn('Multiple failed login attempts', {
    userId: user.id,
    attempts: failedLoginAttempts,
    ip: req.headers.get('x-forwarded-for'),
  })
}
```

---

## Security Checklist

Use this checklist for new features:

### Before Deployment

- [ ] All user inputs validated with Zod
- [ ] Authentication required for protected routes
- [ ] Authorization checks implemented
- [ ] Rate limiting configured
- [ ] No `dangerouslySetInnerHTML` with user input
- [ ] No secrets exposed to client
- [ ] Error messages don't leak sensitive info
- [ ] Security headers configured
- [ ] RLS policies updated
- [ ] Tests include security scenarios
- [ ] Code reviewed for security issues
- [ ] `npm audit` shows no high/critical issues

### After Deployment

- [ ] Monitor Sentry for errors
- [ ] Check rate limit violations
- [ ] Review authentication logs
- [ ] Verify CSP headers working
- [ ] Test with security scanner
- [ ] Update security documentation

---

## Reporting Security Issues

If you discover a security vulnerability, please:

1. **DO NOT** open a public issue
2. Email security@rankinga.com (replace with actual email)
3. Include:
   - Vulnerability description
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and provide updates as we address the issue.

---

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Next.js Security](https://nextjs.org/docs/app/building-your-application/configuring/security-headers)
- [Supabase Security](https://supabase.com/docs/guides/auth/security)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
- [Snyk Vulnerability Database](https://security.snyk.io/)

---

**Last Updated**: 2026-01-28
**Next Review**: 2026-02-28
