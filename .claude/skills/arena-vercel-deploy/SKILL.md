# Arena Vercel Deployment

## Standard release path

1. Work in an isolated worktree and feature branch.
2. Run the risk-proportionate local checks, including type-check, lint, tests,
   and production build for runtime changes.
3. Push the feature branch and open a pull request.
4. Require repository CI to pass. After approval and merge, Deploy Gate is the
   sole normal promoter of the production domain.
5. Confirm the exact merged SHA through the gate's smoke evidence and public
   health endpoint. A READY candidate or a branch push is not proof that
   production advanced.

Do not run a manual production deploy, alter production environment variables,
or promote a candidate as part of the standard path. Use the reviewed
break-glass procedure in `docs/RUNBOOK.md` only with explicit production-change
authorization.

## Observation

```bash
gh run list --workflow ci.yml --limit 10
gh run list --workflow deploy-gate.yml --limit 10
```

Use the Vercel Dashboard for deployment logs and identity evidence. Never place
tokens in a command line, document, issue, or pull-request body.

## Common failures

- **Clean-build TypeScript failure:** reproduce with `npm ci --ignore-scripts`
  under the repository's Node version, then run `npm run type-check`.
- **Missing environment contract:** update the documented environment contract
  and configure the intended Vercel scope through an authorized channel; a
  redeploy is required for deployment-time variables.
- **Edge bundle growth:** keep heavy dependencies out of proxy and middleware
  entry points.
- **Cron not scheduled:** `app/api/cron/` contains handlers; `vercel.json` is
  the only Vercel schedule authority.
- **Smoke failure:** let the gate's rollback path finish and prove the serving
  SHA before taking another action. Follow `docs/RUNBOOK.md` if rollback is
  unavailable or unproved.
