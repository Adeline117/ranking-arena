# Arena V1 执行状态与发布停止线（2026-08-03）

## 当前结论

V1 继续收敛为“可信的跨交易所交易员发现、判断与持续跟踪”。赛季、对战、押注、Token、Vault、托管和交易执行不进入本轮发布。

当前生产结论是 **NO-GO**，不是因为缺少页面，而是生产数据库依赖正在降级、已知 migration 证据共有 `60` 个缺口（`51` 个 launch predeploy、`3` 个 record/publication、`1` 个 launch postdeploy、`5` 个 activation/authorization/Portfolio/Claim）及一项 ledger/live 冲突，Preview 仍继承生产高权限凭据，而且已知凭据必须轮换。在依赖恢复、完整迁移基线重建、隔离 staging、缓存预热和发布后探针全部通过前，不恢复写入 worker、不重新启用已暂停的主机备份任务，也不开放 Beta 邀请。

任何 deploy-force 标记、关闭 gate、手工 Vercel promote 或通用事故命令都不能覆盖这个 NO-GO。恢复操作只能按本文的有序步骤和 owner 授权执行。

状态含义：

- `DONE`：已完成并有本地证据。
- `CODE-READY`：实现与隔离测试完成，尚未部署。
- `BLOCKED`：需要外部系统恢复、受控凭据或隔离环境。
- `PENDING-PROOF`：步骤可执行，但缺少发布后的真实证据。
- `INTEGRITY-DONE`：对象级流/结构检查已完成，不代表可恢复。
- `RESTORE-BLOCKED`：尚无合格恢复对象或演练资源，未完成真实 restore。
- `PREPARED`：文档与操作材料已备好，尚未获准启用。

## 事故事实与已完成止损

### 生产依赖

- 2026-08-03 较早抽检曾出现 500/504/522/524 与超时；约 18:18 PT 的复核已恢复可响应：`/api/health` 为 HTTP 202（8.84 秒）且 `status=degraded`，API/database/Redis pass，但 freshness 仅 `13/32` fresh、`19` critical，VPS 因无近期 heartbeat 为 skip。正确使用 `window` 的 rankings、traders 与 hero-stats 均返回 200；rankings 的错误 `timeRange` 参数返回 400 是契约校验，不是健康失败。
- Supabase 官方状态仍为 Partially Degraded，`Project Upgrade Delays` 仍为 identified。当前 HTTP/DB 读取恢复不能证明 pooler、迁移、worker heartbeat、freshness 或托管事故已经闭合，因此 NO-GO 不变。
- 当前 Vercel 生产部署来自 2026-07-21 的旧提交，不包含本轮修复。
- Vercel generated deployment URLs 当前启用了 `all_except_custom_domains` SSO protection，且旧部署有过期策略；但项目仍存在 automation/manual deployment-protection bypass credentials。它们的标识在本次只读审计输出中暴露，因此必须全部撤销并轮换，不能依赖“旧 URL 私有”作为唯一认领安全边界。完成证据必须包含旧值访问失败以及新值只能在受保护自动化中成功。
- Vercel 主项目的 Preview 不是 staging：任意分支自动 Preview 仍可继承 production `DATABASE_URL`、Supabase service role、Stripe secret、R2 credentials、`ENCRYPTION_KEY` 等高权限值；另两个测试项目没有环境、Git 连接或成功部署。Preview 权限隔离前禁止 push 当前候选分支。
- 2026-08-03 control-plane 审计时，GitHub `main` 没有 branch protection/ruleset（现有私有仓库计划不支持）；`Production`、`Preview` 与 `ingest-sg-production` environments 均无 required reviewer，`arena-staging-payment-canary` environment 尚不存在。当天 26 次 Deploy Gate 全失败并被扣留，对应 26 个 Vercel production candidates 全为 canceled；SG deploy 为 0，说明没有发布发生，但也证明受保护通道尚未建立。
- 同次审计中 GitHub artifact quota 已满；最近 worker image虽完成 build/smoke/tag promotion，最终 evidence artifact 上传失败。Vercel runtime 为 Node 24.x，而本地/CI 主证明为 Node 22，仍缺同版本 staging build。线上仍为 `de5524bd…`，当时比 main 落后 295 commits；候选未 push，因此没有 GitHub SHA/PR/Preview 身份。
- 本地候选已把十一个 privileged production workflow 固定为零 runner：`backup-db`、`build-ingest-image`、`openclaw-sentinels`、`deploy-gate`、`post-deploy-smoke`、`post-deploy-evaluate`、`deploy-ingest-sg`、`e2e-nightly`、`mobile-build`、`payment-path-canary`、`vercel-release-control`；CI 的 production types drift 与 data-consistency jobs 也固定 `if: false`。五个 reusable workflow 即使可被其他 workflow 调用，所有 job 仍不可执行。所有任意-ref dispatch 已移除，NO-GO 期间可达的第三方 action 全部固定 full SHA；CI/Lighthouse 的 PR 路径为只读 token、无 cache/后置写 action，artifact/Codecov 仅 push-main。脚本 fail closed 不能替代 protected source trust。以上只是未 push 的代码态；GitHub 线上 workflow 仍须在认证恢复后由 owner 同步停用，不能把本地 YAML 当作 control-plane 证据。

