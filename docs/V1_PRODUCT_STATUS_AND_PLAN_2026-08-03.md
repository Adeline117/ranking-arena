# Arena V1 产品现状与计划（2026-08-03）

## 结论

Arena V1 应收敛为：**可信的跨交易所交易员发现、判断与持续跟踪产品**。赛季、对战、押注、Token、Vault、托管和交易执行不进入本轮发布。

仓库的功能面已经超过 V1。当前主要风险不是页面不够多，而是生产数据库依赖、排行榜读取、身份认证边界、真实用户测量和发布一致性尚未形成完整证据。因此本轮工作以收敛、可信度和可运营性为主，不继续扩张玩法。

本报告保留 2026-08-03 的产品口径；实际完成状态、发布顺序和事故停止线以 [`V1_EXECUTION_STATUS_2026-08-04.md`](./V1_EXECUTION_STATUS_2026-08-04.md) 为准。后续证据已修正 Token 止损、恢复对象内容与 migration inventory，正文中的历史计数不得直接用于执行。

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

| 能力                     | 当前判断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 跨交易所排行榜           | 有 7D/30D/90D、筛选、排序和多来源实现；本轮已加入每窗口/分类 500 行 canonical 快照、5 分钟 live、24 小时 LKG、请求截止时间和发布 fence，但尚未部署到生产                                                                                                                                                                                                                                                                                                                                                                                                           |
| Arena Score              | 现行公开口径是 ROI 60 + PnL 40 的 0–100 分，并有完整度、异常值和周期处理；旧版 85/8/7 公式不得再宣传                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 交易员详情               | 指标、曲线、持仓/历史、风险比率、来源链接、横向比较和认证展示已存在；必须明确来源、更新时间、覆盖率和缺失                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 数据管道与质量           | `arena.*` 规范数据层、抓取 worker、发布与异常监控已具备；position-history artifact `@2` 可在锁定 RAW pointer 与重新验证下重放 acquisition/source facts，但尚无 production projection consumer，也不是 parser projection 或排名资格。候选 app/worker 已停止调用 legacy `@1` publisher，records/Tier-C/maintenance 的旧 RPC/cursor/partition/prune 均已固定零调用，并把遗留 history 的 data/API/cache/UI 读取收敛为 empty/unknown；`040440`/`040410`/`040420` 待冻结 public relation、关闭 DB writer/RPC，无 parser-conservation receipt-bound projection 前不得重开 |
| 认领                     | V1 只支持 Hyperliquid、GMX 的同一 EVM 钱包 challenge 签名与人工审核；所有 CEX 档案认领均 unsupported；解绑通过 service-only 原子边界撤销公开权威                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 账户连接                 | CEX API key 仅保存为私有只读连接并支持用户手动刷新连接状态，不证明榜单身份、不创建 badge、也不自动发布第一方榜单数据；公开 picker 仅有 Binance/Bybit/Bitget。旧 connect、bind-api-key、trader sync 与 OAuth 三端点无条件 410；旧 ownership/wallet verify 为 auth-first（匿名 401、已登录 410）                                                                                                                                                                                                                                                                     |
| 旧版投资组合凭据         | 旧 `/portfolio` CEX 凭据面在 V1 只保留 owner 元数据清单、可移植数据导出与删除；新建、同步、仓位和快照运行时读取固定 410，快照 cron 为认证 no-op。Arena 删除副本不会撤销交易所侧密钥，owner 仍须在交易所 revoke/rotate 旧 key                                                                                                                                                                                                                                                                                                                                       |
| 收藏/关注/提醒           | 作为留存主线保留；事件只在真实持久化成功后计入激活                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 方法论、免责声明、状态页 | 作为信任基础保留，并统一读取同一产品事实与数据健康权威                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

