# Arena V1 邀请制 Beta 操作手册（2026-08-03）

## 目的与启动条件

Beta 只验证一个问题：用户能否借助 Arena 找到值得持续跟踪的交易员，并理解为什么可以或不可以相信这些数据。

以下条件全部满足前不发送邀请：

- `V1_EXECUTION_STATUS_2026-08-03.md` 记录的 current incident **NO-GO** 必须由 owner 明确解除；deploy-force、关闭 gate 或手工 promote 不能代替该决定。
- Mac mini 与 SG 的主机侧 ingest deploy hold 以及旧 orchestrator compatibility guard 必须仍保持 armed，直到 owner 在同一受控变更中核对全部发布证据并明确解除；任何直接 PM2 start/restart 都是 P0 事故复发，不是 canary。
- Vercel Preview 必须与 production secrets 完全隔离。Preview 不得持有 production `DATABASE_URL`、Supabase service role、Stripe secret、R2 credentials、`ENCRYPTION_KEY` 或其他高权限值；测试项目必须有独立的 disposable database、Stripe test mode 与受保护 GitHub environment。任意分支 Preview 继承生产权限时禁止 push 候选分支。
- GitHub 发布必须先具备原生 required PR/check/reviewer，或经独立审查确认的等效可审计 source-trust/reviewer 边界。`Production`、`ingest-sg-production` 与 `arena-staging-payment-canary` 已存在且只允许 exact `main`，repository 高敏 secrets 已删除，16 个 repository workflow 已 `disabled_manually`；Dependabot dynamic workflow 仍 active。GitHub Free 私有仓库对 main protection/ruleset 与 required reviewer 返回 403，当前也没有获准的等效边界。十三个 privileged production workflow 与 CI 两个 secret job 必须继续保持零 runner；任何 workflow 成功都不能替代该门禁。
- 核心 API 连续 24 小时成功，canonical LKG 已预热并完成一次故障降级演练。
- 每个公开榜单都能显示来源、新鲜度和最近完整发布证明；不可证明时明确 unknown/down。
- 登录、详情、收藏、关注、持久提醒至少在 desktop 与 iPhone 小屏完成一次真实写入/读取闭环。
- 必须先冻结完整 predeploy ordered baseline，对全部 `51` 个缺项逐项建立依赖、重放安全和 catalog 兼容证据；四个 ranking-authority 文件本身属于这 `51` 项。只有抵达各自在 manifest 中的位置且全部前序 exact、目标确认缺失、无 catalog 漂移时，才按 `20260729223000` → `20260729224000` → `20260729225000` → `20260729230000` 的顺序通过获准单文件通道补齐，并在同一维护窗口紧接着单独应用 `20260804043000_retire_legacy_token_rankings.sql`。不得在前四项与 retirement 之间触发 refresh、等待 cron 发布或开放 token 榜；最后一项把未绑定 authority snapshot 的旧 publication 整体 fail closed。无法访问、证据冲突或仅有 ledger 都不满足该条件；本手册不声称这些步骤当前已执行。
- 2026-08-04 的只读证据已经确认 production predeploy `114` 中有 `51 missing`，其中四个 ranking 文件和三个直接前序依赖均 missing/live fail；后继 `040430` 的 ledger/head/v2 reader 也不存在，旧 refresh 尚未退役；`20260716093000` 另有 ledger idempotency drift。必须按 ordered manifest 处理全部 `51` 项并独立裁决 drift，禁止跳到 ranking 文件、批量重放或手改 ledger。
- 三个 record/publication 核心 migration `20260803090000` → `20260803100000` → `20260803101000` 也全部 ledger/live missing；第一个文件的现有 records/copier RPC 哈希不满足 preflight，所以不能直接重放。完整 predeploy/ranking-retirement baseline 和该函数漂移独立闭合后，才可按顺序逐文件证明 provenance clocks、private publication chain 与 verified position-history writer。position-history artifact `@2` 可持久化，并可在锁定 RAW pointer 与重新验证下重放 acquisition/source facts；它尚无 production projection consumer，也没有 parser/rank receipt。候选 app/worker 不再调用 legacy `@1` publisher；exact bridge 排空后还必须按 `20260804041000` → `20260804042000` 单文件关闭 DB writer 与 records page，未有 parser-conservation receipt-bound projection 前不得重开，也不得把 v2 RAW 数量当作可发布或可排名数据。
- 进入 2026-08 阶段前，还必须用 production exact ledger 与 live ACL catalog 证明五个额外安全前置：`20260716093000_user_linked_traders_server_write_only.sql`、`20260716112000_exchange_connections_server_only.sql`、`20260716178000_user_profile_write_authority.sql`、`20260716179100_user_profile_read_audience.sql`、`20260716179200_user_profile_wallet_authority.sql`。linked-trader 表对 browser/PUBLIC 必须无 DML、authenticated 仅 own SELECT；connection 表对 browser/PUBLIC 必须无 table/column 路径；profile 身份与计数字段不能被 authenticated 更新。每个文件都须 exact ledger + live catalog 同时成立；缺失时只可在兼容基线上按时间顺序用获准单文件通道补齐，证据冲突即停止。这些文件不计入十五个核心产品 migration，任一未证明即 NO-GO。
- 上述排名权威、token-ranking retirement 和全部身份/凭据 ACL 门禁闭合后，staging 与 production 都必须按同一顺序完成：record provenance clocks → publication substrate → verified position-history writer → activation → 受保护部署同一个 exact bridge SHA 并排空 legacy position-history calls → legacy writer retirement → records-page quarantine → legacy Tier-A writer/queue 排空后单独应用 `20260729061000_tier_a_execution_claim_enforcement.sql` → authorization → legacy Portfolio retirement → Claim Phase A → 用该同一 SHA 完成成功 smoke → Claim Phase B。Tier-A postdeploy 当前 ledger missing、live marker 不存在；它不计入十五个核心 migration，必须另有 exact ledger/trigger/ACL/marker 证明。bridge 必须先证明旧 connect/bind/sync/OAuth 无条件固定 410，两个旧 ownership/wallet verify tombstone 为匿名 401、已登录 410 且没有凭据/proof/direct-table 路径；Portfolio 新建/同步/positions/snapshots 固定 410，旧 Portfolio snapshot cron 为认证 no-op，且新 authorize POST/Claim 写路径在 RPC 缺失时 fail closed。此时 Portfolio RPC 尚不存在，所以已认证 settings export 必须 500 fail closed，不得用省略 legacy Portfolio 的 200 部分导出冒充成功。Portfolio 行级 fixture 只在 staging 建立；production 零数据时验证 ACL/RPC 与完整空 manifest，不创建 disposable 行。Portfolio migration 必须证明 browser/PUBLIC 零 table/column 路径、service 只能直接读取五个 owner-cleanup metadata 列，export/delete RPC 仅 service 可执行；迁移后 settings export 必须返回 200 完整三项 manifest/owner rows，只导出已认证 owner 的严格白名单且无密文/跨 owner 数据，任一组超 250,000 行返回 413；owner delete 会级联 child 且失败回滚；迁移不改写现存密文。Phase A 没有批准能力；Phase B 后必须另证 canonical 管理员批准与原子 unlink。63 个已知 migration 缺口与全部十五个 production 核心 migration 的 exact proof 必须闭合，production types 必须来自迁移后的 production schema，而不是手写假定。
- staging 的 Hyperliquid/GMX 认领生命周期（包括 service-only 原子解绑）、支付测试路径和隔离备份恢复必须通过；所有 CEX trader-profile claim 均为 unsupported，API key 仅用于私有账户连接，不自动发布公共交易员数据。解绑 smoke 必须证明 claim 不再保持 verified 权威、badge/link/profile/Arena 投影一起撤销、任一后置写失败全部回滚；只有 exact identity mapping 才能同时停止 CEX credentials。
- 隔离恢复必须使用新鲜、带当前 completion metadata 且关键表正数的备份。2026-07-26 legacy 候选虽通过 gzip/SQL 结构检查，但没有 `leaderboard_ranks` COPY 数据，不能满足恢复门禁；20 字节空对象也绝不可选。
- exact bridge 已停止所有旧公开 first-party writer 至少 48 小时，并以只读查询证明 fresh `provenance='first_party'` 排名输入为零；授权 cron 必须是认证 no-op，scheduler 中不得残留 `fp:*` 作业。任何新鲜遗留第一方数据都按身份错误归属 P0 处理并停止 Beta。
- exact bridge cutoff 后重新 inventory 历史 `verified` claims 及其 badge/绑定/credential 投影；若仍为零，记录带时点的 `zero / N/A` 证明。只对届时非零行由 owner 逐行完成 retain/quarantine 审计；不得存在未决、无法证明或身份冲突的 badge。投影漂移或无法精确映射的 legacy credential 不得自动猜测，必须作为 NO-GO 项人工裁决。
- exact bridge cutoff 后重新 inventory 全部 `user_portfolios`；若仍为零，记录 `zero / N/A`。只对届时非零遗留行建立 owner/交易所清单和处置记录：owner 先下载包含 metadata/positions/snapshots 且不含密文的可移植数据，再在交易所侧 revoke/rotate 旧 key，并决定是否删除 Arena 副本；Arena 删除成功不会令交易所 key 自动失效。任何未联系、未轮换或归属不明的非零行都是 NO-GO。
- 所有旧 Vercel Deployment Protection bypass credentials 已撤销且项目 map 为零；其中一个旧值访问 generated deployment URL 已证明失败，其余三个只有配置归零证明。建立 protected source/reviewer 前不得重签；不能把 map 归零写成每个旧值均已逐值失效。
- 没有未处理的 P0/P1 数据错误、认证错误或凭据事故。

