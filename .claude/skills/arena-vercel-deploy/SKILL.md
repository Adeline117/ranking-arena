# Arena Vercel Release Review

This skill prepares and verifies deployment evidence. It does not authorize a push
to `main`, preview/production deployment, promotion, rollback, cancellation, cache
purge, environment mutation, or secret access.

## Preferred release path

1. Verify a clean branch and exact commit SHA.
2. Run focused tests, both typechecks when ingest is touched, lint, publication QA,
   and a clean build in proportion to risk.
3. Push the reviewed feature branch and use a draft PR.
4. When a preview is explicitly authorized, prefer the GitHub/Vercel preview tied to
   that exact SHA. A manual preview uses `vercel deploy --yes` only after confirming
   the authenticated project/team.
5. Keep `--prod`, promotion, rollback, and production environment changes behind a
   separate explicit approval.

## Cron and schedule verification

- Treat `vercel.json` as the checked-in schedule candidate and verify path uniqueness,
  handler existence, authentication, timeout/lock behavior, and schedule tests.
- Test cron handlers locally with mocked authentication and dependencies.
- Do not `curl` a production cron route. An unauthenticated 401 is not execution proof,
  and an authenticated call may mutate data or trigger external work.
- After an authorized release, use approved read-only deployment/log evidence and the
  exact release identity; never expose the cron secret.

## Environment and migration gates

Never create/touch environment files to make a build pass, pull production secrets,
or print token values. A migration in the branch remains unapplied until its isolated
proof, live catalog/ledger witness, owner approval, and controlled runner are all
available.

## Handoff

Report commit, preview identity (if one was authorized), commands and results,
remaining gates, migration status, and any production-only verification still
required. Do not describe a local or unauthenticated probe as a successful release.
