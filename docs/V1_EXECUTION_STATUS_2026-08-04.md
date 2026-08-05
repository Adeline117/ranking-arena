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
- `2026-08-04T22:53Z` 前的 `/api/health` 证据为 HTTP 202/degraded；数据库与 Redis
  探针通过，freshness 当时为 `4/32 fresh`、`13 stale`、`15 critical`。最新值见下方
  `2026-08-05T01:27Z` 复核；两者都不是 GO 信号。
- `2026-08-04T20:32Z` 再次从公网只读检查：health 仍是同一 202/degraded 状态；
  token containment checker 的 4 个 API、2 个页面、2 个 sitemap 检查全部通过。
- `2026-08-04T22:53Z` 该次公网只读复核仍为 HTTP 202/degraded、精确 production
  commit `5ed4718b6`；数据库与 Redis 为 pass，freshness 仍仅 `4/32 fresh`、
  `13 stale`、`15 critical`。
- `2026-08-05T01:27Z` 公网只读复核仍为 HTTP 202/degraded、精确 production
  commit `5ed4718b6`；数据库与 Redis 为 pass，但 freshness 恶化为 `4/32 fresh`、
  `1 stale`、`27 critical`。同一时段 Mac mini 与 Tailscale 上的 MacBook 分别完成
  token containment checker，4 个 API、2 个页面、2 个 sitemap 均通过。
- `2026-08-05T01:37Z` 发现 GitHub 控制面曾把 15 个 repository-defined workflow
  重新启用，定时任务仍在触发；最新 runs 因 GitHub 账单限制以 0 steps 失败，没有
  job 或生产动作执行，但账单失败不是安全门禁。已把这 15 个重新禁用；连同原本禁用
  的 2 个，现在 17 个 repository-defined workflow 全部为 `disabled_manually`，
  non-completed run 为 0，仅 Dependabot dynamic workflow active。
- 该控制面状态现已由只读 fail-closed verifier 固化；它精确锁定 17 个 workflow 的
  path/name/state，拒绝未知 repository workflow、重复证据与任何
  queued/in-progress/waiting/requested/pending run，并只投影非敏感字段。它在五个官方
  非终态 status 各做两轮有界 `total_count` 查询，任一轮非零即 fail，跨轮 retained run
  按 database ID 去重，单次查询有 20 秒硬超时；前后还各冻结一次 workflow inventory。
  这消除了单轮竞态和 100 条分页截断，但仍是一段明确起止时间的只读观察，不冒充原子
  snapshot，也不扫描 22,000 多条已完成
  历史。使用本机已保存的 `gh` 身份时运行 `env -u GITHUB_TOKEN npm run --silent
qa:github-workflow-control-plane`；`2026-08-05T03:53:52.399Z` 至 `03:53:56.083Z` 的真实
  远端复验结果为 pass（前后 inventory 一致、17/17 disabled、1 个 Dependabot active、
  两轮共 10 次非终态查询的各 status 最大 total 均为 0）。该检查绝不
  enable/disable/cancel workflow。
- 未来 GitHub Actions 与 Vercel Production 的 Telegram token/chat-id 已于 19:03Z
  更新，且 provider API 身份检查返回 200；当前 Vercel deployment 早于该更新，
  更新后也尚无真实消息投递证明，因此告警恢复仍为待验证。GitHub 的两个 Telegram
  值当前仍在 repository-secret scope；所有 repository-defined workflow 保持禁用，
  在建立获准 consumer boundary 前不得以重新启用 workflow 来测试消息。
