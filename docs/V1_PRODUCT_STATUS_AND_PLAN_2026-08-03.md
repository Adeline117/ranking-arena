# Arena V1 产品现状与计划（2026-08-03）

## 结论

Arena V1 应收敛为：**可信的跨交易所交易员发现、判断与持续跟踪产品**。赛季、对战、押注、Token、Vault、托管和交易执行不进入本轮发布。

仓库的功能面已经超过 V1。当前主要风险不是页面不够多，而是生产数据库依赖、排行榜读取、身份认证边界、真实用户测量和发布一致性尚未形成完整证据。因此本轮工作以收敛、可信度和可运营性为主，不继续扩张玩法。

本报告给出产品口径；实际完成状态、发布顺序和事故停止线以 [`V1_EXECUTION_STATUS_2026-08-03.md`](./V1_EXECUTION_STATUS_2026-08-03.md) 为准。

## 核查范围

本次核查覆盖：

- MacBook 上 Arena 的早期 PRD、V3/路线图、商业模式、数据规范、上线测试、GTM/Outreach 等不同阶段资料。
- 当前仓库的产品页、公开 API、认证/绑定、支付、数据管道、worker、迁移、监控、备份和历史审计资料。
- 2026-08-03 的生产只读抽检、托管服务状态、Vercel 发布状态、Mac mini/新加坡 worker 状态和最新可验证备份。

历史资料中存在不同统计口径，例如 34k/35+ 与 68k/44+。它们不能继续作为当前对外承诺；公开数字必须来自同一个带时间戳的运行事实源。

## 文档版本如何统一

| 阶段              | 主要主张                                                         | V1 处理                              |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------ |
| 早期 PRD          | 排行、详情、市场、搜索、用户、小组、帖子；先做公开数据与只读展示 | 作为功能底座                         |
| 风险管理/社区方案 | 认领、关注、告警、组合建议、Pro                                  | 只保留直接强化“发现—判断—跟踪”的部分 |
| V3/路线图         | 赛季、段位、1v1、悬赏、团战、押注、Chip、Token、Vault            | 放入未来独立立项，不进入 V1          |
| 商业模式/API      | Pro、数据 API、机构产品                                          | 后置于激活、留存与支付安全验证       |

`competitions` 已被产品决策删除。旧文档或残余概念不能自动恢复它；未来若重启，必须使用独立 V2 schema、结算和合规设计。

## 当前能力盘点

### V1 核心

| 能力                     | 当前判断                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨交易所排行榜           | 有 7D/30D/90D、筛选、排序和多来源实现；本轮已加入每窗口/分类 500 行 canonical 快照、5 分钟 live、24 小时 LKG、请求截止时间和发布 fence，但尚未部署到生产                                                                                                                                                                                            |
| Arena Score              | 现行公开口径是 ROI 60 + PnL 40 的 0–100 分，并有完整度、异常值和周期处理；旧版 85/8/7 公式不得再宣传                                                                                                                                                                                                                                                |
| 交易员详情               | 指标、曲线、持仓/历史、风险比率、来源链接、横向比较和认证展示已存在；必须明确来源、更新时间、覆盖率和缺失                                                                                                                                                                                                                                           |
| 数据管道与质量           | `arena.*` 规范数据层、抓取 worker、发布与异常监控已具备；position-history artifact `@2` 可持久化，并可在锁定 RAW pointer 与重新验证下重放 acquisition/source facts，但尚无 production projection consumer，不是 parser projection 或排名资格，legacy publisher 仍固定只接受 `@1`；运行指标必须以 freshness、coverage、完整 90D 发布证明和错误率为准 |
| 认领                     | V1 只支持 Hyperliquid、GMX 的同一 EVM 钱包 challenge 签名与人工审核；所有 CEX 档案认领均 unsupported；解绑通过 service-only 原子边界撤销公开权威                                                                                                                                                                                                    |
| 账户连接                 | CEX API key 仅保存为私有只读连接并支持用户手动刷新连接状态，不证明榜单身份、不创建 badge、也不自动发布第一方榜单数据；公开 picker 仅有 Binance/Bybit/Bitget。旧 connect、bind-api-key、trader sync 与 OAuth 三端点无条件 410；旧 ownership/wallet verify 为 auth-first（匿名 401、已登录 410）                                                      |
| 旧版投资组合凭据         | 旧 `/portfolio` CEX 凭据面在 V1 只保留 owner 元数据清单、可移植数据导出与删除；新建、同步、仓位和快照运行时读取固定 410，快照 cron 为认证 no-op。Arena 删除副本不会撤销交易所侧密钥，owner 仍须在交易所 revoke/rotate 旧 key                                                                                                                        |
| 收藏/关注/提醒           | 作为留存主线保留；事件只在真实持久化成功后计入激活                                                                                                                                                                                                                                                                                                  |
| 方法论、免责声明、状态页 | 作为信任基础保留，并统一读取同一产品事实与数据健康权威                                                                                                                                                                                                                                                                                              |