### 可逆止损（DONE）

- Mac mini 的 `arena-ingest-worker` 与 `arena-worker` 已停止并保存 PM2 状态。
- 新加坡节点的 `arena-ingest-worker-sg` 已停止并保存 PM2 状态；抓取器、代理和 Playwright 服务未被误停。
- 两个 ingest worker 曾在本次 NO-GO 中于 16:51 PT 被停、约 16:54 PT 被同一类已认证运维会话重新拉起；GitHub Actions 没有对应的 8 月 3 日 SG deploy run。它们现已再次停止。正式 primary hold 位于 `~/ranking-arena/.arena-ingest/ingest-deploy.hold`，SG 位于 `/opt/arena-ingest.deploy-hold`，两者与旧 orchestrator compatibility guard 均已 armed。只有 owner 完成全部门禁后才能解除；hold 不拦截直接 PM2 命令，因此直接 start/restart 仍被操作规程禁止。
- R2 中 07-27、07-28、07-30、07-31、08-01、08-02、08-03 共 7 个对象都是 20 字节空 gzip。07-30 至 08-03 来自仍运行旧 checkout 的 Mac 03:30 cron；仓库当前脚本已 fail closed 不等于旧调度已经升级。08-03 GitHub backup 在 `pg_dump` 阶段因 Supabase pooler `EAUTHQUERY`/`ECIRCUITBREAKER` 正确失败，但 Telegram 告警返回 401，告警凭据也必须修复。
- Mac mini 的 03:30 backup 与 09:00 old freshness crons 均已显式注释暂停；MacBook 指向不存在脚本的 `com.ranking-arena.cron-backup` 和 Mac mini 指向不存在脚本的 `com.arena.daily-checkpoint` 已精确 unload+disable，plist 保留，未影响其他任务。本地候选已把 GitHub `backup-db` 与 OpenClaw sentinel 的全部 job 固定为 false，但尚未 push/部署，所以线上 schedule 仍 active，不能宣称控制面已停用；owner 必须在 GitHub 直接停用。恢复任何备份任务前须把固定 SHA 部署到干净 ops checkout，验证绝对日志路径和失败 canary。
- `lighthouse-ci` 原先在 `pull_request` 构建仓库代码时向整个 job 注入 Supabase service-role；本分支已改为纯 inert placeholder 环境、只读 token、checkout 不持久化凭据，并移除所有仓库代码执行后的评论/上传 action，防止恶意后台进程窃取后续写 token。新增契约测试证明 PR 仓库命令不含任何 `secrets.*` 路径或后置特权步骤；该修复同样尚未 push。
- 清理的内容仅限浏览器缓存、可重建构建缓存、依赖缓存和 214 个干净的旧 worktree；18 个脏 worktree与 3 个 detached worktree保留。当前 Mac mini 约 8.1 GiB、MacBook 约 22 GiB 可用，不能承载真实恢复。

### 备份证据（INTEGRITY-DONE / RESTORE-BLOCKED）

- 最近一份 gzip/通用 SQL 流完整的 legacy 候选为 `db-backups/2026/07/arena-backup-20260726-schemas.sql.gz`；它不是已证明合格的恢复点。
- 大小：`5,112,388,073` 字节；ETag：`814e15cfc522fcbba15d96759142899c`。
- 已建立保留期之外的事故保护副本：`protected/incident-20260803/arena-backup-20260726-schemas.sql.gz`，大小与 ETag 一致。
- 原件已完成不落盘的完整 R2 → gunzip CRC/ISIZE 与通用 PostgreSQL dump 结束检查：compressed `5,112,388,073` B、plain SQL `37,798,473,433` B（35.2 GiB）、SHA-256 `7eaca4491e3f6e785a4140dc42ec76c34244d1a77b430216111f74b921936f44`、`86,511,740` 行。只读结构扫描得到 341 tables、396 functions、333 COPY relations、750 indexes、326 policies、102 triggers、12 views 与 3 materialized views。
- 两次全流扫描均未发现 `public.leaderboard_ranks` 或任何 `leaderboard_ranks_*` partition 的 COPY 段，当前 restore 关键表 `count > 0` gate 因而预计失败。旧对象也尚未额外证明 PG17 原生 63 字符 restrict key 与 matching unrestrict 的 exact legacy 尾标记；只能称候选，不能称可恢复。
- `BLOCKED`：两台现有 Mac 的可用容量都小于 plain SQL 本身，真实 PostgreSQL 还需要 heap/index/WAL 与临时空间；因此尚未做真实 restore 与应用只读验证。必须提供至少约 100 GiB 可用空间、可销毁的非生产 PostgreSQL 17 目标，并在托管事故恢复后生成一个含当前 completion metadata、通过关键表 gate 的新备份。严禁恢复到 production。

