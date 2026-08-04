# Arena V1 执行状态与发布停止线（2026-08-03）

## 当前结论

V1 继续收敛为“可信的跨交易所交易员发现、判断与持续跟踪”。赛季、对战、押注、Token、Vault、托管和交易执行不进入本轮发布。

当前生产结论是 **NO-GO**，不是因为缺少页面，而是生产数据库依赖正在降级且已知数据库凭据必须轮换。在依赖恢复、迁移落地、缓存预热和发布后探针全部通过前，不恢复写入 worker、不重新启用备份定时任务，也不开放 Beta 邀请。

任何 deploy-force 标记、关闭 gate、手工 Vercel promote 或通用事故命令都不能覆盖这个 NO-GO。恢复操作只能按本文的有序步骤和 owner 授权执行。

状态含义：

- `DONE`：已完成并有本地证据。
- `CODE-READY`：实现与隔离测试完成，尚未部署。
- `BLOCKED`：需要外部系统恢复、受控凭据或隔离环境。
- `PENDING-PROOF`：步骤可执行，但缺少发布后的真实证据。

## 事故事实与已完成止损

### 生产依赖

- 2026-08-03 较早抽检曾出现 500/504/522/524 与超时；约 18:18 PT 的复核已恢复可响应：`/api/health` 为 HTTP 202（8.84 秒）且 `status=degraded`，API/database/Redis pass，但 freshness 仅 `13/32` fresh、`19` critical，VPS 因无近期 heartbeat 为 skip。正确使用 `window` 的 rankings、traders 与 hero-stats 均返回 200；rankings 的错误 `timeRange` 参数返回 400 是契约校验，不是健康失败。
- Supabase 官方状态仍为 Partially Degraded，`Project Upgrade Delays` 仍为 identified。当前 HTTP/DB 读取恢复不能证明 pooler、迁移、worker heartbeat、freshness 或托管事故已经闭合，因此 NO-GO 不变。
- 当前 Vercel 生产部署来自 2026-07-21 的旧提交，不包含本轮修复。
- Vercel generated deployment URLs 当前启用了 `all_except_custom_domains` SSO protection，且旧部署有过期策略；但项目仍存在 automation/manual deployment-protection bypass credentials。它们的标识在本次只读审计输出中暴露，因此必须全部撤销并轮换，不能依赖“旧 URL 私有”作为唯一认领安全边界。完成证据必须包含旧值访问失败以及新值只能在受保护自动化中成功。

### 可逆止损（DONE）

- Mac mini 的 `arena-ingest-worker` 与 `arena-worker` 已停止并保存 PM2 状态。
- 新加坡节点的 `arena-ingest-worker-sg` 已停止并保存 PM2 状态；抓取器、代理和 Playwright 服务未被误停。
- 这些进程此前分别处于数千到七万次重启的风暴中，持续放大数据库认证熔断。只有在凭据、迁移、精确 release ID 和 heartbeat 证明全部通过后才能恢复。
- 旧备份 cron 已暂停。旧脚本在 `pg_dump` 失败后仍把 20 字节 gzip 当成功上传并执行保留期清理，已导致 2026-07-27 之后的多份伪备份。
- 清理的内容仅限浏览器缓存、可重建构建缓存、依赖缓存和 214 个干净的旧 worktree；18 个脏 worktree与 3 个 detached worktree保留。数据卷当前为 85%，约 32 GiB 可用。

### 备份证据（DONE / PENDING-PROOF）

- 最近一份已知完整备份为 `db-backups/2026/07/arena-backup-20260726-schemas.sql.gz`。
- 大小：`5,112,388,073` 字节；ETag：`814e15cfc522fcbba15d96759142899c`。
- 已建立保留期之外的事故保护副本：`protected/incident-20260803/arena-backup-20260726-schemas.sql.gz`，大小与 ETag 一致。
- 原件已完成整包下载、最小大小、gzip CRC/ISIZE 和 PostgreSQL dump 结束标记检查。
- `BLOCKED`：还没有一个获准使用的隔离 PostgreSQL 恢复目标，因此尚未做真实 restore、对象数/关键表抽样和应用只读验证。严禁把演练恢复到生产数据库。

## 计划执行矩阵