## 首批样本

首批 12–18 人，分两批进入，避免同一故障影响所有反馈：

- 5–7 名主动寻找交易员或跟单线索的用户。
- 4–6 名有公开榜单身份的交易员/KOL。只有预先核对为 Hyperliquid/GMX EVM 钱包身份时才安排 C1，目标至少 2 人；不足时记为 `not_applicable`，不得用 CEX/API key 替代。
- 3–5 名重视风险指标、会质疑数据来源的高级用户。

每周完成 5–10 次 30 分钟访谈。邀请不承诺收益、不承诺实时、不暗示可以直接跟单或执行交易。

## 每位参与者的真实任务

主持人只读任务，不提前解释按钮位置。

1. `D1 发现`：从 90D 榜单找出一名你愿意进一步研究的交易员，并说出选择理由。
2. `D2 信任`：指出该交易员的数据来源、更新时间、缺失字段、Arena Score 依据和一个你仍不信任的地方。
3. `D3 比较`：与另一名交易员比较，说明哪一位更适合你的风险偏好。
4. `T1 跟踪`：收藏或关注其中一人，第二天再次打开并找到该对象。
5. `T2 提醒`：建立一个真实提醒，确认系统只在保存成功后显示成功状态；测试者在后续验证通知是否送达。
6. `M1 移动端`：在手机完成榜单 → 详情 → 跟踪，不允许切换桌面端补救。
7. `C1 认领`：仅对预先确认的 Hyperliquid/GMX 榜单钱包执行；签名钱包必须与 trader identity 完全一致。完成登录、服务端 challenge 签名验证、进入人工审核、管理员批准、badge 展示与绑定后的个人页检查。V1 不支持任何 CEX trader-profile claim；API key 仅用于独立的账户连接，不是认领证明。