### Production 只读 migration / 数据门禁（DONE，结论 NO-GO）

2026-08-04 02:24Z 使用 production transaction pooler（PostgreSQL 17.6、TLS、每次显式 `READ ONLY`）完成审计；未执行 DDL/DML，未输出 PII 或密文。该通道只用于取证，不是获准 migration writer；Runbook 要求的 `5432 + verify-full` session 通道仍未证明。

- 完整 launch status：predeploy `114` 中 `63 exact / 51 missing`；postdeploy `3` 中 `2 exact / 1 missing`；concurrent recovery `5/5 exact`、recovery `3/3 exact`。
- 缺失的 postdeploy 是 `20260729061000_tier_a_execution_claim_enforcement.sql`；live marker `arena.tier_a_execution_claim_enforcement_state()` 也不存在。它必须在完整 predeploy baseline exact、兼容应用已上线且所有 legacy Tier-A writer/queue 排空后，经 ADR-023 单文件应用和 live trigger/ACL/marker 证明；不得混入 predeploy 或十二个 V1 核心 migration 批量执行。
- 四个 `20260729` ranking-authority migration 全部 ledger missing 且 live fail。更早依赖 `20260724235000`、`20260728124000`、`20260729065000` 也 missing，因此禁止把“四文件补齐”当作可执行计划；必须先重建完整 ordered manifest baseline。
- 五个身份/凭据 ACL 前置中，`20260716112000`、`20260716178000`、`20260716179100`、`20260716179200` 为 ledger exact + live pass。`20260716093000` 的 name/body hash/created_by 正确且 live ACL pass，但 idempotency key drift；这是明确 ledger/live 冲突，必须停止，不能重放或手改 ledger。
- 三个 record/publication migration `20260803090000_record_provenance_clocks.sql` → `20260803100000_record_surface_publication_substrate.sql` → `20260803101000_verified_position_history_publication_writer.sql` 全部 ledger missing；publication 表、`position_history.verified_publication_id` 与 writer/checkpoint RPC 也都不存在。现有 records/copier RPC 的函数哈希不在 `20260803090000` 接受的 pre/postflight 集合内，所以第一个文件已经是明确 live preflight drift，三个文件均不得直接重放。
- 五个较晚的 `20260803` migration 全部 ledger missing 且 live fail：activation epoch、authorization guards/RPC、Portfolio retirement/export/delete、Claim Phase A/B 均未落地，旧 browser/service 权限和 legacy RPC 仍未按目标关闭。
- 当前聚合计数均为零：Portfolio/owner/positions/snapshots/凭据行，claims/verified/reviewable 及其 projections，first-party 历史/48h fresh/eligible/snapshots，active authorizations/connections、claimed Arena traders 与 `fp:*` pg_cron jobs。当前无需联系 legacy Portfolio owner，但 exact bridge writer cutoff 后仍须重新开始 48 小时排空证明，因为旧权限尚开放、数据仍可能重新出现。

## 计划执行矩阵