| 工作流         | 状态       | 本轮结果                                                                                                                                                                                                                                                                                                                                                                                                        | 尚缺证据                                                                                                                                                                             |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1 范围/事实源 | CODE-READY | `/about`、`/status`、`/api/health` 改为复用产品事实与同一 freshness/publication 权威，移除冲突的硬编码数字和状态阈值                                                                                                                                                                                                                                                                                            | 部署后页面与 API 对照                                                                                                                                                                |
| 排行榜可用性   | CODE-READY | `/api/rankings`、`/api/traders` 使用每周期/分类一份 500 行 canonical 快照、5 分钟 live、24 小时 LKG、6.5 秒请求上限、4.5 秒内动态缩短的源预算、分布式单写者和发布 fence                                                                                                                                                                                                                                         | DB 恢复后预热 LKG；生产合成探针                                                                                                                                                      |
| 数据可信度     | CODE-READY | canonical cache 读时重新执行 publication source policy 与 quarantine 过滤；它不重新判定逐行 proof、指标完整性、分数新鲜度或周期证据。状态面暴露 coverage、freshness 与最近完整 90D 发布证明；不可证明时返回 unknown/down，而不是绿色                                                                                                                                                                            | 一个完整抓取到发布周期                                                                                                                                                               |
| 激活测量       | CODE-READY | 首页补 heartbeat；提醒只在服务端确认创建后记事件；新增 activation v2 epoch：注册后 7x24h 内看过详情、完成收藏/关注/持久提醒，且事件跨两个 UTC 日期                                                                                                                                                                                                                                                              | 迁移后等待至少 7 天形成首批 eligible cohort                                                                                                                                          |
| 认领/账户连接  | CODE-READY | V1 claim 仅支持 Hyperliquid/GMX 钱包签名并进入人工审核，所有 CEX claim 均 unsupported；API-key 公开来源收敛为 Binance/Bybit/Bitget，账户连接保持私有且不排队/发布公共 first-party 数据。旧 connect、bind-api-key、trader sync 与 OAuth 三端点无条件固定 410；旧 ownership/wallet verify tombstone 为 auth-first（匿名 401、已登录 410）。账户 bind/rebind/revoke 与 Claim unlink 已收口为 service-only 原子边界 | production ACL 与完整 lifecycle/rollback smoke；Claim exact-SHA/unlink smoke；历史 verified/ambiguous credential 审计；fresh first-party 输入 48h 排空证明                           |
| 旧 Portfolio   | CODE-READY | 新建、同步、positions/snapshots 固定 410；owner 仅经认证清单、严格白名单 data export 与 service-only delete 使用保留数据；旧 snapshot cron 为认证 no-op 且已移出 schedule。bridge 到 migration 的短窗口中 export 预期 500 fail closed；migration 后才允许 200 完整导出。migration 保留密文到 owner 删除，绝不导出密文，也不把 Arena 删除误报为 exchange revoke                                                  | production exact ledger/live ACL/RPC；export 200 完整 manifest/owner rows、字段白名单、无密文/跨 owner、超限 413；delete cascade/rollback；逐 owner exchange key revoke/rotate smoke |
| 支付           | CODE-READY | 支付 canary 移除硬编码真实用户、旧 RPC 和 DELETE/free 重置；只允许受保护 `arena-staging-payment-canary` environment 显式触发，URL 必须绑定到独立的非生产 Supabase project；专用 pristine fixture 在事务内调用当前 atomic entitlement authority，强制回滚并用第二连接证明指纹恢复                                                                                                                                | staging disposable fixture 与 Stripe 测试 webhook                                                                                                                                    |
| 供应链         | CODE-READY | vendored `brace-expansion` compatibility facade/upstream 从 5.0.8 升至 5.0.9；高危审计清零                                                                                                                                                                                                                                                                                                                      | CI 重跑                                                                                                                                                                              |
| worker/发布    | BLOCKED    | 重启风暴已停止，发布 gate 和 heartbeat 机制保留                                                                                                                                                                                                                                                                                                                                                                 | 新凭据、迁移、Vercel canary、Mac/SG 精确 release proof                                                                                                                               |
| Beta/GTM       | PREPARED   | 目标用户、真实任务、访谈脚本、缺陷分级与周复盘见 `V1_BETA_OPERATING_RUNBOOK_2026-08-03.md`                                                                                                                                                                                                                                                                                                                      | NO-GO 清除后才发邀请                                                                                                                                                                 |

