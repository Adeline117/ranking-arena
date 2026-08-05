# Documentation Lifecycle Index

This is the single catalog for tracked Markdown under `docs/`. Classification
describes a document's lifecycle role, not whether every statement inside it is
still true. Current guidance wins over dated evidence; active plans still need
their stated approvals and production gates.

## Current guidance

Use these documents for supported repository behavior and day-to-day work.

### Entry points and governance

- [CLAUDE.md](../CLAUDE.md) — Repository constitution and mandatory engineering rules.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — Contribution, review, and commit workflow.
- [ONBOARDING.md](./ONBOARDING.md) — New-teammate reading order and first-task guide.
- [LOCAL_SETUP.md](./LOCAL_SETUP.md) — Supported local setup and verification path.
- [REPOSITORY_STRUCTURE.md](./REPOSITORY_STRUCTURE.md) — Deployable boundaries and target layout.
- [DOCUMENTATION_POLICY.md](./DOCUMENTATION_POLICY.md) — Documentation ownership and lifecycle contract.
- [GIT_WORKFLOW.md](./GIT_WORKFLOW.md) — Branch and collaboration workflow.
- [DECISIONS.md](./DECISIONS.md) — Canonical architecture decision record.
- [PROGRESS.md](./PROGRESS.md) — Current authority block plus historical delivery log.

### Architecture, APIs, and data contracts

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Current system topology and data flow.
- [ARENA_REBUILD_SPEC.md](./ARENA_REBUILD_SPEC.md) — Ranking and trader-detail data contract.
- [API_ROUTES.md](./API_ROUTES.md) — Canonical API ownership and boundary policy.
- [API_BEST_PRACTICES.md](./API_BEST_PRACTICES.md) — API implementation and error-handling patterns.
- [EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md) — Exchange field semantics and provenance authority.
- [EXCHANGE_FIELD_COVERAGE.md](./EXCHANGE_FIELD_COVERAGE.md) — Generated field-coverage ledger; regenerate rather than hand-edit.
- [UNREACHABLE_FIELDS_LEDGER.md](./UNREACHABLE_FIELDS_LEDGER.md) — Current contract for unavailable upstream fields.
- [CHAT_CONSOLIDATION_PLAN_2026-07-15.md](./CHAT_CONSOLIDATION_PLAN_2026-07-15.md) — Implemented inbox routing and deliberately separate message transports.

### Acquisition and ingest

- [ADAPTER_ONBOARDING.md](./ADAPTER_ONBOARDING.md) — Source admission, fixtures, and quality gates.
- [SCRAPER.md](./SCRAPER.md) — Canonical acquisition transport and troubleshooting guide.
- [INGEST_WORKER_DEPLOY.md](./INGEST_WORKER_DEPLOY.md) — Transactional worker deployment and recovery runbook.
- [INGEST_WORKER_TOPOLOGY.md](./INGEST_WORKER_TOPOLOGY.md) — Worker ownership, regions, and runtime topology.
- [exchange-apis/bitget-futures.md](./exchange-apis/bitget-futures.md) — Bitget Futures API reference.
- [exchange-apis/bybit.md](./exchange-apis/bybit.md) — Bybit Futures API reference.
- [exchange-apis/bybit_spot.md](./exchange-apis/bybit_spot.md) — Bybit Spot API reference.
- [exchange-apis/gateio.md](./exchange-apis/gateio.md) — Gate.io API reference and remaining access requirement.
- [exchange-apis/htx-futures.md](./exchange-apis/htx-futures.md) — HTX Futures API reference.

### Operations, security, and controls

