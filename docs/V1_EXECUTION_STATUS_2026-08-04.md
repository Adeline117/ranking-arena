# Arena V1 执行状态与发布停止线（2026-08-04）

## 当前结论

生产继续 **NO-GO**。Legacy token ranking 已完成独立线上止损，但这只关闭了一个
公开风险面，不代表 V1 已具备发布条件。在 Supabase 事故恢复、生产目录与迁移账本
逐项对账、完整灾备恢复认证、联合候选全量绿色、48 小时写入排空、worker canary
和 Beta 观察窗全部通过前：不写生产数据库、不执行迁移、不恢复写 worker、不恢复
备份 cron、不开放 Beta。

## 已完成的生产止损

- 生产已精确 promote containment SHA
  `5ed4718b67ad78c42fd919dfe1f6508221893916`，Vercel deployment 为
  `dpl_FYi4pbcTKEhSHASSsyPoG7HBYrUD`；rollback source 保留在
  `de5524bd4feadcaa05bb38e3e731531c7afac598`。
- 四个 token API 固定返回 HTTP 503、`TOKEN_RANKING_NOT_PUBLISHED` 与
  `private, no-store`；两个 token 页面保持 unavailable/noindex，导航和 sitemap 不再
  暴露入口。Mac mini 与第二网络的 MacBook Air 均通过 exact checker；另有 18 组
  cache probe 全部为 MISS 且行为一致。
- 当前 `/api/health` 返回 HTTP 202/degraded；数据库与 Redis 探针通过，但 freshness
  仅 `4/32 fresh`、`13 stale`、`15 critical`。这不是 GO 信号。
- 未来 GitHub Actions 与 Vercel Production 的 Telegram token/chat-id 已于 19:03Z
  更新，且 provider API 身份检查返回 200；当前 Vercel deployment 早于该更新，
  更新后也尚无真实消息投递证明，因此告警恢复仍为待验证。

## 备份与恢复证据

- 07-27、07-28、07-30、07-31、08-01、08-02、08-03 的七个 R2 对象均为
  20-byte 空 gzip。旧 backup 与 sentinel cron 已暂停。
- 最近的实质 legacy 对象是
  `db-backups/2026/07/arena-backup-20260726-schemas.sql.gz`，大小
  5,112,388,073 bytes。服务端事故保全副本位于
  `incident-hold/2026-08-04/arena-backup-20260726-schemas.sql.gz`；两者 size、ETag
  一致，源对象未删除。
- 隔离 PostgreSQL 17.8 流式恢复实际得到 345 张用户表、153 张非空估算表、338 个
  约束，以及 `arena.traders=217938`、`arena.trader_stats=552870`、
  `public.leaderboard_ranks=41760`。因此“该对象没有 leaderboard 数据”的旧判断
  已被证伪。
- 运行 880 秒后，部分数据库约 22 GB、目标盘仅余 8.2 GiB；为保护主机，在
  `COPY public.tph_2026_05` 第 14,667,733 行主动终止。索引、完整流 CRC/尾标、
  schema/RLS/auth 和应用 smoke 均未完成。部分数据库已删除，R2 source/hold 保留。
  该对象不是认证恢复点；下一次须使用至少约 100 GiB 可用空间的 managed scratch。

## 生产目录冻结与迁移边界

`2026-08-04T19:15:53.362Z` 只读冻结结果：396 个函数、197 张表、546 条 migration
ledger。完整 inventory SHA-256 为
`34e627455ce0b3ba7a663e5004526088d5b81c51fae30f6711df3a3d71eee2d0`；详细分项 hash
记录在 [联合候选决策](./V1_COMBINED_INTEGRATION_DECISIONS_2026-08-04.md)。

live contract 缺少以下五个 RPC：

- `get_popular_tokens_v2`
- `get_token_ranking_publication_head`
- `get_token_trader_rankings_v2`
- `refresh_public_rank_count_cache_for_seasons`
- `rerank_public_eligible_leaderboard`

migration QA 另有 101 个仓库文件名未出现在 live ledger。它们包含 renamed 或效果
已存在的候选，不能按数量批量补跑；必须逐项对 frozen catalogue，再在 disposable
PostgreSQL 17 验证。当前没有任何生产迁移授权。

## 联合候选

联合分支 `codex/v1-combined-20260804` 进入本报告前的 checkpoint 为
`459b0a69fdd7bdca8b63473621ceb0109abfa160`。它整合了 migration/NFT blocker、
backup hardening、V1 candidate、线上 token containment，并已包含
`brace-expansion` 5.0.9 高危修复。此前应用/worker typecheck、聚焦测试、98 项
backup/writer/migration/token 测试、两组 PG17 共 8 项和 lint 均通过；仍需在干净
Node 22 安装上完成精确依赖检查、全量 Jest、所有相关 PG17 gate 与 production-like
build。最终候选 SHA 只能在文件冻结后由 Git 记录，不能在提交内容中自引用。

## 剩余门禁（严格顺序）

1. 在干净 Node 22 + PostgreSQL 17 环境完成联合候选全量验证，推送新的统一 PR；
   旧 PR #253 仅在新 PR 建立后标记 superseded。
2. 等待 Supabase 官方事故恢复；获取受控的非 pooler backup/restore 通道，在至少
   约 100 GiB 的 managed scratch 完成全量恢复、CRC/tail、索引、RLS/auth、关键表
   及应用只读 smoke。
3. 逐项对账 5 个缺失 RPC 和 101 个 advisory migration 候选，在 disposable
   PostgreSQL 17 重放并生成精确 predeploy/postdeploy 清单；禁止对生产 `db push`。
4. 建立 exact-SHA 非生产环境并验证 schema、缓存预热、token containment、告警真实
   投递和 rollback；随后完成 48 小时无未授权写入的 drain 证据。
5. 经 owner 明确 GO 后才允许受控 predeploy。先单 worker canary，观察一个完整调度
   周期，再分批恢复其余 worker；任何认证风暴、5xx 放大或 freshness 退化立即回滚。
6. 生产 smoke、双网络与缓存证据全部通过后，才开始 24 小时小流量 Beta 观察；
   Claim/Portfolio 与后续 postdeploy 仍按独立门禁推进。