1. **生产当前 NO-GO。** Supabase 托管事故、生产健康与 provider incident 的最新带时点证据统一以 [`V1_EXECUTION_STATUS_2026-08-04.md`](./V1_EXECUTION_STATUS_2026-08-04.md) 为准；一次 HTTP/DB 读取恢复不能覆盖 pooler、freshness、worker 或迁移门禁。
2. **核心读取能响应不代表数据健康。** 最新 `/api/health`、rankings/traders 探针、freshness 分布与 production commit 统一由执行状态文档记录；错误参数返回 400 是契约校验，但正确请求返回 200 也不能覆盖 freshness/worker NO-GO。
3. **生产版本仍落后，但 legacy token 榜已独立止损。** production exact containment SHA `5ed4718b67ad78c42fd919dfe1f6508221893916` 已令 token detail/popular API 固定 503、页面 unavailable/noindex、导航与 sitemap 不再暴露入口。任何 ranking DB 写入前都必须重新取得 API/page/cache negative proof并持续到 `040430` exact；当前 schema-coupled 整分支不能替代或重新开放该止损。
4. **worker 已止损并加上主机侧门禁。** 两个 ingest worker 曾在本次 NO-GO 中被同一类已认证运维会话重新拉起；GitHub Actions 没有对应的 8 月 3 日 SG deploy run。Mac mini 与新加坡写入 worker现已再次停止并保存 PM2 状态，两台主机各自的 durable incident hold 与旧 orchestrator compatibility guard 均已 armed；不得在迁移与凭据门禁前直接 start/restart 或解除 hold。
5. **备份仍没有合格恢复点。** 2026-07-26 对象为 5,112,388,073 字节并有事故保护副本；PostgreSQL 17.8 部分恢复已实际得到 `public.leaderboard_ranks=41760`，推翻了早期文本扫描的“没有 leaderboard 数据”判断。但恢复因磁盘容量不足在 COPY 阶段终止，完整流尾、索引、RLS/Auth 和应用 smoke 未完成。2026-08-05 再次核对时 Mac mini 仅约 2.7 GiB、MacBook 约 29 GiB 可用，仍需至少约 100 GiB 的可销毁 PostgreSQL 17 目标。
   两台主机上指向缺失脚本的旧 LaunchAgent 已 unload+disable，Mac mini 旧 03:30 backup 与 09:00 freshness cron 也已显式暂停；plist 与旧对象均保留，可在固定 ops SHA 与失败 canary 通过后恢复。
