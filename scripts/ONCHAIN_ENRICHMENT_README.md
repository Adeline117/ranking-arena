# Historical On-chain Enrichment Notes — V1 NO-GO

## Status

This document preserves the boundary around a retired historical enrichment design. Its
former platform list, coverage figures, data-source descriptions, progress table, and
runbook were planning material from 2026-03-11; none is a current production contract,
coverage report, or runtime instruction.

`scripts/enrich-onchain-all.mjs` is not present in this repository. The checked-in
`scripts/monitor-enrichment.sh` path is a retired V1 NO-GO compatibility path rather
than an executable status monitor: it writes its fixed `[RETIRED]` notice to stderr,
leaves stdout empty, and exits `2`. The historical archive probe
`scripts/archive/test-onchain-apis.mjs` is likewise retired and must not be used as an
alternative probe.

The previous file-transfer, remote-access, execution, schedule, log-inspection,
troubleshooting, and cleanup recipes have intentionally been removed. This document
cannot be used to restore those workflows or to determine whether any historical work
ever ran.

## Scope

This source-only documentation boundary does not alter, stop, inspect, or prove any
application on-chain API, worker, adapter, deployed host, scheduler, credential,
database, provider, historical data, or product behavior. It also does not change the
existing `app/api/trader/onchain-enrich` hold or establish any external state.
