# Documentation Policy

**Owner:** Repository CODEOWNERS
**Last verified:** 2026-08-04

Documentation is part of the production contract. A change is incomplete when
its supported command, ownership boundary, failure mode, or rollback path is
different from the checked-in documentation.

## Document classes

- **Operational and evergreen:** onboarding, architecture, repository structure,
  SLOs, deployment, release, and runbooks. These documents must be discoverable
  from `docs/README.md` and updated in the same pull request as the behavior.
- **Architecture decisions:** append decisions to `docs/DECISIONS.md`. Preserve
  historical context; mark an old ADR `Superseded` and link the replacing ADR
  instead of silently rewriting history.
- **Point-in-time plans and audits:** new or materially updated documents include
  a date and an explicit status. They are evidence, not current operating
  instructions. Move completed material to an archive only when no active
  document links to it.

## Authoring contract

1. Reference only tracked paths and commands that work from the repository root.
2. Name one authoritative owner for each deployable, scheduler, queue, data
   writer, and recovery path. Do not document two paths as production owners.
3. Describe degraded behavior conservatively. A cache or retry is not a recovery
   guarantee, and load-bearing coordination must never be called fail-open.
4. Use placeholders for credentials and tokens. Do not copy secret values,
   credential-bearing URLs, logs, or local environment files into documentation.
5. State prerequisites and rollback evidence before destructive, production,
   database, queue, or keyspace operations. Prefer fail-closed instructions.
6. Update the document's verification date when its commands and runtime claims
   are materially revalidated.

## Review and automation

- CODEOWNERS defines the minimum reviewer for high-risk documentation.
- `scripts/qa/repository-governance-contract.test.mjs` verifies that the index
  links and concrete CODEOWNERS paths still resolve and that retired runbook
  guidance does not return.
- Automation proves path integrity only. Reviewers remain responsible for the
  operational meaning and safety of each instruction.
