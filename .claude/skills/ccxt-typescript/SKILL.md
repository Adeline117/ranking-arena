---
name: ccxt-typescript
description: Reviews or changes Arena CCXT market-data usage without conflating it with leaderboard adapters.
---

# CCXT in Arena

CCXT is a market-data dependency, not the copy-trading/leaderboard ingest contract.
Leaderboard sources use worker adapters under lib/ingest/adapters.

## Discover current consumers

Start with rg. Current consumers include the controlled read transport in
lib/exchange/ccxt-read-transport.ts, first-party sync processors, market-candle
routes, and arbitrage utilities. There is no single connector-class entrypoint.

## Loading and request rules

- Follow the existing consumer's loading boundary; do not copy a top-level import
  example into a serverless route without checking bundle/cold-start impact.
- Use CCXT's rate limiting plus the repository's bounded concurrency/timeout policy.
- Classify network, exchange, rate-limit, and malformed-response failures separately.
- Preserve exchange/symbol/timeframe identity and upstream observation time.
- Never log API credentials, private account payloads, or secret-bearing proxy URLs.

## Scope boundary

- Do not use CCXT to invent copy-trader rankings or metrics.
- Do not add a guessed proxy variable or deploy proxy/VPS infrastructure.
- Do not call private trading methods from public market-data paths.
- A source adapter change follows docs/ADAPTER_ONBOARDING.md, not this skill.

## Verification

Use mocked exchange clients or deterministic fixtures, then run focused tests,
typecheck, lint, and the affected API/worker contract tests. Live exchange calls,
credentials, network routing, and deployment require separate authorization.
