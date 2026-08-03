# DEX 开源索引与协议原生数据源评估 — 2026-07-29

> 状态：选型与小范围 PoC 决策稿；不授权生产接线、公共 serving、排名或 Score。
>
> 最近复核：2026-08-03。凡写“当前”的部署、许可或服务能力都以此日期为准；执行 PoC 时仍须
> 把网页/许可证正文、解析后的外部登记项、artifact version、commit SHA 和复核时间冻结进 manifest。
>
> 目标：通过全协议事件发现和可重放账本覆盖大部分**公开可观测交易钱包**，而不是只覆盖
> TopN 榜单。任何钱包只要历史不完整、执行时价格不可信、期初仓位或成本基础未知，就必须显示
> `partial/unknown`，且不得进入排名。
>
> 证据口径：本文只采用项目/协议官方文档、官方仓库和当前仓库已冻结的数据契约。官方营销
> 声明仍需 PoC 实测；仓库公开不等于有开源许可证，能自托管 API 层也不等于拥有独立全历史数据。

## 1. 结论先行

没有一个现成工具能同时解决链级全历史、实时追头、协议升级、交易员角色、完整仓位生命周期、
执行价格、费用、资金流、成本基础、质量证明和可回滚发布。工具只负责取数或执行 handler，Arena
仍必须拥有协议 manifest、decoder、账本、价格证据、覆盖证明和排名资格门。

建议按以下边界采用：

1. **GMX/gTrade 的首个 EVM 协议 PoC：Ponder。** 它是 MIT、TypeScript、Postgres、自托管，
   支持历史回填、实时追头和自动 reorg 回滚，最适合用一个冻结的 Arbitrum 小区间验证 Arena
   自建生命周期 decoder。RPC 必须可替换且至少双源；Ponder 本身不是数据完整性的证明。
2. **BSC/Solana 的链级人口发现与大吞吐回放：SQD Portal/Pipes 小范围 PoC。** 公共 Portal 能提供
   EVM logs/traces/state diffs 和 Solana instructions/inner instructions/balances；但它仍是托管数据面。
   当前私有 Portal 的官方自托管路径中，历史依赖 SQD Network 且至少锁定 1,000,000 SQD，自己提供
   near-head 的文档化 data-service 路径只覆盖 EVM；Solana 自有实时源和完整 provider-exit 尚未证明。
   生产前必须实测 checkpoint 续扫、第二来源差分和空环境恢复。Pipes 仓库与发布包许可证标注不同，
   且当前包仍是 pre-release，必须锁实际 artifact，不能把公共 Portal 成功等同于独立自托管成功。
3. **Hyperliquid：官方 non-validator node + 官方 S3 为主候选，Info API 和 SQD 为对账。**
   `userFillsByTime` 的 10,000 fills 可访问上限不能承担高频账户全历史。官方节点核心由签名二进制
   分发，因此可称“官方可自托管数据入口”，不能称“可审计的开源节点实现”；仓库的 Apache-2.0
   也不能自动证明仓库外下载的 `hl-visor`/`hl-node` 二进制许可，条款未冻结前标记
   `binary_license_unknown`。
4. **Graph Node：只在复用许可证明确的 manifest 或 Arena 自己编写 subgraph 时采用。** 引擎
   本身成熟且双 MIT/Apache-2.0，但当前 GMX、gTrade 的相关官方 subgraph 仓库没有根许可证，
   不得直接 vendor；为统一链级账本新建 Graph Node 栈的运维成本也高于当前收益。
5. **Envio HyperIndex/HyperSync：仅在法务书面澄清后做隔离 PoC。** 当前官方材料明确不是
   OSI 开源，HyperSync 是需认证的专有数据面，生产配额/价格取决于届时冻结的服务方案；EULA 的
   单设备、服务器和远程多用户限制与页面“可自托管”概述需要法务确认。Solana 虽已有
   instruction/CPI/token balance 能力，但仍是 experimental/pre-release 且 HyperSync 是滚动保留，
   不能成为 90D 唯一历史源。
6. **Rotki、DefiLlama 只作算法/方法参考。** 不把它们作为 Arena 的交易事实、价格、人口分母
   或排名权威，也不复制许可证不兼容或缺许可证的代码。

推荐数据路径：

```text
GMX/gTrade EVM:  replaceable archive RPC -> Ponder -> Arena-owned facts/ledger
BSC:             SQD Portal/Pipes + replaceable RPC -> Arena-owned facts/ledger
Solana shadow:   public SQD Portal + independent source -> Arena-owned facts/ledger
Hyperliquid:     official node + S3 -> Arena-owned decoder -> Arena-owned facts/ledger

official API/GraphQL + independent provider -> differential reconciliation only
Solana public Portal != proven self-owned near-head/provider-exit
Arena quality evidence -> shadow -> canary -> rank-eligible serving
```

## 2. 产品真相与排名硬门

“链上都能重建”在底层事实层成立，但只有在 Arena 完成协议解释和证据闭环后，指标才可排名。
钱包地址也不等于自然人；覆盖目标是 `(chain, protocol, account)` 公开账户集合，跨钱包身份合并
必须另有用户证明。

每个钱包、每个 7D/30D/90D 窗口至少独立记录以下状态：

