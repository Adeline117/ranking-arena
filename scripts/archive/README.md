# scripts/archive — 已归档的一次性脚本

这里存放已完成使命的一次性 backfill / fix / check / diagnose 脚本。
归档标准：package.json、CLAUDE.md、README、git hooks、workflows、openclaw、
crontab 中均无引用。它们保留在 git 历史里可随时找回，归档只为让 scripts/
根目录保持"在用工具"的信噪比。

新的一次性脚本用完后请直接移入本目录（git mv），不要堆在 scripts/ 根目录。

## V1 retired compatibility path

`scripts/archive/test-enrich-fix.sh` is retired during V1 NO-GO. It writes `[RETIRED]`
only to stderr and exits `2`; do not treat it as a recoverable work route. This limited
status covers that file only.

`scripts/archive/check-stuck-simple.mjs` is separately retired during V1 NO-GO. It writes
`[RETIRED] scripts/archive/check-stuck-simple.mjs` only to stderr, leaves stdout empty, and
exits `2`; it is not a `pipeline_logs` diagnostic or recovery route.

`scripts/archive/check-failed-jobs.mjs`, `scripts/archive/check-failed-tasks.mjs`,
`scripts/archive/check-latest-errors.mjs`, and `scripts/archive/check-rankings.mjs` are
separately retired service-role archive diagnostics. Each writes its matching fixed
`[RETIRED]` notice only to stderr, leaves stdout empty, and exits `2`; this limited status
covers only those four files.

`scripts/archive/check-homepage-regression.mjs` is separately retired during V1 NO-GO. It
writes `[RETIRED] scripts/archive/check-homepage-regression.mjs` only to stderr, leaves
stdout empty, and exits `2`; this limited status covers that file only.