| 工作流         | 状态       | 本轮结果                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 尚缺证据                                                                                                                                                                                    |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 范围/事实源 | CODE-READY | `/about`、`/status`、`/api/health` 改为复用产品事实与同一 freshness/publication 权威，移除冲突的硬编码数字和状态阈值                                                                                                                                                                                                                                                                                                                                            | 部署后页面与 API 对照                                                                                                                                                                       |
| 排行榜可用性   | CODE-READY | `/api/rankings`、`/api/traders` 使用每周期/分类一份 500 行 canonical 快照、5 分钟 live、24 小时 LKG、6.5 秒请求上限、4.5 秒内动态缩短的源预算、分布式单写者和发布 fence                                                                                                                                                                                                                                                                                         | DB 恢复后预热 LKG；生产合成探针                                                                                                                                                             |
| 数据可信度     | CODE-READY | canonical cache 读时重新执行 publication source policy 与 quarantine 过滤；它不重新判定逐行 proof、指标完整性、分数新鲜度或周期证据。position-history artifact `@2` 可持久化，并可在锁定 RAW pointer 与重新验证下重放 acquisition/source facts；目前无 production projection consumer，也不证明 parser projection 或排名资格，legacy publisher 明确只接受 `@1`。状态面暴露 coverage、freshness 与最近完整 90D 发布证明；不可证明时返回 unknown/down，而不是绿色 | record/publication 三迁移与 versioned parser/receipt；一个完整抓取到发布周期                                                                                                                |
| 激活测量       | CODE-READY | 首页补 heartbeat；提醒只在服务端确认创建后记事件；新增 activation v2 epoch：注册后 7x24h 内看过详情、完成收藏/关注/持久提醒，且事件跨两个 UTC 日期                                                                                                                                                                                                                                                                                                              | 迁移后等待至少 7 天形成首批 eligible cohort                                                                                                                                                 |
| 认领/账户连接  | CODE-READY | V1 claim 仅支持 Hyperliquid/GMX 钱包签名并进入人工审核，所有 CEX claim 均 unsupported；API-key 公开来源收敛为 Binance/Bybit/Bitget，账户连接保持私有且不排队/发布公共 first-party 数据。旧 connect、bind-api-key、trader sync 与 OAuth 三端点无条件固定 410；旧 ownership/wallet verify tombstone 为 auth-first（匿名 401、已登录 410）。账户 bind/rebind/revoke 与 Claim unlink 已收口为 service-only 原子边界                                                 | production ACL 与完整 lifecycle/rollback smoke；Claim exact-SHA/unlink smoke；cutoff 后历史 verified/ambiguous credential 盘点（零行 N/A、非零行审计）；fresh first-party 输入 48h 排空证明 |
| 旧 Portfolio   | CODE-READY | 新建、同步、positions/snapshots 固定 410；owner 仅经认证清单、严格白名单 data export 与 service-only delete 使用保留数据；旧 snapshot cron 为认证 no-op 且已移出 schedule。bridge 到 migration 的短窗口中 export 预期 500 fail closed；migration 后才允许 200 完整导出。migration 保留密文到 owner 删除，绝不导出密文，也不把 Arena 删除误报为 exchange revoke                                                                                                  | production exact ledger/live ACL/RPC；staging fixture 的完整 export/delete smoke；bridge cutoff 后 production inventory，非零时才逐 owner exchange key revoke/rotate                        |
| 支付           | BLOCKED    | 支付 canary 代码移除硬编码真实用户、旧 RPC 和 DELETE/free 重置；设计为受保护 environment 显式触发、disposable fixture、事务回滚与第二连接指纹证明                                                                                                                                                                                                                                                                                                               | workflow/environment 尚未存在于 GitHub；无 required reviewer、staging DB/fixture 或 Stripe test webhook                                                                                     |
| 供应链         | CODE-READY | vendored `brace-expansion` compatibility facade/upstream 从 5.0.8 升至 5.0.9；高危审计清零                                                                                                                                                                                                                                                                                                                                                                      | CI 重跑                                                                                                                                                                                     |
| worker/发布    | BLOCKED    | 两节点 worker 已停止并保存；primary incident hold、旧 orchestrator compatibility guard 与候选 deploy-script 可执行门禁均已建立并通过离线 safety tests                                                                                                                                                                                                                                                                                                           | owner 解锁、Preview/staging 隔离、新凭据、60 个已知 migration 缺口与 ledger/live drift、受控 stopped-baseline recovery、Mac/SG exact release proof                                          |
| Beta/GTM       | PREPARED   | 目标用户、真实任务、访谈脚本、缺陷分级与周复盘见 `V1_BETA_OPERATING_RUNBOOK_2026-08-03.md`                                                                                                                                                                                                                                                                                                                                                                      | NO-GO 清除后才发邀请                                                                                                                                                                        |

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
   - 本次远程诊断还意外把当前 shell 注入的 GitHub token 与 Brave API key 暴露给工具输出；GitHub token 已验证为 invalid，仍须从 `~/.zshrc`/shell snapshots 移除旧值并在 provider 侧确认撤销，Brave key 必须轮换。Telegram bot 当前返回 401，也须换新并验证告警投递。