6. **provider 凭据轮换仍未闭合，控制面撤销已完成。** 数据库密码、Brave 等旧值仍须在各 provider 轮换并证明失效；Vercel 4 个 Deployment Protection bypass 已全部撤销、当前 count 为 `0`。新的 Telegram token/chat-id 已写入 Vercel Production 与 GitHub repository secrets，provider 身份检查返回 200，但尚无真实 `sendMessage` 投递证明；所有 repository-defined workflow 继续禁用。删除或替换 secret-store 副本不等于所有 provider 旧值已经失效。
7. **生产 migration 基线已只读证明为严重落后且有 ledger/live drift。** 历史 fail-closed 快照口径为 `64 gaps`：当时 launch predeploy manifest 为 `114` 中 `63 exact / 51 missing`；当前仓库 manifest 已增至 122 项，新增 8 项未与同一 live 快照对账，因此当前精确缺项数未知，不能沿用 64 或直接相加。历史证据仍确认四个 2026-07 ranking-authority migration 全部 ledger missing + live fail，且其更早依赖 `20260724235000`、`20260728124000`、`20260729065000` 也 missing。它们的直接后继 `20260804043000_retire_legacy_token_rankings.sql` 也 ledger/live missing：production 没有 publication head 或 v2 reader，旧 refresh 仍存在且尚未变成 fail-closed retirement stub。六个 record/publication/retirement/freeze migration 缺完整 production proof：基础链 `20260803090000` → `20260803100000` → `20260803101000` 的首文件与生产 records/copier RPC 哈希漂移；`040410`/`040420` 已只读确认 ledger/live missing/fail；新 `20260804044000_freeze_legacy_position_history_relations.sql` 晚于快照且没有 apply 证据，仍须 exact ledger/live catalogue 复核。只有部署 exact RAW-only/fail-closed bridge 并排空 web/cron/worker/queue/在途事务后，才可先冻结 public legacy relations，再关闭 arena writer 和 records page。五个身份/凭据 ACL 前置中四个 exact + live pass；`20260716093000` 的 body/name/creator 与 live ACL 正确，但 idempotency key drift，属于禁止重放/手改 ledger 的冲突。postdeploy `20260729061000_tier_a_execution_claim_enforcement.sql` 也 ledger missing 且 live marker 不存在；它只能在兼容应用已上线、legacy Tier-A writer/queue 排空后单独执行。五个较晚的 activation/authorization/Portfolio/Claim migration 也全部 ledger missing + live fail。不能直接“补四个 ranking 文件”、跳过 token-ranking retirement 或把六个 record/publication/retirement/freeze 文件当批次重放，必须先重建完整 ordered baseline并单独裁决 drift。
8. **历史认证须在 cutoff 后重新盘点。** 当前 verified/projection/credential 聚合均为零，因此本次记录为带时点的 `zero / N/A`，没有待逐行裁决对象。新 Claim V2 会阻止旧证明重新激活；若 cutoff 后盘点出现非零行，owner 才须逐行决定既有 `verified` 行和 badge 投影是否保留，并裁决无法精确对应的 legacy credential mapping。
9. **历史第一方公开数据必须排空。** 新 bridge 不再从账户绑定排队公开 first-party 作业，授权 cron 变为认证 no-op，遗留队列也必须通过 exact reviewed V2 API-key identity 映射才会解密或发布；V1 不会产生这种 CEX claim。既有 `provenance='first_party'` 排名输入最多可存活 48 小时，因此 bridge/旧 worker 截止后必须等待至少 48 小时，并用只读查询证明没有 fresh first-party 公开输入，之后才可重算榜单或开放 Beta。
10. **旧版投资组合凭据尚未完成生产退役。** `20260803212000_legacy_portfolios_v1_retirement.sql` 只有仓库实现和隔离测试，尚无 production exact ledger/live ACL/RPC 证明。迁移只封闭 Arena 内的读取/写入并保留 owner 清理能力，不会撤销交易所侧 API key；exact bridge cutoff 后必须重新 inventory，只有届时存在的 `user_portfolios` owner 才需完成通知、交易所侧 revoke/rotate 和 Arena 副本删除/保留裁决，非零未决行维持 NO-GO。
11. **当前仍没有已证明的安全 staging。** Vercel generic Preview/Development 高权限变量已清零、4 个 bypass 已撤销、Git integration 已断开且 BUILDING/QUEUED 为零；但精确绑定 `refactor/repository-boundaries-20260803` 的 Preview Supabase override 尚未证明指向 disposable 非生产项目。隔离动作已完成，不等于 staging 数据、fixture、source trust 与 smoke 已完成。
12. **当前 legacy 清理计数为零。** 只读生产聚合确认 Portfolio/child/credential、claims/verified/projections、first-party stats/snapshots、active authorization/connection、claimed Arena traders 与 `fp:*` cron 全为 0。当前没有 owner 通知或历史 badge 裁决工作量，但旧权限仍开放；exact bridge cutoff 后必须重新开始 48 小时排空并再次核对，不能把本次零值永久化。
13. **生产自动化已双层 fail closed，治理能力仍阻塞恢复。** 候选中的十三个 privileged production workflow 与 CI 两个 production-secret job 固定为零 runner；所有任意-ref dispatch 已移除，action 固定 full SHA，PR 构建没有 production secret、cache 或后置写 action。2026-08-05 控制面漂移曾把 15 个 repository-defined workflow 重新启用；最新定时 run 因 GitHub 账单限制以 0 steps 失败，未执行 job，但这不是安全门禁。它们已再次禁用；现在 17 个 repository-defined workflow 全部 `disabled_manually`、non-completed run 为零，仅 Dependabot dynamic workflow active。10 个旧高敏 secrets 已删除，随后为未来告警重新写入两个 Telegram repository secrets；尚无真实消息投递证明。`Production`、`arena-staging-payment-canary`、`ingest-sg-production` 均只允许 exact `main`，但 GitHub Free 私有仓库对 main protection/ruleset 和 required reviewer 返回 403，且不得公开，所以 workflow 恢复仍 BLOCKED。

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
- position-history 旧 publisher 调用与已知 legacy data/API/cache/UI 读取在候选中收敛为 fail closed；records 层在 PostgREST 前固定返回空页，Tier-C position acquisition 固定 null cursor，worker maintenance 也已把 `position_history` 从动态 partition/prune 集合移除，并以隔离单测锁定旧 RPC/cursor/maintenance 零调用。exact bridge 与全调用/事务排空后，数据库先用 `040440` 冻结 `public.trader_position_history`/`tph_*` legacy relations 和分区创建器，再以 `040410` 保留审计链但关闭 arena writer，最后由 `040420` 把旧 records projection 固定为 empty/unknown。无 parser-conservation receipt-bound projection 前不恢复。
- activation v2 epoch、首页 heartbeat 和真实持久提醒事件。
- authorization 以 service-only RPC 原子维护 `user_exchange_connections` 与 `trader_authorizations`：同 canonical exchange 重绑撤销旧 active authorization，按 exchange 与按 authorization ID 的撤销都会关闭两张投影，任一写失败整单回滚；旧 `/api/exchange/connect`、`/api/trader/bind-api-key`、`/api/trader/sync` 与 OAuth authorize/callback/refresh 无条件固定 410，UI 不展示 OAuth，公开绑定来源收敛为 Binance/Bybit/Bitget。旧 `/api/exchange/verify-ownership` 和 `/api/traders/claim/verify-wallet` 为 auth-first tombstone：匿名 401、已登录 410，且不读取凭据、消费 proof 或 direct-table 写入。绑定只保存私有账户连接，不排队或发布公共第一方榜单数据；authorization-wide scheduler 已移除，遗留作业在没有 exact reviewed V2 API-key identity mapping 时于解密前 fail closed。迁移会隔离 legacy alias、OAuth 或缺少 attestation 的 active connection，并撤销没有 exact canonical connection 支撑的 authorization；这些账户必须由用户显式 rebind，不能自动提升旧记录。Claim V2 提供 server-issued challenge、typed RPC、旧写路径切断和 service-only 原子 unlink；unlink 同步撤销 exact verified/link/profile/Arena 权威，只在身份映射可证明时停止 CEX credentials，投影漂移 fail closed。
- 退役第二套旧版投资组合凭据面：bridge 先固定 410 新建/同步/仓位/快照能力并把快照 cron 改为认证 no-op；随后 migration 撤销 browser/PUBLIC 全部 table/column 路径，仅允许 service role 读取 owner 清理所需的五个元数据列，并提供 service-only `export_legacy_portfolio_data_v1` 与 owner-filtered delete RPC。因为同一个 bridge SHA 先于 migration 部署，迁移前已认证 `/api/settings/export` 必须 500 fail closed，不能静默漏掉 Portfolio 后返回 200；迁移后才须以 200 返回完整三项 manifest/owner rows，超限返回 413。route 只传已认证 user id，以严格白名单导出该 owner 的 metadata、positions、snapshots，绝不返回 user id、跨 owner 数据或 API key 密文。密文原样保留到 owner 删除。
- rollback-only staging 支付 canary、备份/恢复 fail-closed 测试和供应链高危清零；不安全的通用 secret rotation 脚本已退役为固定退出码 `2`，provider 轮换改走 owner-supervised atomic runbook。

