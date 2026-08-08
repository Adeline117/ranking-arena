# Repository Structure and Boundaries

Status: **Canonical**

Owner: Engineering

Last reviewed: 2026-08-04

This document defines deployable units, dependency direction, and the target
layout. Runtime topology remains defined by [ARCHITECTURE.md](./ARCHITECTURE.md),
while durable design decisions belong in [DECISIONS.md](./DECISIONS.md).

## Deployable units

| Unit            | Paths                           | Responsibility                                          |
| --------------- | ------------------------------- | ------------------------------------------------------- |
| Web application | `app/`, `lib/`, `public/`       | Next.js UI, HTTP APIs, and scheduled request handlers   |
| Ingest worker   | `worker/`, `lib/ingest/`        | Queue ownership, collection, validation, and publishing |
| Database        | `supabase/`                     | Immutable migration ledger, RLS, functions, and views   |
| Smart contracts | `contracts/`, `script/`         | Foundry contracts and deployment scripts                |
| Native shells   | `ios/`, `android/`, `appstore/` | Capacitor packaging and store metadata                  |
| Operations      | `infra/`, `scripts/`            | Host configuration and operator tooling                 |

Each deployable unit must have a documented entry point, owning workflow, health
check, and rollback path. A new top-level deployable requires an ADR.

`cloudflare-worker/` is a quarantined compatibility artifact, not a current
deployable. It remains only until an authorized external-traffic audit proves
that it can be deleted; its README defines the reactivation gate.

## Dependency direction

```text
app UI ────────┐
               ├──> lib domain modules ──> lib platform modules
app/api ───────┘                                  │
worker ─────────────> lib/ingest ─────────────────┘
supabase migrations ── schema contract ──────────┘
```

Rules:

1. UI modules do not import API route implementations or worker code. Shared
   request/response contracts live in `lib/<domain>/contracts.ts`.
2. `lib/` does not import from `app/` or `worker/`; dependencies point toward
   domain and platform primitives, never toward deployable entry points.
3. `worker/` may import `lib/`, but must not import `app/`.
4. Framework root entry points (`proxy.ts`, `instrumentation.ts`, and Sentry
   configs) may import lower-level modules; product modules do not import those
   entry points.
5. Product/runtime modules do not import operator scripts.
6. The legacy `connectors/` and `workers/` roots are retired and must not be
   reintroduced. Source adapters belong in `lib/ingest/`; shared runtime logic
   belongs in `lib/`; long-running orchestration belongs in `worker/`.
7. Applied files under `supabase/migrations/` are immutable. Bootstrap
   consolidation is a separate baseline artifact, not a rewrite of production
   history.

Run `npm run qa:architecture` to enforce these rules. Existing inversions are
recorded in `scripts/qa/architecture-boundary-baseline.json`; the gate fails on
both new violations and stale entries. CI compares the target branch and rejects
new baseline waivers, so the debt ledger may only shrink.

## Canonical top-level layout

```text
app/                    Next.js routes, layouts, UI, and HTTP boundaries
lib/                    Shared domain and platform modules
worker/                 Long-running ingest process
supabase/               Database migrations and configuration
cloudflare-worker/      Quarantined proxy artifact pending external audit
contracts/ script/       Foundry project (no tracked first-party Forge tests yet)
ios/ android/ appstore/ Native application shells
infra/                  Declarative host/process infrastructure
scripts/                CI, diagnostics, maintenance, and operator commands
specs/                  Reviewed implementation specifications and templates
e2e/ k6/                End-to-end and load tests
__tests__/              Framework root-entrypoint contracts and test-only mocks
docs/                   Current guidance, operational knowledge, and history
.github/                Ownership, review policy, and CI/CD workflows
.githooks/              Repository-managed local hook entry points
.claude/ .cursor/        Repository-local agent instructions and editor policy
.vscode/                 Shared editor settings
vendor/                  Audited upstream source retained behind explicit boundaries
```

The machine-readable inventory in
`scripts/qa/repository-root-allowlist.json` is the authority for these directories
and for framework-required root files. `npm run qa:root-layout` reads only the Git
index, rejects unknown or stale entries, non-regular root entries, conflict stages,
and portable-name collisions, and deliberately ignores ignored or untracked local
state. Adding a top-level directory therefore requires the ADR, documentation, and
allowlist changes in the same review.

Generated outputs, screenshots, logs, browser profiles, environment files
containing local or real values, and local state must stay untracked. Sanitized
templates such as `.env.example` and `.env.template` remain tracked and must
contain no credentials.

The root `.gitattributes` file is authoritative for Git checkout and index
normalization: repository text and Unix tooling use LF, native Windows batch
launchers use CRLF in the working tree, and reviewed binary formats disable text
conversion and automatic merge. `.editorconfig` mirrors editor behavior but does
not replace the Git-level contract. Run `npm run qa:git-attributes` after changing
either policy or introducing a new binary format. The local command validates the
staged index—the same committed state CI receives—so stage new files before running
it. Nested `.gitattributes` files and repository-local attribute overrides are
rejected to keep that result deterministic.

## Internal conventions

- Organize `lib/` by business capability first. New generic buckets such as
  `helpers`, `common`, `services2`, or `utils2` are not accepted.
- Put validation schemas beside the boundary they protect.
- Keep API route files thin: authenticate, validate, call a domain module, and
  serialize the response.
- Keep tests colocated with their owning module. Root-entrypoint contract tests
  live in `__tests__/`; other cross-deployable contracts live at the lower shared
  boundary rather than importing an entry point.
- Stable operator commands are exposed through `package.json`; one-off probes use
  an ignored scratch directory.

## Migration sequence

Structural changes are delivered in independently releasable slices:

1. **Guardrails:** executable dependency rules and an explicit debt baseline.
2. **Contract extraction:** move UI/API shared types into domain contracts.
3. **Reverse-dependency removal:** eliminate each `lib -> app` and
   `lib -> worker` baseline entry with focused tests.
4. **Legacy-root retirement (complete):** the remaining consumers moved to
   canonical shared and ingest boundaries, and `connectors/` and `workers/`
   were deleted. The retirement contract prevents those roots from returning.
5. **Deployable isolation:** evaluate npm workspaces only when independent build
   contexts or dependency graphs provide measurable value.

Do not combine directory moves with unrelated behavior or database migrations.