- [RUNBOOK.md](./RUNBOOK.md) — Emergency operations and recovery procedures.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Application deployment and rollback checklist.
- [RELEASE.md](./RELEASE.md) — Versioning, release, and branch-protection policy.
- [STAGING.md](./STAGING.md) — Staging and preview environment model.
- [SLO.md](./SLO.md) — Reliability, freshness, and recovery objectives.
- [STRIPE_GO_LIVE.md](./STRIPE_GO_LIVE.md) — Payment go-live gates and rollback procedure.
- [COPY_TRADING_QUARANTINE.md](./COPY_TRADING_QUARANTINE.md) — Current fail-closed copy-trading quarantine.
- [RLS_POLICIES.md](./RLS_POLICIES.md) — Row-level security policy and review checklist.
- [SECURITY_BEST_PRACTICES.md](./SECURITY_BEST_PRACTICES.md) — Application security guidance.
- [SOC2_CONTROL_MAPPING.md](./SOC2_CONTROL_MAPPING.md) — Control ownership, evidence, and open gaps.

### Design and quality

- [DESIGN.md](./DESIGN.md) — Current design system.
- [system-principles.md](./system-principles.md) — UI state-management principles.
- [LINTING_GUIDE.md](./LINTING_GUIDE.md) — Lint ownership and remediation workflow.
- [QA_TEST_CASES.md](./QA_TEST_CASES.md) — Maintained end-to-end QA catalog.

### Templates

- [postmortems/\_template.md](./postmortems/_template.md) — Required incident-review structure.

## Active plans and decision queues

These documents contain unfinished work, an explicit owner decision, or a gate
that still needs external evidence. They are planning inputs, not authorization
to deploy, migrate, spend, or change production state.

### Data and infrastructure

- [DATA_COMPLETENESS_PLAN_2026-07-08.md](./DATA_COMPLETENESS_PLAN_2026-07-08.md) — Mostly executed; worker-side Bitget CFD live probe remains.
- [DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md](./DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md) — Shadow-only DEX event-indexing execution plan.
- [DEX_OPEN_SOURCE_EVALUATION_2026-07-29.md](./DEX_OPEN_SOURCE_EVALUATION_2026-07-29.md) — PoC decision draft with no production authorization.
- [TOKEN_RANKING_DATA_AUTHORITY_PLAN_2026-07-29.md](./TOKEN_RANKING_DATA_AUTHORITY_PLAN_2026-07-29.md) — Unpublished Token ranking authority plan and phase gates.
- [PHASE2_INFRA_PLAN.md](./PHASE2_INFRA_PLAN.md) — External-account, budget, staging, and observability decisions.

### Product, launch, and QA

- [TASKS.md](./TASKS.md) — Mixed task queue with open items; completed dated sections are historical context.
- [CLAIM_WALKTHROUGH_OWNER.md](./CLAIM_WALKTHROUGH_OWNER.md) — Owner-led production claim verification still requires a real walkthrough.
- [FULL_LAUNCH_AUDIT_2026-07-18.md](./FULL_LAUNCH_AUDIT_2026-07-18.md) — Launch evidence with unresolved P0 and owner gates.
- [LAUNCH_AUDIT_2026-07-11.md](./LAUNCH_AUDIT_2026-07-11.md) — Earlier launch audit with owner and dashboard actions.
- [LAUNCH_OPTIMIZATION_OWNER_DECISIONS_2026-07-09.md](./LAUNCH_OPTIMIZATION_OWNER_DECISIONS_2026-07-09.md) — Budget, product, and capacity decisions reserved for the owner.
- [QA_BUTTON_AUDIT_2026-06.md](./QA_BUTTON_AUDIT_2026-06.md) — Completed audit evidence with remaining product and fixture decisions.
- [QA_HARDENING_PLAN_2026-07.md](./QA_HARDENING_PLAN_2026-07.md) — One authenticated group-flow canary and owner choices remain.
- [UIUX_OVERHAUL_2026-07.md](./UIUX_OVERHAUL_2026-07.md) — Owner-gated UI/UX execution queue.
- [VOTE_REACTION_BUGS_2026-07-08.md](./VOTE_REACTION_BUGS_2026-07-08.md) — Documented interaction defects; fixes are explicitly not started.

## Historical evidence

These records preserve point-in-time facts, audits, incidents, and superseded
designs. Do not execute their commands or treat unchecked boxes as the current
backlog without revalidation against current guidance and an owner.

### Completed and superseded engineering records