### 阶段 2：恢复与发布（外部依赖阻塞）

严格按以下顺序执行，任何一步失败即停止：

1. 托管事故恢复，验证 Auth、REST、pooler。
2. 完成数据库、Brave、Telegram 等 provider 轮换和旧值失效证明；Vercel bypass 撤销已完成并保持 count 为零，在 protected source/reviewer 能力建立前不重签。
3. 在至少约 100 GiB 的独立 PostgreSQL 17 restore target 先完整认证受保护的 2026-07-26 legacy 对象，完成 stream CRC/tail、表/索引/约束、RLS/Auth、关键行数与应用只读 smoke，作为事故/历史恢复证据。
4. 托管事故恢复后再生成带当前 completion metadata、通过完整流校验且关键表为正数的新备份；把它恢复到隔离 PostgreSQL 17 并记录 launch RPO/RTO。新备份不能替代第 3 步，legacy 认证也不能替代当前备份。
5. 取得项目 CA 与专用只读 5432 URL，用已评审 capture scaffold 取得 source witness；构造 `candidate/not-deployable` canonical baseline，在两个独立空白 managed PG17 project 完整重放并与 source catalogue/ledger 等价核对，再让 Preview 从空环境完整通过。不得修改 `00008`、增加倒序 prerequisite 或做 ledger surgery。
6. 维持已完成的独立 token-surface containment：覆盖 custom domain 与全部别名的 detail/popular API、index/detail 页面、导航和 sitemap；API 固定 503、无排名数据、`private/no-store`，页面零旧榜 fetch，服务端零 Supabase/Redis 调用，并从两个网络点重新证明旧 public cache 不可命中。该门禁从任何 ranking DB 写入前持续到 `040430` exact；当前整分支不能替代或重新开放止损。
7. 用当前 122 项 predeploy manifest 重新冻结 production ledger/live catalogue 快照并计算精确缺项，同时逐项裁决 5 个缺失 RPC 与 101 个 advisory migration 候选；对每个实际缺项做依赖与重放安全分析，为每个需要的缺项建立 ADR-023 单文件记录。历史 51/64 计数只能作为下界，不能从四个 ranking migration 跳着开始，更不能批量 `db push`。
8. 单独裁决 `20260716093000` idempotency drift：保留 name/body/creator 与 live ACL pass 证据，查明 ledger key 来源；在独立审查闭合前禁止重放文件或修改 ledger。其余四个身份/凭据 ACL 前置保持 exact + live 证明。完整前序 baseline 闭合后，ranking 顺序固定为 `20260729223000` → `20260729224000` → `20260729225000` → `20260729230000` → `20260804043000`；最后一项是依赖前四项 exact predecessor 的 token-ranking retirement，不得按文件时间跳到其他 2026-08 migration 后执行。
9. 排名权威、token-ranking retirement 与全部身份/凭据 ACL 前置门禁闭合、`0900` 函数漂移独立裁决后，staging 先按 `20260803090000` → `20260803100000` → `20260803101000` 单独应用并证明 record provenance/publication/writer 基础链，再单独应用 activation，然后通过受保护管线部署 exact RAW-only/fail-closed bridge SHA。此时先证明旧 connect/bind/sync/OAuth 与 Portfolio 四入口均退休、ownership/wallet verify 为 auth-first tombstone、新 authorize/Claim 写路径因 RPC 缺失 fail closed、settings export 因 Portfolio RPC 缺失返回 500；同时证明 app/worker/maintenance 不再调用 legacy position-history publisher/partition/prune，所有 data/API/warm-cache/UI 历史读面为 empty/unknown。保持两节点 worker 停止并排空 web/cron/worker/queue/分区创建器调用与已进入事务后，按 ADR-023 先单文件应用 `20260804044000` 冻结 public legacy relations，再应用 `20260804041000` 令 arena writer 仅保留不可调用 audit stub，最后应用 `20260804042000` 令 position-history records 返回 empty/unknown且其他 record kinds 不变。随后持续排空 legacy Tier-A writer/queue，单独应用 missing postdeploy `20260729061000_tier_a_execution_claim_enforcement.sql`；它不属于十六个核心 migration，也不得并入 predeploy。保持同一 SHA，依次应用 authorization → `20260803212000_legacy_portfolios_v1_retirement.sql` → Claim Phase A，再完成成功 smoke。Portfolio fixture 只在 staging 建立，并按执行状态文档证明 ACL、owner-only 完整导出、413 上限、cascade/rollback 与密文不变。
10. Phase A 后先完成 Hyperliquid/GMX challenge → submit → review → reject/cancel smoke；Phase A 明确没有批准能力，legacy 与 V2 approval 都必须 fail closed。之后才单独应用 Phase B，并证明 canonical `activate_trader_claim_v2` 的管理员批准、badge/link/profile/Arena 投影与 service-only unlink 全生命周期；unlink 任一后置失败全部回滚，保留投影漂移或无法精确映射的 legacy credential 不得猜测。
11. production 通过 ADR-023 获准通道重复同一顺序：维持 token HTTP containment → 四项 ranking authority → token-ranking retirement → record provenance clocks → publication substrate → verified position-history writer → activation → 受保护管线部署 staging 已证明的同一个 exact RAW-only/fail-closed bridge SHA 并排空 legacy calls/transactions → legacy relation freeze → arena writer retirement → records-page quarantine → 排空 legacy Tier-A writer/queue 后单独应用 missing postdeploy → authorization → Portfolio retirement → Claim Phase A → 保持同一 SHA 完成成功 smoke → Claim Phase B。重复 token-ranking retirement、六项 record publication/retirement/freeze、Tier-A marker/trigger/ACL、authorization 生命周期、Portfolio ACL/数据保留/owner delete cascade、Claim approval/unlink/rollback smoke。五个额外身份/凭据 ACL 前置、当前 122 项 manifest 重算后的全部缺项与全部十六个核心 migration 的 exact ledger/live proof 闭合后，再从生产生成 `database.types.ts`。
12. Web/LKG canary、cutoff 后历史 verified/ambiguous credential 盘点（零行记录 `zero / N/A`，仅非零行逐项审计）、staging 支付 canary；从 exact bridge/旧 worker 写入截止时刻起等待至少 48 小时，并证明 `provenance='first_party'` 的 fresh 公开排名输入为零后才重算/开放榜单。
13. 单 worker canary、完整调度周期观察、Mac mini 扩容、新加坡最后恢复。
14. 本地候选中的 GitHub backup/sentinel jobs 保持固定停用，线上 17 个 repository-defined workflow 也已手工停用；Dependabot dynamic workflow 仍 active。当前计划不支持 protected main/required reviewer；治理升级或等效可审计 source-trust/reviewer 边界、新凭据和逐项恢复审查未完成前不得恢复。核心 API/freshness 连续 24 小时绿色后，owner 才解除 NO-GO。

