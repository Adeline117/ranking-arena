# Arena Anti-Block Diagnostics

Diagnose exchange API blocking without creating an unowned proxy or bypassing
the source registry.

## Ownership boundary

- Confirm the source and surface in `arena.sources` before changing transport.
- Treat `arena.sources.fetch_region` as the authority for execution placement.
- Keep HTTP acquisition behind the `FetchSession` boundary under
  `lib/ingest/fetch/` and the canonical RAW/capture boundary so rate budgets,
  deadlines, retries, and evidence remain enforceable.
- Use only repository-owned worker, VPS, or browser transports with a documented
  health check and rollback path.
- Do not add an ad hoc proxy, public endpoint, or automatic fallback chain.
- Change registry placement only through a reviewed forward migration; never use
  dashboard edits or ad hoc production SQL.

## Diagnostic sequence

1. Reproduce the failure through the registered adapter, not a one-off request.
2. Classify the response: authentication, rate limit, WAF/challenge, geo block,
   upstream outage, or payload/schema drift.
3. Inspect the source's configured region and the worker evidence for that run.
4. If placement is wrong, update the reviewed registry/region contract and prove
   the adapter in that environment. If a browser is required, keep it within the
   owned browser transport and preserve the same evidence contract.
5. Validate rate limiting, timeout behavior, retry bounds, and publication gates
   before declaring the source healthy.

## Completion evidence

- The canonical adapter succeeds in its selected region.
- RAW evidence and structured failure logs are present.
- Retry and rate budgets remain bounded.
- No temporary proxy, credential, or undocumented production endpoint was added.
- `docs/ADAPTER_ONBOARDING.md` and the source registry agree with the runtime.

Use `data-quality` for publication and evidence diagnostics. Follow
`docs/SCRAPER.md` for canonical transport ownership and
`docs/ADAPTER_ONBOARDING.md` for adapter acceptance.