不要求参与者测试帖子、小组、市场、学习库、Token、对战或任何资金执行功能。

## 访谈问题

任务结束后按原话记录，不用功能建议代替问题：

1. 你认为 Arena 排的是“谁”？这个排名与收益榜有什么不同？
2. 哪个信息让你最信任？哪个信息最像营销说法？
3. 如果数据是 8 小时、48 小时或未知状态，你会如何改变决定？
4. 你下一次回来会检查什么？为什么今天的收藏/关注/提醒值得保留？
5. 哪一步让你不确定自己是否操作成功？
6. 你愿意为哪一个明确结果付费？不接受“更多数据”这类抽象答案，追问具体任务。
7. 如果明天不能再用 Arena，你会用什么替代？

## 每次会话记录模板

复制下面区块到受控访谈记录；不要记录 API key、钱包私钥、访问令牌或数据库密码。主持人不得索取、复制或保存 API key，C1 不使用 API key。

```text
session_id:
date_utc:
cohort: discovery | trader | advanced
device/browser:
new_or_existing_account:

D1: pass | assisted | fail ; duration_s:
D2: pass | assisted | fail ; duration_s:
D3: pass | assisted | fail ; duration_s:
T1: pass | assisted | fail ; duration_s:
T2: pass | assisted | fail | not_applicable ; duration_s:
M1: pass | assisted | fail | not_applicable ; duration_s:
C1: pass | assisted | fail | not_applicable ; duration_s:

trust_score_1_to_5:
would_return_for:
verbatim_problem:
issue_ids:
follow_up_owner/date:
consent_for_follow_up: yes | no
```