## 必须按顺序执行的恢复与发布流程

任何一步失败都停止，不跨过失败继续部署。

1. **确认托管事故恢复**
   - Supabase 状态页恢复正常。
   - 项目 Dashboard 能正常打开，项目未处于升级/恢复中。
   - 使用当前密钥分别验证 Auth、service-role REST 和 pooler 连接；不把超时解释成“数据为空”。
2. **轮换已暴露数据库凭据**
   - 在 Supabase Dashboard 轮换数据库密码。
   - 同步更新本地受控环境、Vercel Production、Mac mini worker 与新加坡 worker；不要把值写进 issue、日志或聊天。
   - 对四处值只记录指纹一致性，不输出原文。
   - 同时撤销所有 automation/manual Vercel Deployment Protection bypass credentials，只重新签发获准自动化所需的一枚受控 secret，并审计旧 deployment URL 访问。必须证明每个旧值访问 generated deployment URL 失败、新值仅在受保护 workflow 成功；只记录 credential ID/指纹、owner 和轮换时间，不记录值。
3. **隔离恢复演练**
   - 将事故保护备份恢复到新建的非生产 PostgreSQL 17 目标。
   - 验证 dump 完成、schema 数、关键表存在、关键 RPC 可解析和只读抽样；记录开始/结束时间与目标销毁方式。