3. **隔离恢复演练**
   - 托管事故恢复后先生成一份带当前 completion metadata、通过完整流校验且所有关键表为正数的新备份，再恢复到新建的非生产 PostgreSQL 17 目标。2026-07-26 事故保护副本只用于结构取证与历史保全，不得作为合格恢复基线。
   - 验证 dump 完成、schema 数、关键表存在、关键 RPC 可解析和只读抽样；记录开始/结束时间与目标销毁方式。
4. **完整十二迁移、双阶段认领切换与类型**
   - `scripts/maintenance/apply-launch-migrations.sh` 受 ADR-023 限制，只能用于 manifest/status/preview；它的所有数据库写命令均已禁用，不能拿它应用 staging 或 production 迁移。
   - Production 只读门禁已证明完整 predeploy manifest 有 `51 missing`，不能从四个 ranking 文件开始。先冻结 exact manifest 与 production ledger/live catalog 快照，逐个分析缺项依赖、重放安全与漂移；通过 ADR-023 为每个缺项建立单文件变更记录。禁止批量 `db push`、手改 ledger或跳过 `20260716093000` idempotency drift。
   - 四个 ranking 文件的目标顺序仍固定为 `20260729223000` → `20260729224000` → `20260729225000` → `20260729230000`，但它们直接依赖的 `20260724235000`、`20260728124000`、`20260729065000` 当前也 missing。只有完整前序 baseline 逐项 exact 且 `20260716093000` ledger/live 冲突经独立审查闭合后，才能考虑 ranking 单文件通道。
   - 五个身份/凭据 ACL 前置已有四个 exact + live pass；`20260716093000` 是 body/name/creator exact、live pass、idempotency drift。禁止以“功能已生效”为理由修 ledger或重放文件；冲突未裁决即维持 NO-GO。
   - 三个 record/publication 文件目前 ledger/live 均确认 missing/fail，且第一个文件的现有函数哈希无法通过 preflight：`20260803090000_record_provenance_clocks.sql`、`20260803100000_record_surface_publication_substrate.sql`、`20260803101000_verified_position_history_publication_writer.sql`。只有完整前序 baseline exact、`0900` 函数漂移经独立裁决且每个文件迁移前契约匹配后，才可按该顺序逐文件提交并证明 provenance clocks、private publication chain 与原子 verified writer。
   - 五个较晚的 2026-08 文件目前只是 CODE-READY，production ledger/live 均确认 missing/fail：`20260803211000_b2c_activation_v2.sql`、`20260803211500_trader_authorizations_server_only.sql`、`20260803212000_legacy_portfolios_v1_retirement.sql`、`20260803213000_trader_claim_v2_rpcs.sql`（Phase A）和 `20260803214000_trader_claim_v2_cutover.sql`（Phase B）。
   - staging 先按 `0900` → `1000` → `1010` 完成 record/publication 链，再逐文件应用 activation；之后才在 authorization、Portfolio retirement 与 Claim Phase A 之前通过受保护管线部署候选 exact bridge SHA。这个顺序有意不按所有文件的时间排序；每个 migration 必须单独提交，部署与每个文件都要留下 exact SHA/ledger/catalog/ACL/RPC/PostgREST reload 证据。
   - bridge pre-migration smoke 必须证明旧 connect、bind、sync 与 OAuth 无条件固定 410；两个 auth-first tombstone `/api/exchange/verify-ownership`、`/api/traders/claim/verify-wallet` 为匿名 401、已登录 410，且无凭据读取、proof consumption、direct-table fallback 或写入。新的 authorize POST/Claim 写路径因 RPC 缺失须 fail closed。还必须证明 `POST /api/portfolio`、`POST /api/portfolio/sync`、`GET /api/portfolio/positions`、`GET /api/portfolio/snapshots` 固定 410，`GET /api/cron/aggregate-portfolio-snapshots` 无有效 cron secret 返回 401、有 secret 返回 `status=retired` 且写入零行，并确认 Vercel schedule 已移除该 cron。由于 Portfolio RPC 此时尚不存在，已认证 `POST /api/settings/export` 的预期结果是 500 fail closed；任何省略 `legacy_portfolios` 的 200 部分导出都是发布失败。保留的 `GET /api/portfolio/[address]` EVM 查询和 `/api/portfolio/suggestions` 不是这套旧凭据面，不得误退役。该同一个 exact SHA 必须保持到 Phase B 后验证完成，禁止在数据库切换间换包。
   - 同一兼容应用 SHA 已服务且所有 legacy Tier-A writer/queue（含两节点 ingest）持续排空后，单独处理 missing postdeploy `20260729061000_tier_a_execution_claim_enforcement.sql`。先证明完整 predeploy manifest exact，再经 ADR-023 单文件通道应用；随后核对 exact ledger、live marker、触发器、ACL、旧 unclaimed RPC 拒绝与 claimed worker 契约。任一写入/队列残留或 live drift 都停止，不能把它塞进 predeploy/十二迁移批次。
   - 保持该 bridge SHA，先应用 authorization migration 并完成双投影生命周期 smoke，再单独应用 Portfolio retirement。Portfolio pre/postflight 必须证明三张旧表及 cascade FK exact shape；browser/PUBLIC 无 table/column 路径；service 无 direct DML、无密文/positions/snapshots direct SELECT，只能直接读取 `id,user_id,exchange,label,created_at`；唯一 policy 是 service metadata SELECT；`export_legacy_portfolio_data_v1(uuid)` 与 `delete_legacy_portfolio_v1(uuid,uuid)` 仅 service 可执行。行级 fixture 只在 staging 建立，必须证明 authenticated 不能执行 RPC，且 HTTP route 固定传认证 user id；迁移后 export 必须返回 200，完整 manifest 与 `account.legacy_portfolios` 均包含 portfolios/positions/snapshots 三项及 fixture owner rows，字段精确白名单、无 owner id/密文、child 只属于所选 owner 的 portfolio；任一组超过 250,000 行须返回 413，不得截断或部分成功。同时覆盖跨 owner delete false、parent/child cascade、故障回滚、重放，以及迁移前后未删除 owner 行或改写密文。production 计数仍为零时只验证 ACL/RPC 与完整空 manifest，不创建 disposable 行；除非另有明确批准。
   - 进入 Claim Phase A 前，用只读 catalog 证明迁移角色 exact 拥有 `trader_claims`；Phase A 只开放 typed submit/reject/cancel 并撤销 legacy activation/Arena claimed helper，故 legacy 与 V2 approval 都必须 fail closed，不得把它称为可批准的兼容层。使用同一 SHA 完成 Hyperliquid/GMX challenge → submit → `reviewing` → reject/cancel smoke 后才应用 Phase B。Phase B 前还须证明迁移角色 exact 拥有其 preflight 列出的全部 relation；提交后必须 smoke canonical `activate_trader_claim_v2` 管理员批准、badge/link/profile/Arena 投影，以及 service-only unlink/rollback。Phase A 与 Phase B 不得连续批量应用。
   - 五个额外身份/凭据 ACL 前置和 staging 全链路通过后，production 才能重复完全相同的有序流程：record provenance clocks → publication substrate → verified position-history writer → activation → 受保护部署同一 exact bridge SHA 并完成 retirement/fail-closed smoke → legacy Tier-A writer/queue 排空并单文件 postdeploy → authorization → Portfolio retirement → Claim Phase A → 同一 SHA 成功 smoke → Claim Phase B。production 必须重复 record publication chain、Tier-A marker/trigger/ACL、authorization 生命周期、Portfolio ACL/数据保留/owner delete cascade、Claim approval/unlink/rollback 证明。未获准时不创建 disposable production claim 或 portfolio；staging 写入证据和 production 契约/部署证据必须绑定同一 SHA。
   - MCP 通道不可用时发布暂停，不使用 `db push`、历史批量重放或已禁用的 psql writer 代替。
   - `lib/supabase/database.types.ts` 是 production-generated **DO NOT EDIT** 文件。候选应用在 Phase B 前遇到 schema-ahead 字段/RPC 时只能用局部 runtime parser/窄 cast；禁止手写生成类型。五个额外身份/凭据 ACL 前置、Tier-A 单文件 postdeploy、全部十二个 production migration 的 exact ledger/live proof、record publication、authorization、Portfolio retirement 和 Claim 全生命周期门禁完成后，才从该 production schema 运行 `npm run gen:types`，提交真实生成 diff 并运行 types-live-drift/`qa:schema`/CI。
   - 运行 migration history shape、五个身份/凭据 ACL 前置与 2026-07 四个 ranking-authority migration 的静态/PG17 suites，三个 record/publication suite `record-provenance-clocks.pg17.sh`、`record-surface-publication-substrate.pg17.sh`、`verified-position-history-publication-writer.pg17.sh`，以及 activation、authorization、legacy-portfolio-retirement、claim-cutover 四项 PG17 suite（覆盖五个较晚的 2026-08 migration）与其余 schema/read/insert drift 检查。任何 prerequisite、migration 或 smoke 失败都停止发布。
