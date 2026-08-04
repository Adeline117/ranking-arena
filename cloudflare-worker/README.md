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

Local development commands in `package.json` are for inspection only and do not
grant production deployment authority.
