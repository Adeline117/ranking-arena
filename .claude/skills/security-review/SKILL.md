---
name: security-review
description: Arena-specific security review. Use when modifying auth, payment, API endpoints, or RLS policies.
---

# Arena Security Review

## Arena-Specific Security Points

### 1. Supabase RLS (Most Critical)
- Every table MUST have RLS enabled
- User data: `auth.uid() = user_id` policy
- Public data (traders, rankings): SELECT-only for anon
- Admin routes: check `is_admin` in RLS or API middleware
- NEVER use `SECURITY DEFINER` without explicit approval

### 2. Cron Route Auth
```typescript
// All /api/cron/* routes MUST verify:
const authHeader = request.headers.get('authorization')
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  return new Response('Unauthorized', { status: 401 })
}
```

### 3. Stripe Webhook Verification
```typescript
// MUST verify webhook signature — never trust raw body
const sig = request.headers.get('stripe-signature')
const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET)
```

### 4. Secrets Management
- All secrets in env vars, never hardcoded
- `.env.local` in .gitignore
- Production secrets in Vercel Dashboard
- NEVER commit: API keys, DB passwords, tokens
- NEVER store exchange API secrets (compliance rule)

### 5. Input Validation
- Use Zod schemas at API boundaries (`lib/validation/`)
- Sanitize user-generated content (posts, comments, bios)
- Validate `source` + `source_trader_id` composite keys

### 6. Auth Patterns
- Supabase Auth + Privy (Web3) — dual auth system
- `getUser()` from `@supabase/ssr` for server-side auth
- Protected API routes: check `supabase.auth.getUser()` first
- Rate limit auth endpoints (login, signup, password reset)

### 7. Compliance Red Lines
- NO investment advice in UI copy
- NO storing user trading data or exchange API secrets
- NO executing trades on behalf of users
- Risk disclaimers must be visible

## Quick Checklist
- [ ] RLS policy on new/modified tables?
- [ ] Cron routes check `CRON_SECRET`?
- [ ] Stripe webhooks verify signature?
- [ ] No hardcoded secrets?
- [ ] User input validated with Zod?
- [ ] Auth checked on protected routes?
- [ ] No compliance violations?
