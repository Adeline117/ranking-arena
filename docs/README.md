# Documentation Index

## Start Here

| Document                         | Description                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| [ONBOARDING.md](./ONBOARDING.md) | New teammate? Start here. Setup, reading order, first task. |

## Core

| Document                                 | Description                                          |
| ---------------------------------------- | ---------------------------------------------------- |
| [../CLAUDE.md](../CLAUDE.md)             | Project constitution and dev guidelines (start here) |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | System architecture diagrams and data flow           |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Code style, commit format, PR process                |
| [GIT_WORKFLOW.md](./GIT_WORKFLOW.md)     | Branch strategy and team collaboration workflow      |
| [DECISIONS.md](./DECISIONS.md)           | Architecture Decision Records (ADRs)                 |

## API & Data

| Document                                                                                             | Description                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [ARENA_REBUILD_SPEC.md](./ARENA_REBUILD_SPEC.md)                                                     | Homepage/trader-detail field superset and screenshot limitations |
| [EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md)                                             | CEX/Wallet field semantics, method, and provenance authority     |
| [TOKEN_RANKING_DATA_AUTHORITY_PLAN_2026-07-29.md](./TOKEN_RANKING_DATA_AUTHORITY_PLAN_2026-07-29.md) | Token rank eligibility, coverage, and fail-closed plan           |
| [DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md](./DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md)         | DEX event-ledger execution authority and phase gates             |
| [DEX_OPEN_SOURCE_EVALUATION_2026-07-29.md](./DEX_OPEN_SOURCE_EVALUATION_2026-07-29.md)               | Ponder/SQD/node evaluation; no production authorization          |
| [API_ROUTES.md](./API_ROUTES.md)                                                                     | API endpoint reference (may lag behind code)                     |
| [API_BEST_PRACTICES.md](./API_BEST_PRACTICES.md)                                                     | Error handling, response format, auth patterns                   |

## Exchange API Docs

| Document                                                             | Description        |
| -------------------------------------------------------------------- | ------------------ |
| [exchange-apis/bitget-futures.md](./exchange-apis/bitget-futures.md) | Bitget Futures API |
| [exchange-apis/bybit.md](./exchange-apis/bybit.md)                   | Bybit API          |
| [exchange-apis/bybit_spot.md](./exchange-apis/bybit_spot.md)         | Bybit Spot API     |
| [exchange-apis/gateio.md](./exchange-apis/gateio.md)                 | Gate.io API        |
| [exchange-apis/htx-futures.md](./exchange-apis/htx-futures.md)       | HTX Futures API    |

## Scraper & Pipeline

| Document                   | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| [SCRAPER.md](./SCRAPER.md) | Scraper architecture, VPS operations, troubleshooting |

## Security & Database

| Document                                                   | Description                 |
| ---------------------------------------------------------- | --------------------------- |
| [RLS_POLICIES.md](./RLS_POLICIES.md)                       | Row Level Security policies |
| [SECURITY_BEST_PRACTICES.md](./SECURITY_BEST_PRACTICES.md) | Security guidelines         |

## Operations

| Document                         | Description                       |
| -------------------------------- | --------------------------------- |
| [RUNBOOK.md](./RUNBOOK.md)       | Emergency operations manual       |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deployment checklist and rollback |
| [STAGING.md](./STAGING.md)       | Staging/preview deployments       |
| [SLO.md](./SLO.md)               | Freshness budgets and SLOs        |

## Design & Principles

| Document                                       | Description                                           |
| ---------------------------------------------- | ----------------------------------------------------- |
| [system-principles.md](./system-principles.md) | System state management rules (auth, modals, caching) |

## QA & Testing

| Document                                               | Description                                  |
| ------------------------------------------------------ | -------------------------------------------- |
| [QA_TEST_CASES.md](./QA_TEST_CASES.md)                 | Comprehensive test cases for all features    |
| [QA_PAYMENT_FLOW_TESTS.md](./QA_PAYMENT_FLOW_TESTS.md) | Payment flow edge cases and anti-cheat tests |