### 已实现但不是当前主线

- 帖子、评论、小组、私信、等级等社区能力：维持基本可用，不新增玩法。
- 市场、资金费率、持仓量、快讯：作为排行榜上下文与 SEO 入口。
- 学习库、原生端、四语、主题：保留已有资产，先保证 Web 核心路径。
- Pro、Stripe、推荐和数据 API：先完成 staging 支付/迁移/恢复演练，再测试单一明确价值。
- 合约、NFT 会员、copy-trade 配置：实验或后续能力，不包装为当前资金产品。

### 明确不进入 V1

- 赛季、LP、段位、1v1、擂台、悬赏、团战。
- 用户押注、Arena Chip、Token、预测市场。
- Vault、真实资金跟单、托管或交易执行。
- 未经用户验证的 API-first / 机构版转型。

## 真实运行现状

1. **生产当前 NO-GO。** 2026-08-03 末次复核时，Supabase 官方状态仍为部分降级，数据库项目升级延迟事故未解除。
2. **核心读取已恢复响应，但数据健康仍严重降级。** 2026-08-03 约 18:18 PT 的复核中，生产 `/api/health` 以 HTTP 202（8.84 秒）返回 `degraded`：API、database、Redis 为 pass，但 freshness 只有 `13/32` fresh、`19` critical，VPS 因无近期 heartbeat 为 skip。使用正确 `window` 参数的 `/api/rankings?window=90d&limit=1` 返回 200（1.18 秒），`/api/traders?timeRange=90D&limit=1` 返回 200（0.19–2.8 秒），`/api/hero-stats` 返回 200（0.35 秒）。错误地向 rankings 传 `timeRange` 得到 400 是参数校验，不是健康失败；“能返回 200”也不能覆盖 freshness/worker NO-GO。
3. **生产版本落后。** 当前 Vercel production 仍是 2026-07-21 的旧发布，不包含本轮代码。
4. **worker 已止损并加上主机侧门禁。** 两个 ingest worker 曾在本次 NO-GO 中被同一类已认证运维会话重新拉起；GitHub Actions 没有对应的 8 月 3 日 SG deploy run。Mac mini 与新加坡写入 worker现已再次停止并保存 PM2 状态，两台主机各自的 durable incident hold 与旧 orchestrator compatibility guard 均已 armed；不得在迁移与凭据门禁前直接 start/restart 或解除 hold。
5. **备份只有 gzip/通用 SQL 流完整的 legacy 候选，没有合格恢复点。** 2026-07-26 对象为 5,112,388,073 字节，已流式完成 gzip CRC/通用结束标记与 SHA-256 校验，展开后的 plain SQL 为 37,798,473,433 字节（35.2 GiB）并有事故保护副本；但两次扫描都没有 `leaderboard_ranks` 或其 partitions 的 COPY 数据，且 exact PG17 legacy restrict/unrestrict 尾尚未证明，预计会失败当前关键表 gate。Mac mini 仅约 8.1 GiB、MacBook 仅约 22 GiB 可用，也不足以容纳 SQL、heap/index/WAL 与临时空间；仍需新鲜合格备份与容量充足的可销毁 PostgreSQL 17 目标。
   两台主机上指向缺失脚本的旧 LaunchAgent 已 unload+disable，Mac mini 旧 03:30 backup 与 09:00 freshness cron 也已显式暂停；plist 与旧对象均保留，可在固定 ops SHA 与失败 canary 通过后恢复。