5. **完整 Web canary**
   - 仅通过仓库 `deploy-gate` / `vercel-release-control` 工作流发布经过双阶段切换的 exact application SHA，不直接从脏工作区执行 Vercel deploy。
   - 预热 7D/30D/90D canonical live 与 LKG；每个窗口必须返回非空、同一 publication generation。
   - 验证 `/api/health`、`/api/rankings`、`/api/traders`、首页、榜单、详情、登录、收藏/关注/提醒、claim UI 的 Hyperliquid/GMX-only 与 CEX-unsupported 状态，以及定价只读路径；同时核对 API-key UI 只有 Binance/Bybit/Bitget，旧 connect/bind/sync/OAuth 与旧 Portfolio 能力无条件返回 410，两个旧 ownership/wallet verify tombstone 分别为匿名 401、已登录 410。`/portfolio` 只显示 owner 元数据和删除，不展示/同步密文；Portfolio migration 后，`POST /api/settings/export` 必须返回 200，在 manifest 与 `account.legacy_portfolios` 完整列出 owner-only 白名单 portfolios/positions/snapshots 且绝无 ciphertext/跨 owner 数据，超限返回 413；EVM address portfolio 与 suggestions 保持可用且不接触旧凭据表。
6. **历史身份审计与受控支付写路径**
   - 应用 Phase B 本身不会批量改写已有 verified history；之后只有用户明确解绑才通过 service-only 原子 RPC 撤销选中身份的公开权威。开放 claim/Beta 前须在 exact bridge cutoff 后重新盘点 `trader_claims.status = 'verified'` 及其对应 `verified_traders`/user linkage/authorization/connection projection；若仍为零，记录带时点的 `zero / N/A` 证明。仅对非零行逐项记录 retain/quarantine 决定、身份、来源、证明和重复冲突证据。任何未决、投影漂移、无法证明的历史 badge 或 ambiguous credential mapping 都维持 NO-GO；不得静默删除、猜测对应关系或假定 Phase B 已修复历史行。
   - exact bridge cutoff 后重新 inventory `user_portfolios` 与关联凭据；若仍为零，记录带时点的 `zero / N/A` 证明。只对届时非零行建立 owner/交易所清单：通知 owner 先下载其非密文可移植数据，再在对应交易所 revoke/rotate 每个旧 key，并决定是否通过 Arena owner-delete RPC 清除密文及级联 positions/snapshots；删除成功只证明 Arena 副本已删除，不证明交易所 key 已失效。任何无法联系、未撤销/轮换或归属不明的非零行维持 NO-GO。
   - claim 完整写入与 unlink/rollback 目前只有隔离 PG17 证明，staging/production 仍必须按 Phase A/Phase B gate 重复；本阶段另在 staging disposable fixture 运行 rollback-only 支付 canary。
   - 从 exact bridge 部署且全部旧公开 first-party writer 停止的时间点起，等待至少 48 小时；随后只读证明 `arena.trader_stats` 中会进入排名且 `extras->>'provenance' = 'first_party'` 的 fresh 输入为零，并在重算前记录查询、截止时间和结果。账户连接本身不满足公开身份门禁，不能用新同步续期这类数据。
   - Stripe 使用测试模式事件，验证 checkout、webhook 幂等、entitlement 和退款/撤销路径。
