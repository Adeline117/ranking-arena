# 历史新交易所导入说明 — V1 NO-GO

本文件保留旧 `scripts/import/` 内容的设计背景，**不是**导入、数据库检查、调试、
cron 或部署操作手册。V1 期间不得依据历史脚本名称、交易所覆盖表、旧 endpoint 或既有
数据量推断任何运行状态，也不得把它们作为实际写入的入口。

## 已封存的历史入口

本次 source-only containment 仅封存以下 legacy acquisition entrypoint：

- `scripts/import/import_all_platforms.mjs`
- `scripts/import/refresh.sh`
- `scripts/import/import-all-blocked.sh`
- `scripts/import/run_hl_enrichment.sh`
- `scripts/vps-deploy/scraper-v16-parallel.js`
- `scripts/vps-deploy/arena-proxy.mjs`
- `scripts/archive/test-vps-scrapers.ts`
- `scripts/archive/verify-data-accuracy.mjs`

这些脚本固定报告 `RETIRED` 并以 `2` 退出，在 proxy、browser、import 或 host 工作前结束。
相邻的 checked-in Cloudflare Worker 也固定返回 `410
LEGACY_PROXY_IMPORT_NOT_PUBLISHED` 与三层 `no-store`，不作 upstream fetch；独立的
`GET /api/proxy/phemex` 先鉴权，随后固定 `410
LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`。

独立的 canonical `GET /api/cron/backfill-avatars` 及其
`/api/v1/cron/backfill-avatars` rewrite alias 解析到同一 tombstone handler：先校验 service
authentication，缺失或无效认证返回 `401`；有效认证返回 `410
CRON_EXECUTION_NOT_PUBLISHED`。两条路径均有三层 `no-store`，并在参数解析、数据库、logging 或
upstream fetch 前结束；它不是 backfill 操作说明。

## 边界与真相

上述只是源码封存，不能停止、检查或证明已经部署的 VPS scraper/proxy、Cloudflare Worker、
host process、queue、external scheduler 或 healthcheck。它不表示所有 `scripts/import/**`、
adapter、helper 或写路径都已关闭。avatar helper、worker `avatar-mirror`、adapter、未列 writer
与 `GET /api/avatar` 均不在 avatar-backfill handler 或本文列出的 import/proxy 入口的结论中。
任何未列入口都必须由 owner 在独立、范围明确的审查中决定，不能从本文件推导出执行权限。

## 历史设计记录

旧说明曾讨论 OKX、Bitfinex、Crypto.com、Pionex 等来源的候选采集与旧表字段。它们只说明
过去的代码意图，不证明数据完整性、采集授权、数据库 ACL、部署状态或可发布性。若未来要
恢复任何来源，owner 必须另行批准一个包含来源证据、RAW/provenance、写目标、测试、回滚和
运行边界的计划；该计划不得复用本文件中的旧操作流程。