6. **凭据必须轮换。** 已暴露的数据库密码和 Vercel Deployment Protection bypass credentials 均不能继续信任。
7. **生产 migration 基线已只读证明为严重落后且有 ledger/live drift。** 已知共有 `60` 个缺口：完整 launch predeploy manifest 为 `114` 中 `63 exact / 51 missing`；四个 2026-07 ranking-authority migration 全部 ledger missing + live fail，且其更早依赖 `20260724235000`、`20260728124000`、`20260729065000` 也 missing。三个 record/publication migration `20260803090000` → `20260803100000` → `20260803101000` 全部 ledger/live missing，第一个文件要求的 records/copier RPC 哈希又与生产现状不匹配，因此不能直接重放。五个身份/凭据 ACL 前置中四个 exact + live pass；`20260716093000` 的 body/name/creator 与 live ACL 正确，但 idempotency key drift，属于禁止重放/手改 ledger 的冲突。postdeploy `20260729061000_tier_a_execution_claim_enforcement.sql` 也 ledger missing 且 live marker 不存在；它只能在兼容应用已上线、legacy Tier-A writer/queue 排空后单独执行。五个较晚的 activation/authorization/Portfolio/Claim migration 也全部 ledger missing + live fail。不能直接“补四个 ranking 文件”或三个 record 文件，必须先重建完整 ordered baseline 并单独裁决 drift。
8. **历史认证须在 cutoff 后重新盘点。** 当前 verified/projection/credential 聚合均为零，因此本次记录为带时点的 `zero / N/A`，没有待逐行裁决对象。新 Claim V2 会阻止旧证明重新激活；若 cutoff 后盘点出现非零行，owner 才须逐行决定既有 `verified` 行和 badge 投影是否保留，并裁决无法精确对应的 legacy credential mapping。
9. **历史第一方公开数据必须排空。** 新 bridge 不再从账户绑定排队公开 first-party 作业，授权 cron 变为认证 no-op，遗留队列也必须通过 exact reviewed V2 API-key identity 映射才会解密或发布；V1 不会产生这种 CEX claim。既有 `provenance='first_party'` 排名输入最多可存活 48 小时，因此 bridge/旧 worker 截止后必须等待至少 48 小时，并用只读查询证明没有 fresh first-party 公开输入，之后才可重算榜单或开放 Beta。
10. **旧版投资组合凭据尚未完成生产退役。** `20260803212000_legacy_portfolios_v1_retirement.sql` 只有仓库实现和隔离测试，尚无 production exact ledger/live ACL/RPC 证明。迁移只封闭 Arena 内的读取/写入并保留 owner 清理能力，不会撤销交易所侧 API key；exact bridge cutoff 后必须重新 inventory，只有届时存在的 `user_portfolios` owner 才需完成通知、交易所侧 revoke/rotate 和 Arena 副本删除/保留裁决，非零未决行维持 NO-GO。
11. **当前没有安全 staging。** Vercel 主项目的任意分支 Preview 仍继承多类 production 高权限变量并存在 4 个 Deployment Protection bypass；两个测试项目没有环境变量、没有 Git 连接且最近部署失败。移除/轮换 Preview 高权限值、撤销旧 bypass 并建立 disposable staging 之前，候选分支禁止 push。
12. **当前 legacy 清理计数为零。** 只读生产聚合确认 Portfolio/child/credential、claims/verified/projections、first-party stats/snapshots、active authorization/connection、claimed Arena traders 与 `fp:*` cron 全为 0。当前没有 owner 通知或历史 badge 裁决工作量，但旧权限仍开放；exact bridge cutoff 后必须重新开始 48 小时排空并再次核对，不能把本次零值永久化。
13. **生产自动化已在本地候选中 fail closed，线上尚未同步。** 十三个 privileged production workflow 与 CI 两个 production-secret job 已固定为零 runner，其中包括 backup、OpenClaw sentinel、health/deploy-freshness monitor 与 worker-image jobs；所有任意-ref dispatch 已移除，action 固定 full SHA，PR 构建没有 production secret、cache 或后置写 action。脚本自身 fail closed 不是未保护源码的信任边界。当前 GitHub token 无效且候选不能安全 push，所以线上 workflow 仍 active；owner 必须先在控制面停用线上 workflow、把 production secret 迁入 required-reviewer environments并保护 main，再逐项恢复，而不是依赖 PR 内可修改的 `if` 条件。

