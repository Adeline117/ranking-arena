# Staging & Preview — V1 NO-GO

> This page is an incident boundary, not a deployment guide. During V1, no agent
> may create, deploy, promote, roll back, inspect, or alter a Vercel Preview,
> Production project, environment variable, deployment alias, cron, queue, or
> provider integration. A local branch, build, or Draft PR is not a staging target
> and does not establish any deployed state.

The checked-in V1 configuration disables Git-triggered Vercel deployments and
declares no Vercel schedules. Those source controls do not prove or change a
provider control plane, an already-deployed schedule, a Preview environment, or a
running host. Only a separately approved owner evidence record can establish such
external state.

## Allowed work

- Use an isolated local worktree and branch.
- Review source, committed fixtures, and local non-mutating tests.
- Prepare a Draft PR only when the current task explicitly authorizes publishing.
- Record a missing staging witness or failed local check as a release gate.

## Prohibited work

- Vercel dashboard, CLI, API, deploy hook, preview URL, promotion, rollback, or
  alias action.
- Reading, adding, changing, or testing any hosted environment value.
- Invoking a cron endpoint, restoring a schedule, or treating a source diff as a
  control-plane change.
- Using a production or unknown-disposability database, Stripe, R2, Redis, queue,
  or third-party key for a preview or test.

## Conditions for a future staging proposal

An owner-approved release plan must first name an isolated disposable project and
database, test-mode payment and storage resources, staging-only credentials, no
production queue or scheduler reachability, an exact candidate SHA, protected
review/source boundaries, a bounded rollback target, and an evidence-retention
plan. That future plan must be reviewed independently; this document contains no
commands or provider-console procedure for creating it.

For the launch gate and current owner escalation path, see
[V1_EXECUTION_STATUS_2026-08-03.md](./V1_EXECUTION_STATUS_2026-08-03.md) and
[RUNBOOK.md](./RUNBOOK.md).