## 缺陷分级与处理规则

- `P0`：数据或身份错误归属、密钥/资金风险、越权、错误认证、会导致错误交易判断的伪新鲜数据。出现 CEX claim 入口、API key 创建 claim/badge、Hyperliquid/GMX 之外的钱包认领、已退役 connect/Portfolio 入口仍可写入或同步、重绑/断开留下单边 active credential、解绑后残留公开 verified 权威，或未审计历史 badge/ambiguous credential/legacy Portfolio key 也是 P0。立即停止 Beta。
- `P1`：榜单/详情/登录/跟踪/认领主任务无法完成，或 API 超过硬超时且无安全降级。24 小时内确定 owner 和修复/回滚。
- `P2`：任务可完成但需要主持人帮助，字段解释不清、移动端摩擦、提醒状态不明确。进入本周队列。
- `P3`：样式、偏好和非核心功能建议。只有在重复出现且不扩张 V1 范围时处理。

一条反馈必须包含复现路径、期望、实际、环境和证据。不能因为参与者提出某个功能就直接进入开发。

## 每周事实板

每周只报告可证明的数字，并标注 measurement epoch：

- 核心 API 成功率、P50/P95/P99、503 LKG 比例和无 LKG 失败数。
- 各公开来源 freshness/coverage、最近完整 90D publication 时间与被隔离来源。
- 新注册、WAU、activation eligible、activated 7d；eligible 少于 25 时只报分子/分母，不比较百分比趋势。
- `D1–T2` 每项独立完成率、需要帮助率和中位时长。
- 仅统计 V2 Hyperliquid/GMX wallet claims 的新认领、进入审核、批准、拒绝及失败原因；cutoff 后历史 verified 盘点单列，零行记录 `zero / N/A`，非零行才逐项审计，均不计作新 claim。
- 创建后仍存在的收藏/关注/提醒数；不把打开弹窗当提醒创建。
- 本周 P0/P1/P2 数、平均关闭时间和重复问题。

## Beta 继续、扩大与停止门槛

- **继续当前批次**：无 P0；P1 有 owner 和可验证回归；核心任务独立完成率至少 70%。
- **扩大到下一批**：至少 10 次完整会话，`D1`、`D2`、`T1` 各自独立完成率至少 80%，且参与者能用自己的话解释一个信任依据和一个限制。
- **测试一个 Pro 价值**：activation epoch 后至少有 25 个 eligible 用户，并且同一个高频任务在至少 5 次访谈中自然出现；一次只测试长历史、变动提醒、比较或导出中的一个。
- **停止并回到修复**：任何 P0、连续两次发布失败、公开事实与状态页不一致，用户无法区分“研究/跟踪”与“直接跟单/收益保证”，或 owner 重新宣布 incident NO-GO。

## 每周复盘输出

周复盘必须得出四个明确决定：

1. 本周最需要修的一个发现/判断/跟踪阻塞是什么？
2. 哪个假设被真实行为否定？
3. 下周保持不做的 V2/V3 功能是什么？
4. Beta 保持、扩大还是暂停？证据是什么？

未经上述证据，不把访问量、seed 内容浏览、页面数量或开发完成度当作产品验证。