- [COLUMN_DRIFT_FINDINGS_2026-07.md](./COLUMN_DRIFT_FINDINGS_2026-07.md) — Completed column-drift remediation evidence.
- [ENTERPRISE_GAP_ANALYSIS_2026-07.md](./ENTERPRISE_GAP_ANALYSIS_2026-07.md) — Point-in-time enterprise maturity baseline.
- [MIGRATION_DRIFT_AUDIT_2026-07-02.md](./MIGRATION_DRIFT_AUDIT_2026-07-02.md) — Completed migration reconciliation record.
- [P1_CAPTURE_GAPS.md](./P1_CAPTURE_GAPS.md) — Completed capture-gap investigation and production observations.
- [PROGRESS-ARCHIVE.md](./PROGRESS-ARCHIVE.md) — Archived delivery history.
- [hyperliquid-spike.md](./hyperliquid-spike.md) — Point-in-time build-versus-buy evidence; applied settings and open issues require revalidation.
- [FEATURE_STATUS_2026-07.md](./FEATURE_STATUS_2026-07.md) — Completed drift ledger; the competitions surface described there has since been deleted.
- [QA_FULL_UIUX_AUDIT_2026-06-13.md](./QA_FULL_UIUX_AUDIT_2026-06-13.md) — Point-in-time full-flow QA audit.
- [QA_PAYMENT_FLOW_TESTS.md](./QA_PAYMENT_FLOW_TESTS.md) — Historical payment-flow cases tied to earlier price points; not current pricing authority.
- [SERIES_BACKFILL_CURSOR_FIX_PLAN.md](./SERIES_BACKFILL_CURSOR_FIX_PLAN.md) — Verified cursor incident diagnosis and fix record.
- [UIUX_AUDIT_2026-06-29.md](./UIUX_AUDIT_2026-06-29.md) — Closed audit baseline superseded by the owner-gated overhaul.
- [UIUX_PERPAGE_AUDIT_2026-06-30.md](./UIUX_PERPAGE_AUDIT_2026-06-30.md) — Completed per-page audit baseline.
- [USER_TRUTH_2026-07.md](./USER_TRUTH_2026-07.md) — Point-in-time production usage report; its counts are not current metrics.
- [archive/ARCHITECTURE-legacy-2026-03.md](./archive/ARCHITECTURE-legacy-2026-03.md) — Explicitly superseded pre-ingest-worker architecture.

### Incident records

- [postmortems/PM-20260422-unverified-deploys.md](./postmortems/PM-20260422-unverified-deploys.md) — Unverified-deployment incident and controls.
- [postmortems/PM-202606-edbhandlerexited.md](./postmortems/PM-202606-edbhandlerexited.md) — Ingest worker crash incident and controls.
- [postmortems/PM-202606-migration-drift.md](./postmortems/PM-202606-migration-drift.md) — Migration-drift incident; re-triage its open historical action before use.
- [postmortems/PM-20260702-backup-silent-failure.md](./postmortems/PM-20260702-backup-silent-failure.md) — Backup failure incident; restore-drill follow-up needs current owner evidence.
- [postmortems/PM-20260703-backup-missing-arena-schema.md](./postmortems/PM-20260703-backup-missing-arena-schema.md) — Incomplete-schema backup incident and controls.

### Retrospectives and reviews

- [retros/retro-2026-04-09.md](./retros/retro-2026-04-09.md) — Historical retrospective; unchecked actions require re-triage.
- [retros/retro-2026-05-18.md](./retros/retro-2026-05-18.md) — Historical retrospective; unchecked actions require re-triage.
- [retros/retro-2026-05-19.md](./retros/retro-2026-05-19.md) — Historical retrospective; unchecked actions require re-triage.
- [retros/retro-2026-06-02.md](./retros/retro-2026-06-02.md) — Historical retrospective; unchecked actions require re-triage.
- [reviews/scope-audit-2026-04-09.md](./reviews/scope-audit-2026-04-09.md) — Point-in-time route-scope proposal; revalidate before deletion.
- [reviews/trader-header-audit-2026-04-09.md](./reviews/trader-header-audit-2026-04-09.md) — Point-in-time component refactor proposal.
