# Historical On-chain Enrichment Deployment Note — V1 NO-GO

## Status

This file is retained only to record that its former deployment recipe is obsolete. It is
not an operating procedure or a recovery path.

The checked-in `scripts/enrich-onchain-all.mjs` runtime is no longer present in this
repository. `scripts/monitor-enrichment.sh` is now a retired V1 NO-GO compatibility
path, not a status monitor: it writes its fixed `[RETIRED]` notice to stderr, leaves
stdout empty, and exits `2`. The historical archive probe
`scripts/archive/test-onchain-apis.mjs` is also retired and must not be used as a
substitute.

The old instructions for copying files, connecting to a machine, configuring runtime
state, scheduling execution, observing logs, troubleshooting, rollback, and removal
have intentionally been removed. Do not reconstruct those instructions from this
document or use it to infer current ownership, topology, coverage, or health.

## Scope

This is a source-only documentation boundary. It does not change, stop, inspect, or
prove the state of any application on-chain API, worker, adapter, deployed host,
scheduler, credential, database, provider, or historical data. Any approved operational
work must use its separately maintained ownership and change process.