4. **完整九迁移、双阶段认领切换与类型**
   - `scripts/maintenance/apply-launch-migrations.sh` 受 ADR-023 限制，只能用于 manifest/status/preview；它的所有数据库写命令均已禁用，不能拿它应用 staging 或 production 迁移。
   - 本次只读复核没有 production `DATABASE_URL` 或 Supabase MCP 通道；`status` 在连接前因缺少 `DATABASE_URL` 停止。2026-07 四个 ranking-authority migration 的生产状态因此是 **PENDING-PROOF**，不是“已应用”也不是“确认未应用”。恢复只读访问后，必须先同时核对 exact `supabase_migrations.schema_migrations` ledger 和 RUNBOOK 规定的 live catalog/RPC/pg_cron 探针。
   - 第一阶段文件顺序固定为：`20260729223000_rerank_public_eligible_rows_only.sql` → `20260729224000_rank_eligible_leaderboard_count_cache.sql` → `20260729225000_token_trader_rank_authority.sql` → `20260729230000_token_ranking_generation_barrier.sql`。ledger 与 live catalog 均精确匹配时记录证明并禁止重放；只读证据确认缺失且 catalog 基线兼容时才通过获准的单文件通道按顺序补齐；两类证据冲突时停止调查。该阶段未闭合时不开始 2026-08 数据库变更。
   - 2026-08 阶段还有五个不计入九个核心产品 migration 的强制身份/凭据安全前置：`20260716093000_user_linked_traders_server_write_only.sql`、`20260716112000_exchange_connections_server_only.sql`、`20260716178000_user_profile_write_authority.sql`、`20260716179100_user_profile_read_audience.sql`、`20260716179200_user_profile_wallet_authority.sql`。当前都缺 production exact ledger/live ACL catalog 证明，因此状态为 **PENDING-PROOF**，任一未证明即 NO-GO。恢复只读访问后必须证明 linked-trader browser/PUBLIC 零 DML与 authenticated own-SELECT-only、connection browser/PUBLIC table/column 零路径、profile 身份列/计数不可由 authenticated 更新，以及对应精确 policy/role grants；只有只读确认某 ledger 缺失且 catalog 基线兼容时，才按时间顺序通过 ADR-023 获准单文件通道补齐。ledger/catalog 冲突时停止，不修 ledger、不重放。
   - 第二阶段五个文件目前只是 CODE-READY，尚未在 staging 或 production 应用：`20260803211000_b2c_activation_v2.sql`、`20260803211500_trader_authorizations_server_only.sql`、`20260803212000_legacy_portfolios_v1_retirement.sql`、`20260803213000_trader_claim_v2_rpcs.sql`（Phase A）和 `20260803214000_trader_claim_v2_cutover.sql`（Phase B）。
   - staging 先逐文件应用 activation，再在 authorization、Portfolio retirement 与 Claim Phase A 之前通过受保护管线部署候选 exact bridge SHA。这个顺序有意不按文件时间排序；每个 migration 必须单独提交，部署与每个文件都要留下 exact SHA/ledger/catalog/ACL/RPC/PostgREST reload 证据。
   - bridge pre-migration smoke 必须证明旧 connect、bind、sync 与 OAuth 无条件固定 410；两个 auth-first tombstone `/api/exchange/verify-ownership`、`/api/traders/claim/verify-wallet` 为匿名 401、已登录 410，且无凭据读取、proof consumption、direct-table fallback 或写入。新的 authorize POST/Claim 写路径因 RPC 缺失须 fail closed。还必须证明 `POST /api/portfolio`、`POST /api/portfolio/sync`、`GET /api/portfolio/positions`、`GET /api/portfolio/snapshots` 固定 410，`GET /api/cron/aggregate-portfolio-snapshots` 无有效 cron secret 返回 401、有 secret 返回 `status=retired` 且写入零行，并确认 Vercel schedule 已移除该 cron。由于 Portfolio RPC 此时尚不存在，已认证 `POST /api/settings/export` 的预期结果是 500 fail closed；任何省略 `legacy_portfolios` 的 200 部分导出都是发布失败。保留的 `GET /api/portfolio/[address]` EVM 查询和 `/api/portfolio/suggestions` 不是这套旧凭据面，不得误退役。该同一个 exact SHA 必须保持到 Phase B 后验证完成，禁止在数据库切换间换包。
   - 保持该 bridge SHA，先应用 authorization migration 并完成双投影生命周期 smoke，再单独应用 Portfolio retirement。Portfolio pre/postflight 必须证明三张旧表及 cascade FK exact shape；browser/PUBLIC 无 table/column 路径；service 无 direct DML、无密文/positions/snapshots direct SELECT，只能直接读取 `id,user_id,exchange,label,created_at`；唯一 policy 是 service metadata SELECT；`export_legacy_portfolio_data_v1(uuid)` 与 `delete_legacy_portfolio_v1(uuid,uuid)` 仅 service 可执行。fixture 必须证明 authenticated 不能执行 RPC，且 HTTP route 固定传认证 user id；迁移后 export 必须返回 200，完整 manifest 与 `account.legacy_portfolios` 均包含 portfolios/positions/snapshots 三项及 fixture owner rows，字段精确白名单、无 owner id/密文、child 只属于所选 owner 的 portfolio；任一组超过 250,000 行须返回 413，不得截断或部分成功。同时覆盖跨 owner delete false、parent/child cascade、故障回滚、重放，以及迁移前后未删除 owner 行或改写密文。
   - 进入 Claim Phase A 前，用只读 catalog 证明迁移角色 exact 拥有 `trader_claims`；Phase A 只开放 typed submit/reject/cancel 并撤销 legacy activation/Arena claimed helper，故 legacy 与 V2 approval 都必须 fail closed，不得把它称为可批准的兼容层。使用同一 SHA 完成 Hyperliquid/GMX challenge → submit → `reviewing` → reject/cancel smoke 后才应用 Phase B。Phase B 前还须证明迁移角色 exact 拥有其 preflight 列出的全部 relation；提交后必须 smoke canonical `activate_trader_claim_v2` 管理员批准、badge/link/profile/Arena 投影，以及 service-only unlink/rollback。Phase A 与 Phase B 不得连续批量应用。
   - 五个额外身份/凭据 ACL 前置和 staging 全链路通过后，production 才能重复完全相同的有序流程：activation → 受保护部署同一 exact bridge SHA 并完成 retirement/fail-closed smoke → authorization → Portfolio retirement → Claim Phase A → 同一 SHA 成功 smoke → Claim Phase B。production 必须重复 authorization 生命周期、Portfolio ACL/数据保留/owner delete cascade、Claim approval/unlink/rollback 证明。未获准时不创建 disposable production claim 或 portfolio；staging 写入证据和 production 契约/部署证据必须绑定同一 SHA。
   - MCP 通道不可用时发布暂停，不使用 `db push`、历史批量重放或已禁用的 psql writer 代替。
   - `lib/supabase/database.types.ts` 是 production-generated **DO NOT EDIT** 文件。候选应用在 Phase B 前遇到 schema-ahead 字段/RPC 时只能用局部 runtime parser/窄 cast；禁止手写生成类型。五个额外身份/凭据 ACL 前置、全部九个 production migration 的 exact ledger/live proof、authorization、Portfolio retirement 和 Claim 全生命周期门禁完成后，才从该 production schema 运行 `npm run gen:types`，提交真实生成 diff 并运行 types-live-drift/`qa:schema`/CI。
   - 运行 migration history shape、五个身份/凭据 ACL 前置与 2026-07 四个 ranking-authority migration 的静态/PG17 suites，以及 activation、authorization、legacy-portfolio-retirement、claim-cutover 四项 PG17 suite（覆盖 2026-08 五个 migration）与其余 schema/read/insert drift 检查。任何 prerequisite、migration 或 smoke 失败都停止发布。