7. **worker 分批恢复**
   - 先部署一个 ingest canary，要求 release ID、数据库连接、一次队列消费和 heartbeat 全部匹配。
   - 观察一个完整调度周期无认证风暴、无 5xx 放大后，再恢复 Mac mini 其余进程；新加坡节点最后恢复。
8. **备份定时任务恢复**
   - 本地候选的 GitHub backup/sentinel jobs 固定为 false；远端 schedule 因候选未 push 仍 active，owner 必须先在 GitHub 控制面停用。这里只在 protected main、reviewed environment 与新凭据就绪后恢复任务，并且只允许固定 SHA 中已验证的 `scripts/maintenance/backup-to-r2.mjs`。
   - 首次计划任务必须产生大于最低阈值、带完成标记且通过完整性检查的对象；生产、验证、SHA-256 与上传绑定同一独占文件，PUT 后 exact-key HEAD 的长度、ETag 与全部 metadata 也必须一致。在此之前不执行自动保留期清理。
9. **开放 Beta**
   - owner 必须先明确解除 current incident NO-GO。连续 24 小时核心 API 与 freshness 通过，五个额外身份/凭据 ACL 前置、60 个已知 migration 缺口与完整十二迁移的 ledger/live proof、record publication、authorization 生命周期、Portfolio retirement（届时非零 owner 才要求交易所侧 key revoke/rotate）、Claim approval/unlink 原子 smoke、生产生成类型、历史身份审计、first-party 48h 排空、凭据轮换证据全部闭合，且没有 P0/P1 数据可信度问题后，才按 Beta runbook 分批邀请。

