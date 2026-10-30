# Prepare an Arena Preview Deployment

A preview deployment is an external state change. Do not create, promote, roll back,
cancel, or delete a deployment unless the current task explicitly authorizes that
action. Never assume a preview is isolated from production data.

## 1. Pre-deploy evidence

From a clean, pushed commit, record the branch and SHA and run the checks required by
the change:

```bash
npm run type-check
npm run lint
npm run test
npm run build
```

Use focused and ingest/migration QA where applicable. A checked-in migration is not
permission to apply it; record any migration, environment, secret, capacity, or data
witness still required.

## 2. Create a preview only when authorized

Vercel derives the Git branch from the current checkout; the CLI has no supported
`--branch` deploy option. Use the project's GitHub preview integration when possible.
If the task explicitly requires a manual preview and the authenticated project/team
has been verified, the current CLI form is:

```bash
vercel deploy --yes
```

Do not add `--prod`, pull production environment files, print tokens, or alter Vercel
configuration as part of a preview request.

## 3. Verify the exact preview release

- Match the preview URL to the intended commit SHA.
- Check homepage, published ranking API, trader detail, auth boundaries, and changed
  endpoints.
- Verify response bodies and cache/privacy headers, not only status codes.
- Treat production-backed reads and all writes as out of scope unless separately
  approved.
- Record unavailable witnesses and logs without copying secrets or personal data.

Promotion, production migration, cache purge, rollback, and custom-domain checks are
separate reviewed operations.
