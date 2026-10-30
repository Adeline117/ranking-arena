# Arena Source Transport and Block Handling

Use the repository's approved ingest transport and routing controls when an exchange
endpoint is unavailable. This guide does not authorize bypassing access controls,
inventing proxy infrastructure, changing source routing in production, or adding an
unreviewed browser/stealth dependency.

## Start from the current source contract

Before changing transport behavior, read:

- the exact adapter in `lib/ingest/adapters/<source>/`;
- `lib/ingest/fetch/` (`fetcher.ts`, `capture.ts`, circuit/rate-limit code, and tests);
- `lib/ingest/core/types.ts`;
- the worker routing and consumed-region checks in `worker/src/ingest/`;
- the versioned source row/migration and redacted capture fixture for that adapter.

`fetch_region` selects the worker region. Browser selection, when a source already
supports it, is an explicit `sources.meta.browser_channel` input consumed by the
shared fetcher. Adapters such as `bybit-mt5` and `bybit-copytrade` already use the
shared `pageFetcher`; do not replace that boundary with a standalone Puppeteer
script or hard-coded exchange URL.

## Diagnose before changing anything

Classify the observed response using a timestamped, redacted capture:

- HTTP status and content type;
- rate-limit/retry metadata;
- whether the worker ran in the source's declared `fetch_region`;
- whether the adapter used its declared capture/replay lane;
- whether the response matches the checked-in parser fixture.

An old platform matrix, a laptop result, or a generic statement such as “must use a
browser” is not current proof. Never hard-code a local Chrome version or assume a
machine-specific executable exists.

## Safe implementation boundary

- Prefer a fixture/parser correction when the transport response is valid but the
  adapter is wrong.
- Reuse the existing rate limiter, circuit breaker, capture/replay, and `pageFetcher`
  abstractions.
- Keep retries bounded and preserve an explicit failed job result when exhausted.
- Add redacted or synthetic deterministic fixtures; never commit cookies, tokens,
  wallet secrets, or raw private captures.
- Verify the adapter and worker tests, both typechecks, lint, and a no-write dry run.

A routing, proxy, browser-channel, worker, schedule, or production source-row change
is a separate reviewed infrastructure action. Report it as a missing gate rather
than applying it from this skill.