## 最终本地验证证据

2026-08-03 18:54 PDT，在本分支无冲突整合当时最新 `origin/main` 后，最终本地候选完成以下验证：

- 完整 Jest：1045 suites / 11,901 tests 通过；3 suites / 27 tests 按既有条件跳过；零失败。
- 主应用与 ingest worker TypeScript：通过。主应用 ESLint 为 0 error / 2700 条既有 warning；worker ESLint 为 0 error / 8 条既有 warning。
- 与 CI 相同的非生产 dummy 环境执行 Next.js webpack production build：通过；postbuild BigInt 检查覆盖 1094 chunks 并通过。第一次完全空环境构建按预期在 critical env validation 处停止，不属于代码失败，也未使用生产凭据。
- 仓库 QA：337/337 API route 鉴权覆盖、221/221 sweep unit、11/11 generated-types contract、19/19 launch migration runner、Supabase cast ratchet 与 migration-history shape 全部通过。当前 shape 为 584 个 migration（393 modern、191 fingerprinted legacy）；这只证明清单形状，不证明迁移已部署。
- 本轮事故加固在隔离 Node 22 下再次通过 225/225 QA sweep；备份/恢复行为契约 50/50、新 freshness contract 5/5，以及 Mac mini/SG 两组 deploy safety tests均通过。当前 Mac 主机默认/旧 PM2 interpreter 为 Node 25.8.1，Vercel 为 Node 24.x，而部署与 CI 契约要求 Node 22；在干净 staging/主机安装并绑定 exact Node 22 前仍是发布阻塞项。
- 五项隔离 PostgreSQL 17 证明全部通过：exchange-connection ACL、activation v2、authorization lifecycle、legacy Portfolio retirement/export/delete 与 Claim V2 two-phase cutover。
- `npm audit --audit-level=high` 为 0 high / 0 critical；仍有 2 low / 22 moderate，不能表述为“零漏洞”。
- changed-file Prettier、OpenAPI YAML/Portfolio-export paths、`git diff --check`、新增内容 secret pattern scan、clean worktree、`origin/main` ancestry 与 production-generated `database.types.ts` 未改动均须在最后一次文档冻结后再次通过；交付报告记录其最终结果。

Git commit 不能在自己的内容中自引用其最终 SHA；因此 exact candidate SHA 由冻结后只读 `git rev-parse HEAD` 与本次交付报告绑定。任何后续 amend、rebase 或文件修改都会使本节证据失效，必须重新验证并重新记录。上述本地 green 不能替代 production migration、ACL、凭据轮换、恢复演练、48 小时排空或真实环境 smoke。

## 需要所有者提供的最小外部动作

这些动作涉及新的权限或秘密，自动化不能替代所有者：

1. 在 Supabase Dashboard 确认项目恢复，并轮换数据库密码。
2. 在 Vercel 先移除所有 Preview-scope production 高权限变量，改接 disposable staging；再撤销 1 个 automation 与 3 个 manual deployment-protection bypass，重新配置唯一受控自动化 secret，并提供旧值访问失败/新值受控成功的证据。
3. 提供至少约 100 GiB 可用空间的可销毁非生产 PostgreSQL 17 恢复目标；托管事故恢复后生成一份通过当前 completion metadata 与关键表正数门禁的新备份，07-26 对象只保留取证。
4. 在 staging 建立专用 disposable QA 用户、Hyperliquid/GMX claim trader fixture 与 payment canary fixture；只把 secret 写入受控 secret store。
5. 升级/调整 GitHub 仓库治理，使 `main` 具备 required PR/check protection；把所有 repository/organization 级 production secret 撤销并迁移为 environment-only 值，给 `Production`、`ingest-sg-production` 和新建的 `arena-staging-payment-canary` 配置第二位可信 reviewer、protected-main deployment policy、专用 staging project/fixture secrets，并清理 artifact quota。随后逐项恢复当前固定 `if: false` 的 workflow/job；不得批量解除。YAML 中写出 environment 名称本身不能证明保护规则已经存在。
6. 撤销/轮换暴露的 Brave key，清除失效 GitHub token 的 shell 注入，修复 Telegram 401；这些值不得继续由 `~/.zshrc` 注入所有子进程。
7. 确认可以通过受保护工作流部署本分支，而不是绕过 gate 直接推生产；在此之前不要 push，因为当前 Git integration 会自动生成具有高权限的 Preview。

在这些动作完成前，代码可以继续审查和测试，但不能诚实地声明生产已恢复、备份可恢复、认领 E2E 已通过或 V1 已上线。