| 状态                  | 含义                                                                | 对产品的影响                        |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| `population_observed` | 被独立 candidate selector 或官方公开集合发现                        | 可计入发现人口，不代表指标完整      |
| `history_complete`    | 冻结窗口、分页/高度耗尽、开窗仓位 anchor 和所有生命周期事件均已证明 | false 时 `partial`，不得排名        |
| `price_complete`      | 每个计入事实都有可信执行价或同时间 oracle/FX 证据                   | false 时 USD/PnL 为 unknown         |
| `cost_basis_complete` | opening inventory、转入资产成本、费用和现金流分类均可证明           | false 时 ROI/PnL 为 partial/unknown |
| `method_complete`     | 协议版本、decoder、公式、精度和 provenance 均被静态合同固定         | false 时不得跨来源比较              |
| `freshness_complete`  | `source_as_of` 在该链/来源的新鲜度预算内                            | false 时 stale，停止新发布          |
| `rank_eligible`       | 由数据库从以上证据和事实推导，不能由 adapter 自报                   | 只有 true 才能产生名次              |

统一失败语义：

- `partial`：已知拿到一部分事实，但有明确的高度缺口、retention/page cap、未闭合仓位、未定价事件或
  opening anchor 缺失。
- `unknown`：无法证明来源身份、人口分母、价格/FX、成本、协议版本或结果语义。
- `0`：只有已经证明结果确实为零时使用；请求失败、空页歧义和未解码事件绝不写零。
- `source_reported`、`event_rebuilt`、`derived_estimate` 分列保存，不得互相 `COALESCE` 成一个值。
- partial/unknown 钱包仍保留在覆盖率分母和详情补证队列中，不能通过删除难算钱包美化准确率。

## 3. 统一评估标准

每个候选必须登记并冻结：

| 维度            | 必答问题                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| 许可证          | 引擎、生成代码、SDK、manifest、ABI、托管服务分别是什么许可？生产使用和修改是否允许？    |
| 独立性          | 自托管后是否仍依赖供应商 archive、token、stake、签名二进制或专有数据格式？              |
| 链范围          | EVM、Solana、HyperCore 分别原生支持到什么字段？不能用“支持链”替代字段清单。             |
| 历史            | 起始高度、保留窗口、archive/trace、分页耗尽和重新获取是否可证明？                       |
| 实时与 finality | head 延迟、finalized 语义、reorg 回滚、断点恢复和重复投递如何处理？                     |
| 协议表达力      | logs、traces、inner/CPI、balances、state/current reads 是否足以解释目标协议？           |
| 数值            | 原始整数、decimals、执行价格、fee/funding/borrowing、rounding 是否无损？                |
| 可重建性        | 相同 manifest + 区间 + decoder SHA 是否能在空库得到相同 canonical fact-set SHA？        |
| 退出与成本      | 供应商失效时能否换源续扫？90D 回填、每百万候选事件、每万钱包的时间与费用是多少？        |
| 排名安全        | 数据缺口能否 fail closed 为 partial/unknown，还是框架会让“成功跑完”被误当成“数据完整”？ |

## 4. 索引工具比较

