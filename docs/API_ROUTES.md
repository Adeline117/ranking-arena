# API Route Ownership

Status: **Canonical policy; route inventory is code-generated at build time**

The App Router filesystem under `app/api/` is the source of truth for HTTP
routes. Do not maintain a copied endpoint count or hand-written route catalog in
this document; those lists drift as soon as a route is added or retired.

## Discovering routes

- Browse `app/api/**/route.ts` for implementation ownership.
- Run `npm run build` for the complete Next.js route inventory.
- Use `/api-docs` for the public API documentation surface.
- Inspect `vercel.json` for scheduled Vercel invocations. A cron route that is
  absent from this file is not thereby scheduled.

## Boundary rules

- UI modules call public/domain contracts; they do not import route implementations.
- Route files authenticate, validate, invoke `lib/<domain>/`, and serialize.
- Public, authenticated, admin, webhook, and cron routes use their shared wrappers.
- First-party exchange acquisition belongs to the BullMQ ingest worker, not an HTTP
  route or a legacy connector.
- Applied database migrations remain immutable.

## Required checks

```bash
npm run qa:api-auth
npm run qa:architecture
npm run type-check
npm test
npm run build
```

See `docs/API_BEST_PRACTICES.md`, `docs/REPOSITORY_STRUCTURE.md`, and
`docs/ARCHITECTURE.md` for implementation and dependency guidance.