5. **完整 Web canary**
   - 仅通过仓库 `deploy-gate` / `vercel-release-control` 工作流发布经过双阶段切换的 exact application SHA，不直接从脏工作区执行 Vercel deploy。
   - 预热 7D/30D/90D canonical live 与 LKG；每个窗口必须返回非空、同一 publication generation。
   - 验证 `/api/health`、`/api/rankings`、`/api/traders`、首页、榜单、详情、登录、收藏/关注/提醒、claim UI 的 Hyperliquid/GMX-only 与 CEX-unsupported 状态，以及定价只读路径；同时核对 API-key UI 只有 Binance/Bybit/Bitget，旧 connect/bind/sync/OAuth 与旧 Portfolio 能力无条件返回 410，两个旧 ownership/wallet verify tombstone 分别为匿名 401、已登录 410。`/portfolio` 只显示 owner 元数据和删除，不展示/同步密文；Portfolio migration 后，`POST /api/settings/export` 必须返回 200，在 manifest 与 `account.legacy_portfolios` 完整列出 owner-only 白名单 portfolios/positions/snapshots 且绝无 ciphertext/跨 owner 数据，超限返回 413；EVM address portfolio 与 suggestions 保持可用且不接触旧凭据表。
6. **历史身份审计与受控支付写路径**
   - 应用 Phase B 本身不会批量改写已有 verified history；之后只有用户明确解绑才通过 service-only 原子 RPC 撤销选中身份的公开权威。开放 claim/Beta 前，owner 必须逐行审计所有 `trader_claims.status = 'verified'` 及其对应 `verified_traders`/user linkage/authorization/connection projection，为每行记录 retain/quarantine 决定、身份、来源、证明和重复冲突证据。任何未决、投影漂移、无法证明的历史 badge 或 ambiguous credential mapping 都维持 NO-GO；不得静默删除、猜测对应关系或假定 Phase B 已修复历史行。
   - 对全部 `user_portfolios` 行另建 owner/交易所清单。通知 owner 先下载其非密文可移植数据，再在对应交易所 revoke/rotate 每个旧 key，并决定是否通过 Arena owner-delete RPC 清除密文及级联 positions/snapshots；删除成功只证明 Arena 副本已删除，不证明交易所 key 已失效。任何无法联系、未撤销/轮换或归属不明的行维持 NO-GO。
   - claim 完整写入与 unlink/rollback 目前只有隔离 PG17 证明，staging/production 仍必须按 Phase A/Phase B gate 重复；本阶段另在 staging disposable fixture 运行 rollback-only 支付 canary。
   - 从 exact bridge 部署且全部旧公开 first-party writer 停止的时间点起，等待至少 48 小时；随后只读证明 `arena.trader_stats` 中会进入排名且 `extras->>'provenance' = 'first_party'` 的 fresh 输入为零，并在重算前记录查询、截止时间和结果。账户连接本身不满足公开身份门禁，不能用新同步续期这类数据。
   - Stripe 使用测试模式事件，验证 checkout、webhook 幂等、entitlement 和退款/撤销路径。