## V1 成功定义

北极星指标固定为：

> 新注册用户在注册后的精确 7×24 小时内看过交易员详情，并完成一次真实持久化的收藏、关注或交易员提醒；符合条件的事件至少发生在两个不同 UTC 日期。

配套指标：核心 API 成功率与 P95、各来源 freshness/coverage、完整 90D 发布证明、认领完成数、首周留存、收藏/关注/提醒创建率。DAU、帖子浏览量和 seed 内容浏览量不能替代上述产品行为。

## 执行计划

### 阶段 0：范围与事实源（已完成）

- 冻结 V1；统一 About、Methodology、Status、Health 和四语口径。
- 建立执行状态、Beta 操作手册和事故 NO-GO。

### 阶段 1：代码与安全收敛（代码就绪）

- 排行榜 canonical live/LKG、发布 fence、总截止时间和明确分页契约。
- freshness、coverage、最近完整 90D 发布证明与状态页 fail-closed。
- activation v2 epoch、首页 heartbeat 和真实持久提醒事件。
- authorization 以 service-only RPC 原子维护 `user_exchange_connections` 与 `trader_authorizations`：同 canonical exchange 重绑撤销旧 active authorization，按 exchange 与按 authorization ID 的撤销都会关闭两张投影，任一写失败整单回滚；旧 `/api/exchange/connect`、`/api/trader/bind-api-key`、`/api/trader/sync` 与 OAuth authorize/callback/refresh 无条件固定 410，UI 不展示 OAuth，公开绑定来源收敛为 Binance/Bybit/Bitget。旧 `/api/exchange/verify-ownership` 和 `/api/traders/claim/verify-wallet` 为 auth-first tombstone：匿名 401、已登录 410，且不读取凭据、消费 proof 或 direct-table 写入。绑定只保存私有账户连接，不排队或发布公共第一方榜单数据；authorization-wide scheduler 已移除，遗留作业在没有 exact reviewed V2 API-key identity mapping 时于解密前 fail closed。迁移会隔离 legacy alias、OAuth 或缺少 attestation 的 active connection，并撤销没有 exact canonical connection 支撑的 authorization；这些账户必须由用户显式 rebind，不能自动提升旧记录。Claim V2 提供 server-issued challenge、typed RPC、旧写路径切断和 service-only 原子 unlink；unlink 同步撤销 exact verified/link/profile/Arena 权威，只在身份映射可证明时停止 CEX credentials，投影漂移 fail closed。
- 退役第二套旧版投资组合凭据面：bridge 先固定 410 新建/同步/仓位/快照能力并把快照 cron 改为认证 no-op；随后 migration 撤销 browser/PUBLIC 全部 table/column 路径，仅允许 service role 读取 owner 清理所需的五个元数据列，并提供 service-only `export_legacy_portfolio_data_v1` 与 owner-filtered delete RPC。因为同一个 bridge SHA 先于 migration 部署，迁移前已认证 `/api/settings/export` 必须 500 fail closed，不能静默漏掉 Portfolio 后返回 200；迁移后才须以 200 返回完整三项 manifest/owner rows，超限返回 413。route 只传已认证 user id，以严格白名单导出该 owner 的 metadata、positions、snapshots，绝不返回 user id、跨 owner 数据或 API key 密文。密文原样保留到 owner 删除。
- rollback-only staging 支付 canary、备份/恢复 fail-closed 测试和供应链高危清零。

