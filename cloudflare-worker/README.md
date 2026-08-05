# Cloudflare Proxy Compatibility Artifact

**Status:** Quarantined pending external-traffic audit
**Last verified:** 2026-08-04

`src/index.ts` and `wrangler.toml` preserve the historical allowlisted exchange
proxy implementation. The application and ingest worker have no current caller
for this proxy, and this repository has no workflow that owns its deployment,
health check, or rollback. It is therefore not an authorized automatic fallback
or production deployable.

Current first-party collection uses the registry-selected worker region and its
reviewed VPS/browser transport. Before deleting this artifact, verify Cloudflare
traffic and route configuration through an authorized read-only account audit.
Reactivation requires an ADR, an owning workflow, secret contract, health check,
rollback procedure, and a proven repository consumer.

Historical audit locator only (current state unverified):
`https://ranking-arena-proxy.broosbook.workers.dev`. This is discovery evidence
for the external audit, not a runtime endpoint or deployment authorization.

The only package command is `npm run dev`. It starts Wrangler's local emulator
on loopback; the package deliberately exposes no production publish or log-tail
command. Local inspection does not grant deployment authority.