7. **worker 分批恢复**
   - 先部署一个 ingest canary，要求 release ID、数据库连接、一次队列消费和 heartbeat 全部匹配。
   - 观察一个完整调度周期无认证风暴、无 5xx 放大后，再恢复 Mac mini 其余进程；新加坡节点最后恢复。
8. **备份定时任务恢复**
   - 只启用当前 fail-closed 的 `scripts/maintenance/backup-to-r2.mjs`。
   - 首次计划任务必须产生大于最低阈值、带完成标记且通过完整性检查的对象；在此之前不执行自动保留期清理。
9. **开放 Beta**
   - owner 必须先明确解除 current incident NO-GO。连续 24 小时核心 API 与 freshness 通过，五个额外身份/凭据 ACL 前置、完整九迁移的 ledger/live proof、authorization 生命周期、Portfolio retirement/交易所侧 key revoke-rotate、Claim approval/unlink 原子 smoke、生产生成类型、历史身份审计、first-party 48h 排空、凭据轮换证据全部闭合，且没有 P0/P1 数据可信度问题后，才按 Beta runbook 分批邀请。

## 最终本地验证证据

2026-08-03 18:54 PDT，在本分支无冲突整合当时最新 `origin/main` 后，最终本地候选完成以下验证：

- 完整 Jest：1045 suites / 11,901 tests 通过；3 suites / 27 tests 按既有条件跳过；零失败。
- 主应用与 ingest worker TypeScript：通过。主应用 ESLint 为 0 error / 2700 条既有 warning；worker ESLint 为 0 error / 8 条既有 warning。
- 与 CI 相同的非生产 dummy 环境执行 Next.js webpack production build：通过；postbuild BigInt 检查覆盖 1094 chunks 并通过。第一次完全空环境构建按预期在 critical env validation 处停止，不属于代码失败，也未使用生产凭据。
- 仓库 QA：337/337 API route 鉴权覆盖、221/221 sweep unit、11/11 generated-types contract、19/19 launch migration runner、Supabase cast ratchet 与 migration-history shape 全部通过。当前 shape 为 584 个 migration（393 modern、191 fingerprinted legacy）；这只证明清单形状，不证明迁移已部署。
- 五项隔离 PostgreSQL 17 证明全部通过：exchange-connection ACL、activation v2、authorization lifecycle、legacy Portfolio retirement/export/delete 与 Claim V2 two-phase cutover。
- `npm audit --audit-level=high` 为 0 high / 0 critical；仍有 2 low / 22 moderate，不能表述为“零漏洞”。
- changed-file Prettier、OpenAPI YAML/Portfolio-export paths、`git diff --check`、新增内容 secret pattern scan、clean worktree、`origin/main` ancestry 与 production-generated `database.types.ts` 未改动均须在最后一次文档冻结后再次通过；交付报告记录其最终结果。

Git commit 不能在自己的内容中自引用其最终 SHA；因此 exact candidate SHA 由冻结后只读 `git rev-parse HEAD` 与本次交付报告绑定。任何后续 amend、rebase 或文件修改都会使本节证据失效，必须重新验证并重新记录。上述本地 green 不能替代 production migration、ACL、凭据轮换、恢复演练、48 小时排空或真实环境 smoke。

## 需要所有者提供的最小外部动作

这些动作涉及新的权限或秘密，自动化不能替代所有者：

1. 在 Supabase Dashboard 确认项目恢复，并轮换数据库密码。
2. 在 Vercel 撤销所有旧 deployment-protection bypass credentials，重新配置唯一受控自动化 secret，并提供旧值访问失败/新值受控成功的证据。
3. 提供一个可销毁的非生产 PostgreSQL 17 恢复目标。
4. 在 staging 建立专用 disposable QA 用户、Hyperliquid/GMX claim trader fixture 与 payment canary fixture；只把 secret 写入受控 secret store。
5. 在 GitHub 实际创建并保护 `arena-staging-payment-canary` environment，配置 required reviewers 及专用 staging project/fixture secrets；YAML 中写出 environment 名称本身不能证明保护规则已经存在。
6. 确认可以通过受保护工作流部署本分支，而不是绕过 gate 直接推生产。

在这些动作完成前，代码可以继续审查和测试，但不能诚实地声明生产已恢复、备份可恢复、认领 E2E 已通过或 V1 已上线。