- Supabase 于 20:00Z 将 Management API 事故标记 resolved；23:38Z 的最新更新仍称
  正在测试 project-upgrade 修复。当前
  [官方状态页](https://status.supabase.com/)仍显示 Database degraded，
  [Project Upgrade Delays](https://status.supabase.com/incidents/2vt3m1qjsf29)仍在修复和
  测试中；provider 门禁没有解除。

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

这五项现已固化为 machine-readable repository crosswalk：它把每个 exact signature 绑定
到 defining migration、runner raw/ledger digest、实际 consumer、generated type、静态/PG17
测试及终态 ACL，并锁定四项 ranking authority → `040430`
retirement 顺序。当前 crosswalk digest 为
`89023cda03016d35eede68fbcd67cab082ff9186c38e06caf1a204e85288a964`；运行
`npm run --silent qa:v1-missing-rpc-crosswalk` 可重建。其 live 缺失状态仍只绑定
`2026-08-04T19:15:53.362Z` 历史只读快照，不能替代新的 production catalogue 复核，
也不授权应用 migration。`get_token_ranking_publication_head` 与两个 writer 的目标是
service-role-only；`040430` 后两个已退休 v2 reader 的目标是 owner-only、无任何 non-owner
EXECUTE，不能把五项统一描述为 service-role-only。crosswalk 的 SQL lexer 会排除注释、
字符串与 dollar-quoted body 对 `CREATE FUNCTION` 的伪装；ACL 证明还绑定 `040430` 的 exact
7-function OID 集、PUBLIC/全部非 owner 动态撤权和“仅 head 保留一条不可转授权
service_role EXECUTE”的目录 postflight。generated type 与运行时 consumer 证据改用
TypeScript AST 精确识别 property 和 `.rpc(<literal>)`，所以注释或无关字符串不能伪造
这些引用；TypeScript 测试证据还要求 `node:fs` 读取的真实文件数据流进入
`expect`/`assert`，PG17 证据则要求真实 `psql_db` 查询赋值被同变量的 `assert_equal`
消费，并排除注释、quoted text 与 heredoc body，惰性字符串/正则或裸 assignment 均不能
冒充证明。

migration QA 另有 101 个仓库文件名未出现在 live ledger。它们包含 renamed 或效果
已存在的候选，不能按数量批量补跑；必须逐项对 frozen catalogue，再在 disposable
PostgreSQL 17 验证。当前没有任何生产迁移授权。

## 联合候选与离线验证

联合分支 `codex/v1-combined-20260804` 整合了 migration/NFT blocker、backup
hardening、V1 candidate、线上 token containment 和 `brace-expansion` 5.0.9
修复。PR #254 已完成 hosted 验证的精确候选提交为
`a760bbfb16f80df0d6caca882e659c80a5e02e59`。

- 第二台 Mac mini 使用 Node `22.23.2` 完成 lockfile clean install；
  `package-lock.json` SHA-256 为
  `c60a9fddee366d056b6b60525867c356c9f241846575396fe7595261700db609`。
  `@lhci/cli=0.15.1` 与修复后的 `tmp=0.2.7` 均为精确版本。
- `npm audit --audit-level=high` 通过：0 high、0 critical；仍有 2 low、23 moderate，
  未运行会产生未审查依赖漂移的 `npm audit fix`。
- 最终离线 QA sweep 为 278/278；危险 migration scanner 的 19 项 lexer、PR/push
  range、root push、non-fast-forward、rename、symlink 和 committed-blob 测试全过。
  scanner 会拒绝未闭合 SQL，并修复了 quoted/dollar-quoted 默认值内分号导致的
  `SET NOT NULL` 漏报。
- PostgreSQL 17 的全部 18 组 schema/RLS/RPC/迁移门禁通过；这只证明 disposable
  数据库行为，不代表已获准在生产执行迁移。
- 全量 Jest coverage 在 Redis 7.4.9 下以已写入 CI 的 `--maxWorkers=2` 完成：
  1084 suites passed、2 skipped；12334 tests passed、17 skipped。

以上 lock/audit 数字属于 PR #254 的已托管验证历史证据。当前 PR #255 工作树又完成一轮
逐包、semver-compatible 的 lock 更新，没有运行 `audit fix --force`：`undici=6.28.0`、
`lighthouse=13.4.1`（连带 patched Sentry/OpenTelemetry）、`body-parser=2.3.0`、
`dompurify=3.4.13`、`tar=7.5.22`。新 `package-lock.json` SHA-256 为
`bceb7a4b3f3a28f6f4cfebc16e013485a0b428a3e438f67d2eda6c0db0469af6`；`npm audit`
已从 2 low + 23 moderate 收敛为 0 low + 4 moderate，仍是 0 high/critical。剩余四项均
来自 `@lhci/cli` 或 `@solana/web3.js` 的 `uuid`/`jayson` 链，registry 给出的自动方案是
破坏性降级/跨大版本，不在本波次强制覆盖；须在独立兼容性迁移中处理。

该新 lock 已在 Tailscale 上的第二网络 MacBook 以 commit `57300bcf4` 的精确 archive
独立验证：Node `22.23.2`、npm `11.11.0` 对上述 SHA-256 完成 clean `npm ci`
（1930 packages），clean-tree audit 为 0 info/low/high/critical、4 moderate；
`qa:baseline-offline` 为 309/307 pass/2 explicit PG skip，`qa:sweep-unit` 为
713/711 pass/2 explicit PG skip。应用与 ingest worker TypeScript 均通过（应用检查在
8 GiB 主机显式使用 4 GiB Node heap），lint 为 0 error、2694 条既有 warning。使用与
hosted CI 相同的无权限 Supabase/cron placeholder 完成 Next.js 16.2.11 production build、
161 个静态页面及 1094 个 chunk 的 BigInt postbuild 检查；未向该主机提供生产 secret，
也没有连接或修改生产数据库。

- 同一应用源码树完成 Next.js 16.2.11 production-like build、161 个静态页面和
  1094 个浏览器 chunk 的 BigInt postbuild 检查。
- 私有、无 secret 的 Lighthouse 门禁在显式 `127.0.0.1` 回环端口对 `/`、
  `/methodology`、`/about` 各运行 3 次，共 9 次全部通过且没有公开上传报告。每页
  最低 performance 分别为 0.84、0.98、0.96；最低 accessibility 为
  0.96、0.99、0.96；最低 best-practices 均为 0.96；HTTP audit 均为 1.0。
- 精确提交 `a760bbfb1` 的 hosted CI run `30949124995` 已全部成功，包含 Types
  contract、Pre-flight、Lint & Type、Unit 和 Build；hosted Lighthouse run
  `30949124593` 也已成功。production-only/live-secret jobs 按设计保持 skipped，
  不把缺少生产凭据伪装成绿色。
- GitHub artifact API 仍保留 1979 条记录、名义 88.20 GB，但 1727 条已 expired；
  真正未过期的 252 条合计约 266.7 MB。combined PR 路径不上传 coverage、`.next`
  或 Lighthouse artifact，因此 quota 不阻断 PR CI；本次未删除任何审计或发布证据。

## Supabase Preview 与 canonical baseline 边界

Supabase Preview 对 PR #254 采用 ledger-driven reconstruction；它不是上述 hosted
CI/Lighthouse 的一部分。该已验证候选在历史 migration
`00008_admin_features.sql` 创建 admin policy 时以 SQLSTATE `42703` 失败：policy
先读取 `user_profiles.role`，而该列在同一历史文件的更后位置才创建。

在 disposable PostgreSQL 17 上仅作诊断性前探后，还依次定位到 `00010`、`00014`、
`00015`、`00017`、`00019`、`00023`、`00024`、`00026`、`00027` 的后续重放阻断。
这些结果证明完整历史目录不是可直接 fresh replay 的 canonical source；它们不是
生产补跑清单，也不授权修改已经应用并由 hash 锁定的旧 migration。

修复必须作为独立、单独评审的 canonical-baseline maintenance wave：生成明确的
canonical 起点，在空白 PostgreSQL 17 重放，并与冻结的生产 catalogue/ledger 做
只读等价核对。本轮没有完成或提交 baseline。曾尝试通过 session pooler 5432 以
`verify-full` 获取 schema-only capture，但因缺少项目 CA 证书而 fail-closed；没有
降低 TLS 校验，也没有发生数据库变更。当前两台可用 Mac 均没有约 100 GiB 的
scratch 空间，因此完整恢复认证仍需 managed PostgreSQL 17 目标。

已实现的离线 maintenance scaffold 仍保持 **candidate/not-deployable**，且当前候选
目录为空。它把 source witness、规范化 catalogue/ledger、hash-pinned 非生产
foundation、app schema、ledger-bound baseline boundary 与完整 forward epoch 绑定为
一个 contract；boundary 必须是 source ledger 最新且唯一的 14 位版本，并对应仓库中
真实 migration；完整 modern migration inventory digest 会让后续倒序新增的文件立即使
候选失效。managed relation/type 也纳入 foundation prerequisite catalogue delta，
unit sweep 会枚举全部候选。回放只接受 candidate directory，内部先复验 manifest，并在
复制前冻结独立的 expected-digest map，再二次验 hash 并把确定字节复制到私有 staging；
每个 staging 目录与文件在执行前后都复验身份和 SHA，SQL 通过固定的 pinned FD 交给
`psql`，不会按路径重新打开被替换的文件。target catalogue collector 还会在 14 组查询
前后复验 socket、输出目录、`psql` 物理父目录及工具身份，并以
`O_EXCL`/`O_NOFOLLOW` 写入 owner-only 结果。app mutation scope 正向限定为
`public`/`arena`，并拒绝 psql meta-command、sequence restart、server-file `COPY`、
显式事务控制、`CONCURRENTLY`、常见 host/outbound capability、外部数据库环境和
PostgreSQL `<17.6`。集群只监听短 Unix socket、HOME/libpq credential path 为空；
foundation 不能预建 `arena` 或 `public`/`arena` 应用对象。stop 失败时保留精确临时
目录，不删除可能仍活跃的 data dir。foundation/forward 仍是必须人工评审的可信仓库
输入；保守 body scan 不是任意动态 SQL 的 hostile sandbox。成功只表示 local
dependency replay，不表示 Supabase 等价或可部署。

本轮随后补齐了独立的 production-source capture scaffold，但没有运行真实 source
capture。该命令只接受官方 Supabase direct/session 5432、项目 CA、`verify-full` 与
PG17.6+ 同源工具链；使用 `REPEATABLE READ READ ONLY` 导出单一 snapshot，把 14 类
catalogue 与 ledger 的 version/name/creator/idempotency key/nullable body 单向 hash
同 schema-only dump 绑定。source-catalog 合约现为 `@3`；除保留非秘密的 creator/key
用于逐项 exact 对账外，还固定 nullable column ACL、function owner，以及 view/materialized-view
owner 与完整 nullable reloptions，使默认 ACL 与显式空 ACL、column GRANT、`SECURITY DEFINER` owner、
security-invoker/barrier 等漂移不能比较为相等；它不把 URL、密码或 ledger SQL 写入产物。publication 的
all-table/relation/schema membership、
row filter/column list、composite/domain 结构均有严格共享 row contract。PG17 dump 中
会与空白目标冲突的唯一 `CREATE SCHEMA "public";` 被 exact-one 规范化后再次通过 SQL
safety gate。子进程使用最小环境与 90 秒 wall timeout；超时或信号先 TERM、宽限后
KILL，并等待 close 再走唯一的断连/清理路径。`pg_dump`/`psql` 的物理目录与文件须由
root/当前用户拥有且不可被 group/world 写入；工具从 `O_NOFOLLOW` pinned FD 复制为捕获专属
`0700` 目录内的 `0500` 副本，版本检查与真实 dump 前后都复验完整身份和 SHA。密码只进入
私有 `0600` pgpass（含冒号/反斜杠转义及控制字符拒绝），不再进入 `PGPASSWORD`。
输出父目录必须 owner-only；原子 `mkdir`
只认领不存在的目标，incomplete marker 在两个 hard-link 完整前阻止消费，移除 marker
才是 commit point。它不会覆盖并发出现的目录；产物仍只有 `app-schema.sql` 与
`source-catalog.json`，不是 candidate、manifest 或部署授权。这是进程中断下的
readiness 协议，不声称未执行 fsync 时具备断电 durability；不支持 hard link 的文件
系统会 fail closed。

最新 Node 22 `qa:baseline-offline` 回归共 309 项：307 通过、0 失败、2 项 skip；两个
默认 skip 分别是真实 capture 与真实 replay 的显式 PostgreSQL 集成检查。随后在隔离的
PostgreSQL 17.8 上分别启用，capture 为 67/67、replay 为 33/33，合计 100/100 通过。
同一工作树的 Node 22 `qa:sweep-unit` 为 713 项：711 通过、0 失败、2 项 skip；应用与
ingest worker 两套 TypeScript 检查均通过，lint 为 0 error、2694 条既有 warning。候选
清单仍为空，因此这些证据只验证 guardrail/harness，不验证任何 canonical baseline。

source capture 到位后，新增的纯离线 candidate assembler 会要求显式 foundation、
platform prerequisite、source Git SHA、project-ref hash、baseline boundary 和完整有序的
forward migration 列表；它先在私有 staging 调用现有 validator，再用 owner-only 文件、
incomplete marker 与 no-overwrite hard link 发布精确五文件目录。任何输入漂移、symlink、
并发目录、部分 link 或最终复验失败都会 fail closed。当前仍没有 source capture、受评审
foundation 或真实 candidate，因此只完成了组装协议，未生成可回放 baseline，更不产生
部署授权。

仓库侧 launch manifest 现已另有纯离线、确定性的 hash inventory：它直接解析受评审
runner，验证 migration 文件与目录均非 symlink，并同时记录原始文件与 runner 将写入
ledger 的单元素 statement-array digest；它们共同导出预期的 `createdBy=codex` 与
`codex:<version>:<raw-file-sha256>`。runner 的 8 组受管数组在声明后立即变为 Bash
`readonly -a`，inventory 又要求这些精确声明紧邻数组，所以 trap、quoted builtin 或其他
间接 mutation 也会 fail closed。生成结束前会以 `O_NOFOLLOW` 重新打开 runner 与全部
migration，重算 inode/时间/大小/SHA 并前后复验目录身份，拒绝从未同时存在的混代清单。
当前 inventory digest 为
`a26e18e5a919fe3dd52703dee39b80e50142bb9474786347fa18912bd5fa6300`，其中
predeploy 为 122 项、postdeploy 为 3 项。`npm run --silent
qa:launch-migration-inventory` 只证明仓库清单，不是 live apply 证据；新的
`qa:source-launch-ledger` 会在真实 owner-only source capture 到位后，以 version、name、
statement digest、creator、idempotency key 五字段逐项判定 exact，并离线输出 missing、
identity/body drift 与 out-of-scope unknown。当前没有真实 capture，因此尚未生成新的
production 对账结论。

managed scratch 的跨阶段 claims 另有离线 receipt contract：它在单份 JSON 内交叉引用 provider 恢复、
legacy/current 两次独立恢复、source capture、candidate 独立评审、两个不同 PG17 replay
和 Preview，并要求 CRC/ISIZE/tail、counts、RLS/Auth、RPO/RTO、catalogue/ledger 比较、
精确 extension 版本、foundation/prerequisite/runner hash、删除回执及目标/证据身份唯一。
两次 restore、两个 replay 与 Preview 的五个 capacity-slot 身份也必须全局不同；物理容量
只有在前一项目证据导出、删除并干净重建后才能作为新的 allocation lifecycle 复用。
校验器拒绝 URL、连接串、secret-like 字段和任何 live-GO 声明；它只确认自报 claims 的
结构与内部绑定，不读取外部证据文件，也不重算外部 hash。输出固定
`receipt/claims-only`、`evidence_proven=false` 与 `production_authorized=false`；即使
`all_claimed_checks_passed=true` 也不是证据完成或 GO。模板本身故意是
`template/not-evidence`；真实托管执行尚未发生。

只读配置审计还发现 `supabase/config.toml` 的本地 `db.major_version` 仍为 `15`，而
已验证的生产服务端为 PostgreSQL 17。Supabase 官方要求本地 major 与 remote 一致；
但 Git branching 会把 `config.toml` 变更同步到远端 branch。当前升级事故仍未解除，
所以本轮不通过一次普通 push 猜测性触发数据库版本配置；应在 provider 恢复、目标
branch PG17 定容获批后，以独立变更修正并执行 `SHOW server_version` 证明。

Owner/Admin 需要提供的 CA、受控 5432 只读 URL、两个空白 PG17 replay project 与
`>=100 GiB` restore target 已整理到
[managed scratch request](./V1_MANAGED_SCRATCH_REQUEST_2026-08-04.md)。其中不含 secret，
也不授权创建付费资源或连接生产。

## 剩余门禁（严格顺序）

1. 等待 Supabase 官方事故恢复；获取项目 CA 与受控的 backup/restore 通道，在至少
   约 100 GiB 的 managed scratch 先完整恢复受保护的 2026-07-26 legacy 对象，完成
   CRC/tail、索引、RLS/auth、关键表及应用只读 smoke，形成事故/历史恢复证据。
2. 生成一份通过当前 completion metadata 与关键表门禁的新备份，并在新的干净
   > =100 GiB restore target 完整恢复，证明 launch RPO/RTO。可在导出第 1 步证据并
   > 删除/重新创建项目后复用同一容量预算，但不得覆盖 legacy restore 或混用证据。
3. 用已评审的只读 capture scaffold 取得 source witness，再独立构造 canonical
   baseline；不得改写旧 migration。先在两个空白 managed PostgreSQL 17 完整重放，
   再对冻结 catalogue/ledger 做等价核对，并让 ledger-driven Preview 通过。此前不得
   把 PR #254 的仓库 CI/Lighthouse 全绿解释为可合并或可发布。
4. 逐项对账 5 个缺失 RPC 和 101 个 advisory migration 候选，在 disposable
   PostgreSQL 17 验证并生成精确 predeploy/postdeploy 清单；禁止对生产 `db push`。
5. 建立 exact-SHA 非生产环境并验证 schema、缓存预热、token containment、告警真实
   投递和 rollback；随后完成 48 小时无未授权写入的 drain 证据。
6. 经 owner 明确 GO 后才允许受控 predeploy。先单 worker canary，观察一个完整调度
   周期，再分批恢复其余 worker；任何认证风暴、5xx 放大或 freshness 退化立即回滚。
7. 生产 smoke、双网络与缓存证据全部通过后，才开始 24 小时小流量 Beta 观察；
   Claim/Portfolio 与后续 postdeploy 仍按独立门禁推进。