### 阶段 2：恢复与发布（外部依赖阻塞）

严格按以下顺序执行，任何一步失败即停止：

1. 托管事故恢复，验证 Auth、REST、pooler。
2. 轮换数据库和全部旧 Vercel bypass 凭据，并证明旧值失效。
3. 托管事故恢复后生成带当前 completion metadata、通过完整流校验且关键表为正数的新备份；只把这份合格对象恢复到隔离 PostgreSQL 17 并记录 RTO。2026-07-26 保护副本只用于结构取证，不能作为恢复基线。
4. 冻结 production 完整 launch manifest/ledger/live catalog 快照，先对 51 个 predeploy 缺项做依赖与重放安全分析；为每个需要的缺项建立 ADR-023 单文件记录。不能从四个 ranking migration 跳着开始，更不能批量 `db push`。
5. 单独裁决 `20260716093000` idempotency drift：保留 name/body/creator 与 live ACL pass 证据，查明 ledger key 来源；在独立审查闭合前禁止重放文件或修改 ledger。其余四个身份/凭据 ACL 前置保持 exact + live 证明。完整前序 baseline 闭合后，ranking 顺序仍固定为 `20260729223000` → `20260729224000` → `20260729225000` → `20260729230000`。
6. 排名权威与全部身份/凭据 ACL 前置门禁闭合、`0900` 函数漂移独立裁决后，staging 先按 `20260803090000` → `20260803100000` → `20260803101000` 单独应用并证明 record provenance/publication/writer 链，再单独应用 activation，然后通过受保护管线部署 exact bridge SHA；在 authorization、Portfolio retirement 与 Claim Phase A 尚不存在时，先证明旧 connect/bind/sync/OAuth 无条件固定 410，两个旧 ownership/wallet verify tombstone 为匿名 401、已登录 410 且没有凭据/proof/direct-table 路径。另证明 `POST /api/portfolio`、`POST /api/portfolio/sync`、`GET /api/portfolio/positions`、`GET /api/portfolio/snapshots` 固定 410，portfolio snapshot cron 为认证 no-op，新的 authorize POST/Claim 写路径因 RPC 缺失而 fail closed、没有 direct-table fallback。Portfolio RPC 此时尚不存在，所以已认证 settings export 必须返回 500，不能以缺少 legacy Portfolio 数据的部分 manifest 返回 200。兼容应用已服务且 legacy Tier-A writer/queue 排空后，单独应用并证明 missing postdeploy `20260729061000_tier_a_execution_claim_enforcement.sql`；它不属于十二个核心 migration，也不得并入 predeploy。保持同一 SHA，随后逐文件应用 authorization → `20260803212000_legacy_portfolios_v1_retirement.sql` → Claim Phase A，再完成成功 smoke。Portfolio 行级 fixture 只在 staging 建立；production 若 bridge-cutoff inventory 仍为零，只验证 ACL/RPC 与完整空 manifest，不创建 disposable 行。staging smoke 必须证明 browser/PUBLIC 对三张旧表无 table/column 路径，service 只能直接读取五个 metadata 列、不能直接读取密文/positions/snapshots；export/delete RPC 仅 service 可执行；迁移后 settings export 必须返回 200 完整三项 manifest/owner rows，只含认证 owner 的严格白名单且无密文/跨 owner 数据，任一组超过 250,000 行返回 413；owner 删除 parent 时 child 级联且失败整单回滚；迁移不改写现存行或密文。
7. Phase A 后先完成 Hyperliquid/GMX challenge → submit → review → reject/cancel smoke；Phase A 明确没有批准能力，legacy 与 V2 approval 都必须 fail closed。之后才单独应用 Phase B，并证明 canonical `activate_trader_claim_v2` 的管理员批准、badge/link/profile/Arena 投影与 service-only unlink 全生命周期；unlink 任一后置失败全部回滚，保留投影漂移或无法精确映射的 legacy credential 不得猜测。
8. production 通过 ADR-023 获准通道重复同一顺序：record provenance clocks → publication substrate → verified position-history writer → activation → 受保护管线部署 staging 已证明的同一个 exact bridge SHA 并完成全部 retirement/fail-closed smoke → 排空 legacy Tier-A writer/queue 后单独应用 missing postdeploy → authorization → Portfolio retirement → Claim Phase A → 保持同一 SHA 完成成功 smoke → Claim Phase B。重复 record publication chain、Tier-A marker/trigger/ACL、authorization 生命周期、Portfolio ACL/数据保留/owner delete cascade、Claim approval/unlink/rollback smoke。五个额外身份/凭据 ACL 前置、60 个已知缺口与全部十二个核心 migration 的 exact ledger/live proof 闭合后，再从生产生成 `database.types.ts`。
9. Web/LKG canary、cutoff 后历史 verified/ambiguous credential 盘点（零行记录 `zero / N/A`，仅非零行逐项审计）、staging 支付 canary；从 exact bridge/旧 worker 写入截止时刻起等待至少 48 小时，并证明 `provenance='first_party'` 的 fresh 公开排名输入为零后才重算/开放榜单。
10. 单 worker canary、完整调度周期观察、Mac mini 扩容、新加坡最后恢复。
11. 本地候选中的 GitHub backup/sentinel jobs 保持固定停用，owner 也须在 GitHub 控制面停用仍在线的 schedule；只在 protected main、reviewed environment 与新凭据就绪后逐项恢复。核心 API/freshness 连续 24 小时绿色后，owner 才解除 NO-GO。