| 候选                 | 许可/专有边界                                                                                | 链、历史与实时能力                                                                 | Arena 结论                                   |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| Ponder               | 引擎 [MIT](https://github.com/ponder-sh/ponder/blob/main/LICENSE)；RPC 自带                  | EVM；历史 + realtime；自动 reorg/崩溃恢复；call traces 依赖支持 debug trace 的 RPC | **首选 GMX/gTrade 小 PoC**                   |
| Envio HyperIndex     | 非 OSI 许可；生成代码 EULA；HyperSync 专有/需认证，RPC 模式可绕过                            | EVM/Fuel；Solana early access；历史 + realtime + rollback，但 Solana 为滚动历史    | **法务通过后才可隔离 PoC**                   |
| SQD Portal/Pipes/SDK | SDK/Pipes repo Apache-2.0；Pipes 包标 MIT；Portal AGPL-3.0；公共 Portal/SQD Network 外部依赖 | 公共 Portal 覆盖 EVM、Solana、HyperCore 等；私有 near-head 当前只冻结了 EVM 路径   | **链级 acquisition PoC；Solana exit 未证明** |
| Graph Node           | 引擎双 MIT/Apache-2.0；manifest/映射代码逐仓审计                                             | EVM 为主；历史/实时、GraphQL、reorg；需要 Postgres、IPFS 和合格 node/Firehose      | **兼容/复用工具，不作默认统一账本**          |

### 4.1 Ponder

[Ponder 官方仓库](https://github.com/ponder-sh/ponder)把它定义为 EVM TypeScript 索引框架；
配置支持任意 EVM chain、一个或多个 RPC、WebSocket 追头、`startBlock/endBlock`、receipts 和 call
traces。官方 [indexing 说明](https://ponder.sh/docs/indexing/overview)记录了基于事务日志的 reorg
回滚、从 finalized block 崩溃恢复，以及 backfill/live 两种模式。官方
[自托管说明](https://ponder.sh/docs/production/self-hosting)使用 Postgres schema、readiness 和恢复机制。

适合 Arena 的原因：

- MIT、TypeScript、Postgres，和现有工程能力最接近；协议 handler 容易写 golden fixture。
- 同一 handler 同时用于历史与实时；自动 reorg 回滚减少基础框架工作。
- RPC 是可替换依赖，PoC 可以同区间双 RPC 重放并比较 canonical facts。

不能替 Arena 解决：

- Ponder 只支持 EVM，不支持 HyperCore 或 Solana。
- 官方明确 call traces 更慢、更贵且并非所有 RPC 支持；BSC native/internal transfer 完整性必须
  单独验收，不能因普通 logs 可用就声称钱包账本完整。
- RPC 返回完整、archive 深度、provider 退出、协议部署/升级和业务语义仍由 Arena 证明。
- Ponder 表可以是 PoC state store，但生产权威仍应输出不可变 Arena facts、observation 和
  decoder/manifest SHA，避免框架数据库本身成为不可解释真相。

### 4.2 Envio HyperIndex / HyperSync

官方 [HyperIndex 概览](https://docs.envio.dev/docs/HyperIndex/overview)声明 historical/realtime、
multichain、reorg 和自托管；[配置文档](https://docs.envio.dev/docs/HyperIndex/configuration-file)
允许 HyperSync、sync/realtime/fallback RPC 和 `rollback_on_reorg`。BSC、Arbitrum 等在
[HyperSync 网络表](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks)中有端点，
但“有端点”不等于该端点提供 Arena 所需 traces/internal transfers。

截至本文日期，[Solana HyperIndex](https://docs.envio.dev/docs/HyperIndex/solana)已能按 program +
discriminator 索引 instruction，包含 inner/CPI、Token/Token-2022 balance、transaction metadata
和 logs；同时官方仍标为 experimental/pre-release，缺 handler 原生 SOL balance 和 account-change
subscription。[Solana HyperSync](https://docs.envio.dev/docs/HyperSync/solana)明确为滚动保留，历史
下界会前移。因此它适合字段/吞吐实验，不足以单独证明 90D 或全生命周期。

许可证是当前 blocker：

- 官方 [许可说明](https://github.com/enviodev/hyperindex/blob/main/licenses/README.md)明确表示不是
  OSI 认可的开源许可；generator 受商业许可，生成代码有 EULA，且限制与 Envio Cloud 竞争。
- 官方 [完整 EULA](https://docs.envio.dev/docs/HyperIndex/licensing)一方面概述可自托管/RPC bypass，
  另一方面包含单设备/单用户、不得作为服务器软件或远程多用户服务等条款。Arena 内部生产索引器
  是否允许不能靠工程解释，必须由法务书面确认或取得供应商授权。
- 即使改用 RPC 绕过 HyperSync，也只移除了专有数据面，没有移除 HyperIndex 软件许可义务。

结论：在许可澄清前不下载到生产构建、不生成生产依赖代码、不把 Envio 结果当 population 或
ranking truth。许可通过后也只对同一 24 小时冻结链段做 RPC-only/HyperSync 双模式 shadow。

### 4.3 Subsquid / SQD

官方 [Portal 概览](https://docs.sqd.dev/en/portal/overview)提供 arbitrary ranges、historical/live、
finality/reorg 和 EVM/Solana 等统一流；[Solana API](https://docs.sqd.dev/en/portal/solana/api)包含
instruction、inner path、logs、native/token balances，并明确一次 HTTP stream 可能在目标区间前
结束，客户端必须从最后高度 `N+1` 继续。收到一次 200 或看到首尾高度都不能证明无缺口。

代码与数据面的许可证必须分开：

- [Squid SDK](https://github.com/subsquid/squid-sdk)和
  [Pipes SDK](https://github.com/subsquid/pipes-sdk)仓库根许可证为 Apache-2.0；当前
  `@subsquid/pipes` package manifest 又标注 MIT，且版本仍为 pre-release。两者都是宽松许可，但
  生产必须按实际安装 tarball 锁 version、integrity、源码 SHA 和适用 LICENSE，不能笼统写
  “Subsquid 是 Apache”或只按仓库 `main` 判断发布包。
- [sqd-portal](https://github.com/subsquid/sqd-portal)为 AGPL-3.0。其当前 README 说明历史来自
  SQD Network，带宽取决于给 Portal peer 锁定的 SQD stake；近 head 来自 HotblocksDB。
- 当前官方[私有 Portal 设置](https://docs.sqd.dev/en/portal/self-hosting)将历史路径明确为 SQD
  Network，至少需要锁定 1,000,000 SQD；自有 recent-data 示例是
  `RPC -> EVM data service -> HotblocksDB`。文档同时说明其他数据类型需要兼容的 data service，
  但没有冻结可用于 Solana 的自有 near-head 实现。因此公共 Solana Portal 的 realtime 成功不能
  外推为 Solana provider-exit 已通过。
- 托管 Public Portal 是外部服务，自建 Portal API 层也不自动等于自有历史数据。若要声称无外部
  依赖，必须对目标数据类型实测“自有节点/自有本地 dataset”路径和从空环境恢复，而不是只把
  HTTP 服务部署到自己的机器。

适用边界：

- BSC：公共或私有 Portal 可用于宽 candidate selector 和高吞吐回放；自有 RPC/HotblocksDB 路径
  必须单独通过近 head、trace/state diff 和 provider failover 验收。
- Solana：公共 Portal 只用于 shadow candidate selector/历史回放；在兼容的自有 near-head source、
  独立第二来源和冷恢复都通过前，不得把它登记为已完成 provider-exit。Arena decoder 仍负责
  program 版本、多跳、CPI、费用、失败交易、native/wrapped 变化和地址角色。
- Hyperliquid：官方 [`hyperliquid-fills` dataset](https://docs.sqd.dev/en/data/hyperliquid/hyperliquid-fills)
  暴露 fill、closed PnL、fee、trade/order id，可作快速 shadow；仅 fills 不足以重建 funding、
  deposit/withdraw、transfer、liquidation 和 opening state，其上游 lineage 未证明独立前不能同时
  充当主源和独立参考集。
- 生产前必须按 `public Portal / private historical / private near-head / fallback RPC` 分开登记能力，
  并在同一冻结区间做字段、hash、缺口、重放时间、成本和退出演练；不能把不同拓扑的优点合并成
  一个不存在的“SQD 能力”。

### 4.4 Graph Node

[Graph Node](https://github.com/graphprotocol/graph-node)引擎为双 MIT/Apache-2.0；官方
[运维文档](https://thegraph.com/docs/en/indexing/tooling/graph-node/)说明自托管需要 Graph Node、
Postgres、IPFS 和合格 network provider，可配置 full/archive/traces provider、独立 block ingestor、
索引节点与查询节点。官方 [支持网络说明](https://thegraph.com/docs/en/supported-networks/)指出自建
Graph Node 可索引 EVM 网络，其他协议需要 Firehose/Substreams 集成。

优势是成熟的 manifest/schema/mapping、历史追头、GraphQL 和现有 subgraph 生态。边界是：

- AssemblyScript mapping 和 Graph/Postgres/IPFS 运维是另一套栈；为了一个 Arena-owned 协议
  decoder 新建它，收益低于 Ponder。
- Graph Node 开源不代表某个 subgraph 可复制。审计时
  [GMX `gmx-subgraph`](https://github.com/gmx-io/gmx-subgraph/tree/33dc3c034ee6)和
  [Gains `gtrade-stats-subgraph`](https://github.com/GainsNetwork-org/gtrade-stats-subgraph/tree/7cea18ccdf80)
  都没有根 LICENSE；公开可读只授权浏览/fork 平台行为，不等于 Arena 可复制、修改和生产分发。
- 托管 subgraph 查询适合 bootstrap/differential；其分页、indexed head、schema 版本和完整性
  未冻结时不能作为全人口或 lifecycle truth。

结论：若协议以后提供明确许可且完整的官方 subgraph，可复用 manifest 做加速；否则 Arena 从
官方合约部署和链事件独立实现，不 vendor 无许可证 mapping。

## 5. 协议原生数据源

### 5.1 Hyperliquid

主候选是官方 [non-validator node](https://github.com/hyperliquid-dex/node)和
[历史 S3](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)：node 可用
`--write-fills --batch-by-block` 连续写 fills；S3 提供 `node_fills_by_block`、旧 fills/trades、
`explorer_blocks` 和 `replica_cmds`。公开 [L1 data schemas](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/l1-data-schemas)
用于版本化解码。

许可/依赖边界：

- `hyperliquid-dex/node` 仓库有 Apache-2.0 LICENSE，但 README 的安装流程下载并验签 `hl-visor`，
  visor 再下载/验签 `hl-node`。仓库没有核心节点实现源码，仓库许可证也不能自动授权仓库外分发的
  二进制；因此不能把其行为视为可审计开源，且在二进制使用/留存条款冻结前必须保持
  `binary_license_unknown`。
- Foundation peer 是 best-effort 且官方明确不保证 availability、latency、performance 或
  completeness；二进制条款明确后，Arena 必须运行自己的节点、监控缺块，并把 peer/S3/API 作为不同
  observation。条款未明确时不能以“必须自建”为由绕过 PoC-0 的 runtime 禁入门。
- 官方 [Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
  的 `userFillsByTime` 每次最多 2,000，且只可访问最近 10,000 fills；命中上限、高频账户或开窗
  仓位无法闭合时，当前 API 路径必须保持 partial。

Arena 仍需自建：主账户/子账户/vault 角色；perp/spot 资产身份；open/increase/reduce/flip/close；
maker/taker fee、funding、liquidation、deposit/withdraw/transfer、builder fee；block/fill/order/trade
去重；窗口前 opening position；执行价/mark/oracle 区分；资金流调整 NAV。官方 board/portfolio
保留为 `source_reported` 对账，不覆盖 `event_rebuilt`。

### 5.2 GMX

官方 [GraphQL](https://docs.gmx.io/docs/api/graphql/)当前列出 Arbitrum、Avalanche、Botanix、
MegaETH 的 SQD endpoints；endpoint 存在不代表该网络可进入 active ranking。官方
[SDK 网络配置](https://docs.gmx.io/docs/sdk/v1/)把 Botanix 标为 withdrawals-only，因此 census
和排名必须按带日期的 deployment status manifest 分开 `active/historical/withdrawals_only`。

长期主事实应来自官方部署合约的链日志。官方
[架构](https://docs.gmx.io/docs/api/contracts/architecture/)说明协议大部分状态在 `DataStore`，
列表和当前仓位可经 Reader 查询，事件集中通过共享 `EventEmitter` 发出；因此 decoder 不能只
监听常见 ERC-20 Transfer，也不能把一次 order request 当成交。

必须自建并版本化：

- order create/update/cancel/freeze/execution 与 position increase/decrease/partial close/close；
- liquidation/ADL、swap leg、collateral change、deposit/withdraw、referral 和 cashflow；
- position fee、funding、borrowing、price impact、execution fee、两 token 输出和 refund；
- EventEmitter 的动态 key/value schema、proxy/handler/DataStore 升级高度；
- execution oracle price、mark/current Reader state 和 realized-net PnL 的区别；
- 开窗仓位 anchor、资产守恒以及和 Reader/DataStore 的 cutoff 对账。

许可边界：当前 [`gmx-synthetics` LICENSE](https://github.com/gmx-io/gmx-synthetics/blob/main/LICENSE)
为 BSL 1.1；Change Date 是“2026-08-31 与
`synthetics-contracts-license-date.gmxresearch.eth` 指定日期两者较早者”，Licensed Usage Grant 也由
`synthetics-contracts-license-grants.gmxresearch.eth` 外部登记。未解析并冻结这两个 ENS 登记项前，
不能把 2026-08-31 写成确定转换日，也不能假设有生产授权。在最近复核日它仍按
`license_unknown_for_production` 处理；默认文本只允许非生产使用。PoC 可阅读/验证，但复制生产
实现、公式或生成 derivative 前必须法务确认；`gmx-subgraph` 无 LICENSE，不 vendor。官方
GraphQL 和 Reader 只做 bootstrap/current-state/differential，不能反过来证明自己的完整性。

### 5.3 gTrade / Gains Network

截至 2026-08-03，官方
[EVM 合约地址](https://docs.gains.trade/what-is-gains-network/contract-addresses)把 Arbitrum、Base、
MegaETH、Polygon 列为 Active Contracts，已不再把 ApeChain 列入当前 active 集合。Arena 不能据此
删除 ApeChain 历史；必须先查明其最后 active 高度/时间和退出原因，再在 dated deployment manifest
标成 `historical/retired/unknown`。每条 EVM 链仍要固定 diamond 地址、facet/ABI、部署/升级高度和
状态，不能用一套当前 ABI 回放所有历史。

官方另有 [Gains Solana](https://docs.gains.trade/gtrade-leveraged-trading/gtrade-solana) 产品入口，只明确
描述用户可从 Solana 钱包交易并链接到 [sol.gains.trade](https://sol.gains.trade/)；该页没有发布原生
Solana program/IDL，也没有声明交易最终在 Solana 结算，而 EVM active-contracts 页也没有把 Solana
列成合约部署。因此不能从产品名或钱包连接方式推导出“原生 SVM gTrade 协议”。

截至最近复核日，官方站 build `03e7764` 的
[`_app-d44cb11eb237bcbf.js`](https://sol.gains.trade/_next/static/chunks/pages/_app-d44cb11eb237bcbf.js)
（SHA-256 `f28f17f74f300bae13aa87b75883f62c6276d6efc52bd4671e1588c3135c5c34`）中可观察到 Circle
`depositForBurn`、Mobula `solana -> arbitrum`、`shadowWallet/smartTrader` 和 Arbitrum `42161` 路径。
这是跨链钱包入口的强 PoC 线索，不是协议权威：前端会变且没有替代链上证明，执行时必须重新冻结
current build/chunk URL、内容 SHA 和时间，再逐笔追踪 Solana deposit/burn、bridge intent/fill、
Arbitrum smart-trader 交易和 withdrawal/claim。

在真实执行链、Solana 钱包到 EVM smart-trader 的控制关系、跨链资金流和费用都证明前，该产品面保持
`unsupported/unresolved`，相关钱包/指标保持 `partial/unknown`；不得从协议覆盖报告静默删除，也不得
因 EVM gTrade 已通过就进入排名。若交易追踪实际发现原生 SVM program，再另建
program/IDL/upgrade、账户角色、instruction/CPI、oracle、费用和历史起点 manifest，不能预设答案。

官方 [Backend](https://docs.gains.trade/developer/integrators/backend)为其明确列出的网络提供无需认证
但有限流的 REST/WebSocket、open trades 和个人历史接口，适合 current state 与 shadow diff；接口
返回“all historical trades”不自动证明无 retention、分页截断、删除或版本缺口，且不能外推到未列
网络或 Solana。每个 deployment 都必须用冻结窗口实测 exhaustion。
[Gains SDK](https://github.com/GainsNetwork-org/sdk)为 MIT，可在锁定版本、源码 SHA、NOTICE 和
golden tests 后参考 ABI、类型、normalization 与协议公式。`gtrade-stats-subgraph` 无 LICENSE，
只能查询对账，不复制实现。

Arena 仍需自建：

- EOA/diamond/callback/vault 角色和真实 trader address；
- market/limit/stop、open/increase/decrease/partial close/close/liquidation 生命周期；
- collateral decimals/price、leverage、position size、execution price、price impact；
- trading/open/close、borrowing、funding/holding、rollover 等费用的版本化语义；
- canceled/reverted/duplicate event、链重组、facet 升级和跨链 asset identity；
- 开窗前仓位与成本 anchor，协议外 deposit/withdraw/transfer 作为 cashflow；
- 公开 Top-25 只作榜单对账，全事件发现的钱包集合才是 coverage candidate。
- Gains Solana 产品面的 Solana wallet/USDC account、burn/mint/bridge fee/refund/withdraw，以及
  smart-trader/shadow-wallet 控制关系；交易生命周期按实测 execution chain 归档。若存在原生 SVM
  program，再补 signer/program/vault/keeper、instruction/CPI 和 SVM finality。

## 6. 开源工具不能替代的 Arena 语义层

| Arena-owned 模块            | 必须产出的证据                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| deployment manifest         | chain/protocol、地址、ABI/IDL、start/end height、proxy/facet/upgrade、官方来源和审核 SHA |
| candidate selector          | 独立于 decoder 的宽匹配 candidate；成功、失败、unknown 都有 block/tx 定位和固定 reason   |
| role classifier             | user、router、pool、vault、keeper、liquidator、subaccount；不得把内部 leg 算成交易员     |
| protocol decoder            | 完整 lifecycle、事件版本、原始整数/decimals、fee/funding/liquidation、幂等 identity      |
| wallet cashflow ledger      | protocol 外转账、bridge、deposit/withdraw、native/wrapped 变化；外部入金不直接算收益     |
| price evidence              | execution price 或同时间可信 oracle/FX、来源、时间、精度、偏差；现价不得替代历史价       |
| inventory/cost ledger       | opening position/inventory、lot/cost method、transfer cost；无法证明就 partial           |
| position/NAV reconstruction | 每个事件后的仓位、realized/unrealized、费用和资金流调整 NAV；与 cutoff state 守恒        |
| window/risk model           | 绝对 UTC 边界、7/30/90D、Modified Dietz ROI、MDD/Sharpe 样本门和 methodology version     |
| quality/publish authority   | gap、decode、price、cost、freshness、diff、replay verdict；同一 run 原子发布和回滚       |

通用 swap decoder 不能解释 perp 生命周期；只抓协议事件也不能解释协议外资金流；只抓余额差又无法
区分 swap、bridge、airdrop、fee 和内部路由。正确闭环必须是“协议事件发现 + 钱包全账本补腿 + 当前
状态对账 + 历史价格/成本证据”。

## 7. 推荐小范围 PoC

PoC 全部写 shadow storage，不接现有公共 RPC/MV、主页、排行榜或 Score。证据结构必须继承
[`DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md`](./DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md)
已冻结的 acquisition observation/refetch 合同，不能由本选型稿另造简化版。provider/page/item body
不落库，但必须保存完整的 batch/page/item observation 链：endpoint/query identity、公开区间、hash
basis/byte length/content SHA、page ordinal/previous-page chain、cursor commitments、terminal stop reason、
source independence/replay state、公开 block/tx locator、规范事实、decoder/manifest SHA 和质量 verdict。
只有按公开 range/tx refetch/recompute 且 semantic roots 一致才能授权分母；取不回的批次必须保持
`declared_not_replayed`，显示 partial/unknown，不得进入 population denominator 或排名。

### PoC-0：许可与供应链冻结（0.5–1 工程日）

- 锁 Ponder、SQD/Pipes、Graph Node、协议 SDK/ABI 的 commit、包 version、tarball integrity、
  LICENSE/NOTICE 和直接/可选依赖清单。
- Envio 在法务给出书面结论前保持 `license_blocked`；GMX BSL、无 LICENSE subgraph 保持
  `read_only_reference`；同时冻结 GMX 两个 ENS 许可登记项的解析值、区块和内容 SHA。
- `hl-visor`/`hl-node` 必须分别冻结下载位置、签名、公钥、binary SHA 和适用条款；许可未明确时
  `binary_license_unknown`，不得因为 node 仓库有 Apache-2.0 就进入 runtime。
- 固定 2 个独立 RPC/数据来源及预算 owner；同一供应商的两个域名不算独立来源。

退出门：每个要执行的 artifact 都有明确许可证、SHA、获取位置、允许运行范围和 owner；任何
`unknown` 都阻止该 artifact 进入 PoC runtime。

### PoC-1：GMX Arbitrum EventEmitter（2–3 工程日）

- 用 Ponder 扫一个冻结的 completed UTC 7 天区间；只做 order/position/fee/funding/borrowing/
  liquidation/cashflow 的 canonical fact skeleton，不先算排名。
- 同区间用第二 archive RPC 或 SQD raw stream 获取候选集合；官方 GMX GraphQL/Reader 只做
  reference subset、current-state 和结果差分，不能成为人口真值分母。
- 选 50 个 golden wallets：top 15、随机 20、高频/partial/liquidation 15；逐 tx 定位所有差异。
- 注入重启、重复 batch、替代 block hash、unknown EventEmitter key 和 ABI upgrade fixture。

退出门：以独立 header/block census（含空块）证明冻结区间 produced block coverage = 100%；按冻结
candidate identity 计算 decode ≥99.5%；所有 unknown 有 locator/reason 且零进入排名；同输入冷重建
fact-set SHA 相同；50 钱包 position/cashflow 守恒。官方 GraphQL 覆盖率只作诊断，不授权分母。

### PoC-2：Hyperliquid 官方 node/S3 重叠（2–3 工程日）

- 运行 non-validator 的 24 小时 live fills/replica commands；取官方 S3 同一重叠区间并按 block、
  tid/oid/fill identity 做 exact diff。
- 用 Info API 和 SQD `hyperliquid-fills` 对 golden wallets 做第三/第四视角，但登记各自 lineage，
  未证明独立时不计独立来源。
- 专门包含 >10,000 recent fills 的高频账户、subaccount/vault、funding、liquidation、deposit/
  withdraw 和开窗仓位。

退出门：live/S3 重叠无未解释缺块或重复；格式切换可检测；Info cap 自动产生 partial；缺 funding/
cashflow/anchor 的钱包即使 closed PnL 存在也不能 rank eligible。

### PoC-3：gTrade 单链生命周期（2–3 工程日）

- 只选 Arbitrum 一个当前 active diamond 和一个 completed UTC 7 天区间，复用 PoC-1 的 Ponder/
  Arena fact skeleton。
- 官方 SDK 只提供类型/公式参考；链事件为主事实，Backend/WebSocket/history 为 current/shadow diff。
- golden cases 覆盖 increase、partial decrease、close、liquidation、不同 collateral、borrowing/funding/
  holding fee 和 facet upgrade 边界。

退出门：每个 closed position 能从 opening anchor 到 close 重演，净 PnL 与全部费用逐项可解释；
Backend 差异有固定 reason；Top-25 外事件钱包可以被发现但未过 cost/price 门时保持 partial。

PoC-3 只验证 gTrade EVM/Arbitrum，不能被表述为覆盖 Gains Solana 产品面。后者先做 1–2 工程日的
独立链路发现：冻结官方前端 artifact，抽样跑通 deposit → trade → close → withdraw，绑定 Solana
signature、bridge intent/fill、EVM tx/contract、smart-trader 和费用。退出门是每一步都有公开链定位、
控制关系和 exact cashflow，且已确定真实 execution chain；未通过就保留显式 gap。只有确认存在原生
SVM program 后，才进入 program/IDL 与 SVM decoder 设计。

不要同时铺开四种索引器和三种协议。顺序固定为 PoC-0 → GMX → Hyperliquid → gTrade EVM →
Gains Solana 链路发现；任一退出门失败先补证，不以换工具掩盖协议语义缺口。

## 8. 生产晋级验收门

### 8.1 覆盖与可重放

- 发布区间 produced block/slot coverage = 100%；分母来自独立 header/slot census，空块纳入，所有合法
  skipped slot 有独立目录证明，不能用“返回了候选的块”反推完整区间。
- protocol candidate decode ≥99.5%；分母、candidate identity 和去重规则由 pre-decoder selector 合同
  冻结，unknown candidate 保留在分母并逐项有 tx/reason。
- 继承 `arena.dex.denominator-eligibility-attestation@1`：原始 acquisition 与一次独立 acquisition
  refetch 必须在同一 public window/selector/protocol/finality 合同下重算 selection、candidate、
  membership semantic roots，全部相等才可令 `population_denominator_authorized=true`。官方 API、
  榜单或第二索引器若未通过同一无环证明，只能作 reconciliation，不能自封人口真值。
- “覆盖大部分公开交易员”同时要求：按冻结协议 inventory 计算的协议广度 ≥80% volume proxy；每个
  已支持协议的 90D 活跃钱包覆盖 ≥95%；用户角色抽样 precision ≥99%。协议广度和协议内钱包覆盖
  必须分开报告，Gains Solana 等未证明 execution path 的产品面作为显式 gap 保留，不能从分母删除。
- 任一 `from/to` 重跑两次 canonical fact-set SHA 相同；中断后从 checkpoint 恢复无重无漏。
- 空集群可从已授权保留物 + 可重新获取 provider 区间恢复；只恢复数据库、不验证 provider refetch
  不算通过；refetch 失败必须得到 `declared_not_replayed`，不能沿用旧的 denominator authorization。

### 8.2 指标与排名安全

- 每个 ranked wallet/window 的 lifecycle、price、cost、cashflow、method、freshness 必须全部 complete；
  聚合层不得通过阈值豁免单个未知事实。
- 链原始 token 整数、decimals、event identity、fee/funding/borrowing 分项和账本守恒必须 exact match；
  只有协议合同明列的整数精度/rounding 单位可作为 canonical tolerance，展示层 rounding 不得回写事实。
- 外部 API/GraphQL/board 的 USD 差分阈值
  `abs(actual-reference) <= max(1 USD, 0.005 * abs(reference))` 只用于 reconciliation 告警和定位，不会
  授予事实可信、历史完整或 `rank_eligible`。当双方窗口/公式/资金流/价格语义完全相同时，canonical
  结果仍必须在协议合同精度内一致；超出即 unknown/partial，补证前不得排名。缺可信历史价格/FX 时
  USD 值必须为 null。
- opening inventory 不明、外部转入成本不明、cap/retention 命中、未闭合 partial close、分页未耗尽、
  decoder unknown、价格/FX 缺失、source stale 任一命中，数据库必须推导 `rank_eligible=false`。
- 恶意测试直接提交 `verified=true`、伪造高分或缺 evidence 外键必须失败；API 不能覆盖数据库 verdict。
- 首页人数、交易所页、详情和结构化数据都从同一 active run 读取，partial/unknown badge 和方法说明
  不得只在详情页出现。

### 8.3 实时、容量与退出

- finalized event → fact p95 ≤5 分钟、p99 ≤15 分钟；fact → serving p95 ≤15 分钟。达标前只称
  near-real-time，不称 real-time。
- catch-up 吞吐 ≥目标链峰值 3 倍；CPU/内存/磁盘持续水位 <70%；checkpoint 停滞 15 分钟报警。
- 实测并记录每百万 candidate、每百万 decoded fills、每万钱包和一次 90D 回填的时间/流量/费用。
- 主 provider 断流时 checkpoint 不跳洞；fallback 只能从同一已证明高度续扫。切源后同区间 checksum
  对账通过，才恢复发布。
- 新 decoder bad deploy、reorg、价格源漂移或未知事件率超门时，停止新发布并保留上一代 stale 快照，
  绝不能用空结果或 partial 覆盖 canonical。

## 9. 实施顺序与预计时间

以下是单人聚焦实现预算，不是跳过验收门的发布日期；法务答复、供应商授权、节点同步、硬件采购和
至少 14 天观察是额外 calendar dependency，不能塞进工程日数字：

| 顺序 | 工作包                                | 预计             | 产物                                             |
| ---- | ------------------------------------- | ---------------- | ------------------------------------------------ |
| 1    | 许可/依赖/官方 deployment manifest    | 0.5–1 工程日     | 锁 SHA 的 license 与 protocol evidence ledger    |
| 2    | GMX Arbitrum Ponder 7D PoC            | 2–3 工程日       | candidate/fact/checkpoint/reorg/diff 报告        |
| 3    | Hyperliquid node/S3 24h overlap       | 2–3 工程日       | block/fill/command 完整性与 API cap 报告         |
| 4    | gTrade Arbitrum 7D lifecycle PoC      | 2–3 工程日       | position/fee/cashflow/price/cost shadow ledger   |
| 5    | Gains Solana execution-path discovery | 1–2 工程日       | Solana/bridge/EVM identity 与 cashflow trace     |
| 6    | 首协议 90D shadow + 无环分母对账      | 3–7 工程日       | coverage、partial reasons、成本、SLA、重建报告   |
| 7    | 协议 inventory + 人口覆盖             | 约 2–4 周        | ≥80% 协议广度、≥95% 钱包覆盖、overlap/gap 矩阵   |
| 8    | 14 天 near-real-time shadow/canary    | 至少 14 日观测期 | 告警、灾备、回滚、UI provenance 和 Go/No-Go 证据 |

实施时每个“manifest/fixture → acquisition → decoder → ledger → quality → shadow publish → UI/Score”
必须分成可回滚的小 commit，测试通过就 push；不得把 schema、writer、provider 和公共 cutover 堆在一个
提交里。公共排名切换是独立授权和独立发布窗口。

## 10. 方法参考的严格边界

### Rotki

[Rotki](https://github.com/rotki/rotki)是 AGPL-3.0。可研究它的 transaction decoder、accounting
rules、transfer cost-basis、wrap/unwrap/DeFi deposit 处理和重新 decode 思路；不可直接复制到 Arena
闭源服务或把其结果当公开钱包的权威账本，除非法务确认 AGPL 义务并接受相应发布方式。Arena 的
公式、测试和实现必须独立完成并保留自己的 provenance。

### DefiLlama

[DefiLlama Adapters](https://github.com/DefiLlama/DefiLlama-Adapters)和
[dimension-adapters](https://github.com/DefiLlama/dimension-adapters)可参考协议地址发现、链上 TVL/
volume adapter 结构、历史 timestamp 测试和跨链归类方法；审计时两仓均无根 LICENSE，因此不复制
代码。DefiLlama 的协议/交易量聚合可作“优先覆盖哪些协议”的外部参考，不能证明单个交易员、
生命周期、历史执行价、成本基础或 Arena 排名准确。

## 11. 官方资料索引

- Ponder：[仓库](https://github.com/ponder-sh/ponder) ·
  [chain/RPC 配置](https://ponder.sh/docs/config/chains) ·
  [call traces](https://ponder.sh/docs/guides/call-traces) ·
  [self-hosting](https://ponder.sh/docs/production/self-hosting)
- Envio：[HyperIndex](https://github.com/enviodev/hyperindex) ·
  [许可](https://docs.envio.dev/docs/HyperIndex/licensing) ·
  [Solana HyperIndex](https://docs.envio.dev/docs/HyperIndex/solana) ·
  [Solana HyperSync](https://docs.envio.dev/docs/HyperSync/solana)
- SQD：[Portal](https://docs.sqd.dev/en/portal/overview) ·
  [Pipes SDK](https://github.com/subsquid/pipes-sdk) ·
  [Squid SDK](https://github.com/subsquid/squid-sdk) ·
  [私有 Portal 设置](https://docs.sqd.dev/en/portal/self-hosting) ·
  [self-host Portal](https://github.com/subsquid/sqd-portal)
- The Graph：[Graph Node](https://github.com/graphprotocol/graph-node) ·
  [Graph Node 运维](https://thegraph.com/docs/en/indexing/tooling/graph-node/) ·
  [Subgraph 结构](https://thegraph.com/docs/en/subgraphs/overview/)
- Hyperliquid：[node](https://github.com/hyperliquid-dex/node) ·
  [historical data](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data) ·
  [Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) ·
  [L1 schemas](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/l1-data-schemas)
- GMX：[GraphQL](https://docs.gmx.io/docs/api/graphql/) ·
  [contract architecture](https://docs.gmx.io/docs/api/contracts/architecture/) ·
  [event monitoring](https://docs.gmx.io/docs/api/contracts/events/) ·
  [`gmx-synthetics`](https://github.com/gmx-io/gmx-synthetics) ·
  [BSL LICENSE](https://github.com/gmx-io/gmx-synthetics/blob/main/LICENSE)
- Gains/gTrade：[active contracts](https://docs.gains.trade/what-is-gains-network/contract-addresses) ·
  [gTrade Solana](https://docs.gains.trade/gtrade-leveraged-trading/gtrade-solana) ·
  [Solana 产品入口](https://sol.gains.trade/) ·
  [Backend](https://docs.gains.trade/developer/integrators/backend) ·
  [SDK](https://github.com/GainsNetwork-org/sdk)
