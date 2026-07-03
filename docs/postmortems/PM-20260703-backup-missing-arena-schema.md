# PM-20260703：日备漏掉 arena._ 主数据层（只备了遗留 public._ 表）

| 字段     | 值                                                                                     |
| -------- | -------------------------------------------------------------------------------------- |
| 日期     | 2026-07-03 发现（做 GH Actions 备份冗余时）；影响窗口 = arena schema 上线(2026-06)至今 |
| 严重度   | SEV2（备份存在但不完整——灾难恢复时主数据层不可从备份还原）                             |
| 用户影响 | 无直接影响；潜在灾难恢复缺口（真出事时 arena.\* 交易数据丢失）                         |
| 检测方式 | 做 GH Actions 备份冗余、查表大小分布时发现（非告警）                                   |

## 时间线

- 2026-06：数据层重建，主数据从 public._ 迁到 arena._ schema（trader_latest/v2 DROP）。
- 迁移后：`scripts/maintenance/backup-to-r2.mjs` 默认模式仍 dump `public.*` TRADER_TABLES。
- 2026-07-03：查表大小发现主数据在 arena._（leaderboard_entries 2.8GB、
  trader_series 1.1GB、trader_stats 271MB、position_history 等），而备份的 public._
  trader 表大多已空（数据仅 trader_daily_snapshots 181MB 等少数残留）。
  → **日备的 381MB 只是 public._ 残留，arena._ 几 GB 主数据从未进备份**。

## 根因

直接原因：backup-to-r2.mjs 的 TRADER_TABLES 硬编码 `public.*` 表名
→ 为什么没跟上：2026-06 数据层迁到 arena.\* 时，备份脚本的表清单没同步更新
→ 系统性根因：**备份范围硬编码表名，与 schema 演进解耦**——数据搬家了，
备份还在备旧地址，且没有"备份是否覆盖主数据"的校验。

## 修复

- 根治：backup-to-r2.mjs 加 **schema 模式**（`BACKUP_SCHEMAS=arena,public`，
  `-n` dump 整个 schema），抓完整 app 数据层，跳过 storage.objects(2.2GB 文件
  元数据，实体在 Supabase Storage)/auth 系统 schema。
- GH Actions `backup-db.yml` 用 schema 模式 + 只读角色 arena_backup_ro——
  这是**新的完整备份主通道**。实测 ro 角色读 arena.trader_stats=415544 行完整。
- 待办：Mac Mini crontab 的 `backup:r2` 也切 schema 模式（等 GH backup 证明
  schema 模式在真实数据量跑通后传播——验证优先）。

## 防再犯

- [x] schema 模式备份（跟随 schema 而非硬编码表名）
- [x] GH Actions 完整备份 + 只读角色（冗余 Mac Mini + 降爆炸半径）
- [ ] 备份完整性校验：新鲜度哨兵扩展为"最新备份大小 >阈值"（几 GB 级，
      防止再次退化成只备残留表的小备份）——下一步
- [ ] Mac crontab 切 schema 模式

## 教训

"备份存在" ≠ "备份完整"。硬编码的备份范围会与 schema 演进悄悄脱节；
schema 搬家时，备份范围、qa:schema、监控三处都要同步。哨兵不仅要查"备份新不新"，
还要查"备份全不全"（大小骤降 = 范围退化的信号）。
