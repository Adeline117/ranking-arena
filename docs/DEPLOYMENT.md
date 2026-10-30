# Deployment status — V1 NO-GO

Production deployment, rollback, migration, cache, feature-flag, and control-plane
actions are suspended. This document is a status boundary, not an operational
checklist. A successful local build, branch push, preview, or Draft PR is not proof
that production advanced and does not authorize a release action.

The checked-in V1 source disables Git-triggered Vercel deployment and declares no
Vercel schedules. Those source controls do not prove or alter a provider dashboard,
an existing deployment, a running scheduler, or any host runtime.

## What is allowed now

- Work in an isolated branch/worktree and open a reviewable Draft PR.
- Run local, non-mutating checks appropriate to the change.
- Record read-only evidence and follow the incident/release owner process.

Do not invoke a Vercel or Supabase action, change a production feature flag, call a
production cron, promote or roll back a deployment, or start a database recovery
from this document.

## Reopening a release window

Only the designated release owner may open a window after the V1 gates in
[`RUNBOOK.md`](./RUNBOOK.md) and
[`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) are
closed. The owner must record the exact target SHA, authorized scope, required
checks, public-contract evidence, rollback witness, and responsible operators
before any control-plane action.

The previous pre-deploy, post-deploy, and rollback checklists are intentionally not
reproduced here: they describe high-impact operations that require a new,
owner-approved release plan when the NO-GO is lifted.