### 阶段 3：小规模 Beta

- 分批邀请活跃交易者、跟踪用户和交易员/KOL，用真实任务测试排行、详情、收藏/提醒与认领。
- 每周访谈 5–10 人；只修复阻碍“我为什么信这个排名、接下来跟踪谁”的问题。
- 达到 Beta 手册阈值后，一次只测试一个 Pro 价值，不扩写 V2/V3 功能。

## 所有者需要完成的最小动作

1. 在 Supabase Dashboard 确认事故恢复并轮换数据库密码。
2. Vercel generic Preview/Development 高权限变量、bypass 和 Git integration 隔离已完成；证明精确 staging branch override 指向 disposable 非生产项目，并补齐缺少的旧 bypass negative canary。protected source/reviewer 建立前保持 bypass count 为零。
3. 提供至少约 100 GiB 可用空间的可销毁非生产 PostgreSQL 17 恢复目标：先完整认证受保护的 2026-07-26 legacy 对象作为事故恢复证据；再在 provider 恢复后生成并恢复一份通过当前 completion/关键表门禁的新备份作为 launch RPO。两项不可互相替代。
4. 在 staging 建立专用 Hyperliquid/GMX claim 与 payment disposable fixtures。
5. 记录 GitHub Free 私有仓库对 main protection/ruleset 与 required reviewer 的 403，且不得公开仓库。三个 environment exact-main policy、10 个旧 repository 高敏 secrets 删除与 17 个 repository-defined workflow 停用已完成，Dependabot dynamic workflow 仍 active；两个新 Telegram repository secrets 已写入但尚无真实告警投递证明。若要恢复 workflow，先升级治理能力并建立 required protection/reviewer，或提供等效可审计 source-trust，再清理 artifact quota、把敏感值收敛到获准 consumer boundary 并逐项恢复。
6. 在 exact bridge writer cutoff 后重新查询 `user_portfolios` 与 credential aggregates；本次计数为零，只有届时出现 owner 行才导出元数据、通知 owner 下载并在交易所侧撤销/轮换旧 key。Arena 删除 RPC 的成功证据不能代替交易所侧撤销证据。

在这些证据闭合前，代码可以称为 **CODE-READY**，不能称为已上线、已迁移或可开放 Beta。