### 阶段 3：小规模 Beta

- 分批邀请活跃交易者、跟踪用户和交易员/KOL，用真实任务测试排行、详情、收藏/提醒与认领。
- 每周访谈 5–10 人；只修复阻碍“我为什么信这个排名、接下来跟踪谁”的问题。
- 达到 Beta 手册阈值后，一次只测试一个 Pro 价值，不扩写 V2/V3 功能。

## 所有者需要完成的最小动作

1. 在 Supabase Dashboard 确认事故恢复并轮换数据库密码。
2. 清除 Vercel Preview 的 production 高权限变量，接入 disposable staging；撤销并轮换全部 Vercel Deployment Protection bypass credentials。
3. 提供至少约 100 GiB 可用空间的可销毁非生产 PostgreSQL 17 恢复目标，并在事故恢复后生成一份通过当前 completion/关键表门禁的新备份。
4. 在 staging 建立专用 Hyperliquid/GMX claim 与 payment disposable fixtures。
5. 为 GitHub `main` 建立 required PR/check protection；撤销 repository/organization 级 production secrets，把新值迁入 `Production`、`ingest-sg-production` 与新建的 `arena-staging-payment-canary`，配置第二位可信 reviewer、protected-main policy 和独立 staging secrets，清理 artifact quota，再逐项恢复已暂停的 workflow/job。
6. 在 exact bridge writer cutoff 后重新查询 `user_portfolios` 与 credential aggregates；本次计数为零，只有届时出现 owner 行才导出元数据、通知 owner 下载并在交易所侧撤销/轮换旧 key。Arena 删除 RPC 的成功证据不能代替交易所侧撤销证据。

在这些证据闭合前，代码可以称为 **CODE-READY**，不能称为已上线、已迁移或可开放 Beta。
