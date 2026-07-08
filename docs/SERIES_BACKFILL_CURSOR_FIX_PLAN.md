# Series-Backfill 游标不持久化 — 根因诊断 + 修复（✅ 已修复并验证 2026-07-07）

> 状态：**已修复并端到端验证**。真根因=FK 违规(见下),已 migration 去 FK +
> tier-b-series F1/F2 + 双节点部署 + HL 启用回填;实测游标首次落库(bitget_spot=8)。
> 诊断/修复日期 2026-07-07,生产实测(prod `iknktzifjdyujdccyhsv`)。此 bug 曾是全站
> CEX 长尾风险指标缺口(sharpe/mdd/pnl)的**单一根因**。(初版本文为待批方案,已执行。)

## TL;DR

`tier-b-series`（长尾深抓 tier）的进度游标从不落库，导致每轮都从 band 头部
重抓同一批 `batch` 个交易员，**band 尾部（数千个已排名交易员）永远抓不到**。
因此这些交易员的 profile-only 指标（Sharpe/MDD/PnL）长期为空——不是 parser 坏、
不是源头不给，是**深抓覆盖的引擎在原地打转**。

## 实测铁证

1. **`arena.ingest_cursors` 无 `series_backfill` 行**（其它 kind 都有）：
   ```
   position_history 12554 行 · orders 4744 · copiers 6773 · transfers 3424
   series_backfill  0 行   ← 从未成功落库
   ```
2. **抓取次数 ≫ 覆盖交易员数**（7 天窗口）：
   | source | tier_b_series raw (7d) | 不同交易员数 | band 应覆盖 |
   |---|---|---|---|
   | bitget_spot | 3,559 | **32** | ~5,200 (301→5,515) |
   | mexc_futures | 2,595 | 66 | — |
   | xt_futures | 2,250 | 33 | — |
   | binance_futures | 201 | **14** | ~9,600 (301→9,950) |
   | binance_spot | 183 | 13 | — |

   bitget_spot 把 rank 301–332 抓了 ~111 遍，rank 333–5515 一次没抓。

3. **填充率随 rank 断崖**（binance_futures tf30，印证「只有头部被覆盖」）：
   | rank band | n | sharpe | mdd |
   |---|---|---|---|
   | 1–300（Tier-B 热抓） | 115 | 38.3% | 86.1% |
   | 301–1000 | 238 | 25.6% | 63.0% |
   | 1001+ | 1,179 | 7.6% | 28.8% |
   | 未排名尾部 | 12,952 | 0.7% | 12.9% |

## 代码路径（`worker/src/ingest/processors/tier-b-series.ts`）

```
offset = readCursor(src.id)            // 无行 → 恒返回 0    (:172)
if (offset >= total) offset = 0
traders = getBandTraders(offset, batch)// 恒取 band 头部 batch 个 (:175)
try {
  for (trader of traders) {
    ... adapter.getProfile() ...       // 抓 detail+performance+charts
    writeRawObject(...)                // ← raw 在循环内写（所以 raw 有）(:212)
    publishProfile(...)                // ← 指标落库
  }
} finally { session.close() }
nextOffset = ...                       // (:259)
writeCursor(src.id, nextOffset)        // ← 游标在循环后写（从未执行到）(:261)
```

**关键错位**：raw object 在循环内逐个写（持久化了），游标只在**整个循环跑完之后**
写一次。只要 job 在跑完前被中断，raw 留下、游标不动，下一轮 `readCursor` 又拿到 0。

## ★ 真根因(2026-07-07 实测确认，推翻下方 H1/H2/H3 假设)

`arena.ingest_cursors.trader_id` 有 **外键 `ingest_cursors_trader_id_fkey`
→ arena.traders(id) ON DELETE CASCADE**。但 series_backfill 的游标用**负数哨兵**
`trader_id = -sourceId`(见 tier-b-series.ts readCursor/writeCursor),arena.traders
里没有负 id 行 → **每次 writeCursor 抛 23503 外键违规**,游标永远写不进去。

实测铁证:`INSERT INTO arena.ingest_cursors (trader_id,kind,...) VALUES (-15,
'series_backfill',...)` → `ERROR: 23503 Key (trader_id)=(-15) is not present in
table "traders"`。表的 CHECK 约束已列入 `series_backfill`、代码注释也明确「负数
哨兵不与正数真 id 冲突」——即**原设计就要放哨兵行,只是加 kind 时忘了 FK 会挡**。

所以:raw object 在 writeCursor 之前写(line 212)→ raw 有;writeCursor 抛异常
→ 游标无、job 标记失败重试 → 下轮 readCursor 恒 0 → 重抓 band 头部。与「job 被杀」
表象一致,但**真因是 FK 违规,不是 stall/OOM**。下方 H1/H2/H3 均已排除。

**修复 = 去掉该 FK**(migration `..._drop_ingest_cursors_trader_fk`):表本就是
「按需存 per-trader(正)+ per-source 哨兵(负)双用途」,FK→traders 与该设计天然
冲突,是它错。去掉后既有代码(负哨兵)即可写入。per-trader 游标失去 ON DELETE
CASCADE 清理 → 交易员删除后留孤儿游标行(永不读、id 不复用,无害;需要时用
maintenance sweep 清)。代码侧的 F1(增量写游标)/F2(deadline<lock)保留为纵深防御
(kill 时进度不丢)。

## ~~为什么 job 跑不完~~（下列假设已被上方真根因推翻，存档备查）

- **H1 — 硬杀 / BullMQ stall（最可能）**：`ingest-worker.ts` 配 `lockDuration=180_000`
  且 tier-b-series 的 `series_backfill_deadline_ms` **也是 180_000**。deadline 只在
  **交易员之间**检查（`if (attempted>0 && elapsed>deadline)`），单个交易员的 3×TF
  crawl 可让本轮越过 180s；lock 到期后 stall checker（`stalledInterval=300_000`,
  `maxStalledCount=2`）判定 stalled → 重排/杀进程 → 被杀那次永远到不了 `writeCursor`。
  deadline == lockDuration 是明确的坏味道：应 deadline < lockDuration，job 才能在 lock
  失效前主动让出并落游标。
- **H2 — 运行节点代码陈旧**：SG VPS 跑的是 `/opt/arena-ingest` 的 rsync 拷贝、非 git
  （历史上漂过 18 天/87 commit）。若跑 tier-b-series 的节点上 `writeCursor`/游标 kind
  的代码是旧版或有 bug，也会 raw 有、游标无。**须先核对部署 SHA**。
- **H3 — 异常绕过**：`writeCursor` 在 `try{}finally{}` 之后（:259-261）。若 finally 里
  `session.close()` 抛、或循环外某处抛，函数经异常退出，游标写被跳过。inner per-TF
  try/catch 吞了抓取错，但 close/控制流的异常不在其内。

无论是哪个（很可能 H1），**修复都应让进度增量落库**，不依赖「跑完整轮」。

## binance 专项异常

binance_futures/spot 7 天只有 ~200 次 tier_b_series、~14 个交易员，比 bitget（3559）
少 ~17×。band 更大（~9,600）反而跑得更少 → 每次 job 更重（binance profile =
detail+performance+chartRoi+chartPnl+coinPreference × 3TF），更容易在完成前被杀（呼应
H1）；也可能 binance backfill 路由到某个过载/停摆的 region 队列。**须查 binance 的
tier_b_series 走哪个 region、该 region worker 是否健康。**

## 修复方案（推荐组合，全部待批）

### F1 — 游标增量持久化（核心，必做）

在循环内**每抓完 1 个交易员就写游标**（`offset + i + 1`），而非只在循环末尾写一次。
任何中断都保住进度，下一轮从真实位置续抓。幂等 upsert 已保证重抓安全。

- 代价：每交易员多 1 次轻量 upsert（可每 5 个写一次折中）。
- 效果：无论 H1/H2/H3，尾部都能被逐步推进覆盖。

### F2 — deadline < lockDuration

把 `series_backfill_deadline_ms` 降到 ~120s（< 180s lock），保证 job 在 lock 失效前
主动 break → 落游标 → 让出 slot。消除 H1 的杀-in-flight 窗口。

### F3 — 核对并统一部署 SHA（排除 H2）

`worker/deploy-ingest-sg.sh` 前先比对两节点 `resolveDeployedSha` 与 git HEAD；确认跑
tier-b-series 的节点跑的是含 writeCursor 的当前代码。

### F4 — binance backfill 路由/健康排查

确认 binance tier_b_series 的 region 队列与 worker 存活；必要时提高其 `series_backfill_batch`
或单独调度，让最大的两个板不再垫底。

### F5（可选）— 覆盖度可观测

tier-b-series 结束时把 `bandSize / distinct-covered / cursorTo` 写进 pipeline log 或
一个 `arena.metric_fill_trend` 邻近表，让「游标是否在推进」肉眼可见（本次就是靠人肉
SQL 才发现，Phase 4.1 的 fill-rate 比率哨兵是另一道兜底）。

## 部署纪律（铁律，务必遵守）

- **worker 单通道部署**：一次一个会话，优先 CI 产物流水线；**绝不多会话并发手工
  `deploy-ingest-sg.sh`、绝不在 SG box 上 `npm ci`**。dep 无变走 `--code-only`。
- 改动先在隔离 worktree 跑 `tsc`/相关 test 干净，再落共享树（`database.types.ts` 等
  核心文件本次不涉及，但 worker 编译共享）。
- 部署后验证：查 `arena.ingest_cursors` 出现 `series_backfill` 行且 `cursor_value`
  递增；查目标源 `distinct_traders`（7d）开始上涨；抽查尾部交易员 sharpe/mdd/pnl 回填。

## 验证脚本（部署后）

```sql
-- 游标开始存在并推进
SELECT -trader_id AS source_id, cursor_value, updated_at
FROM arena.ingest_cursors WHERE kind='series_backfill';

-- 覆盖交易员数应显著上升（对比本文档表中的 32/66/33/14）
SELECT s.slug, count(DISTINCT r.trader_id)
FROM arena.raw_objects r JOIN arena.sources s ON s.id=r.source_id
WHERE r.job_type='tier_b_series' AND r.fetched_at > now()-interval '24 hours'
GROUP BY s.slug ORDER BY 2;
```

## 预期收益

修复后，band 内每个已排名交易员最终都会被抓到 detail+performance：

- binance/bitget/mexc/xt/gate 等 CEX 的 sharpe/mdd/pnl 长尾从个位数%爬向「热门 band
  同等水位」（binance sharpe 上限受源头稀疏约束 ~40%，mdd ~80%+，pnl 近满）。
- **残余空缺 = 真上游稀疏**（币安 detail 对 ~56% 交易员就是不返回 sharpRatio）→ 按
  2026-07-02 死命令 honest-NULL，不自派生。修复目标是「抓满源头给的」，不是「填满」。

## 遗留项处置(2026-07-07 收尾)

1. **SG dep 漂移** → ✅ **已 un-drift**(2026-07-07,SG DEPLOYED_SHA 现=main HEAD)。
   判断:SG sha(39c5f447)→ HEAD 的 dep 变更**全是 bump(无新 worker 模块;ws 是 viem
   传递依赖已在)**→ SG 现有 node_modules 可跑当前代码(单文件热修已证)。故走**零磁盘
   风险的全量 code rsync**(lib/worker/tsconfig,排除 node_modules),不动 node_modules
   (SG 磁盘 90% 满,node_modules swap 峰值仅剩 ~0.7G 太险)。tar 备份 code(1.7M)→
   rsync → 写 DEPLOYED_SHA → pm2 restart + ready 门(失败自动回滚)。SG worker ready。
   **✅ 已彻底 un-drift(2026-07-08)**:SG 现跑**全新 Node-22 node_modules(匹配 main
   lock)+ 当前代码**,DEPLOYED_SHA=c3ef97e2c,worker ready,binance 游标在 SG 上推进
   (offset 53→54→55)。路径=CI build-deps 出 artifact → Mac 下载 → `deploy-ingest-sg.sh
--from-artifact`(Mac→SG 稳定链路)。过程中修了 3 个真 bug(见下)。
   **CI 单通道**:两 secret 已配(专用部署密钥,非个人 key)+ 修了 workflow 的
   publickey bug(Setup SSH 追加 `~/.ssh/config` 绑 id_sg,原来裸 ssh/rsync/scp 不吃
   `GIT_SSH_COMMAND`→255;这也是该 workflow 从未跑绿的原因)。build-deps ✅、deploy-sg
   已过 auth+backup。**但仍未跑通**:node_modules artifact 换上去后 worker 起不来
   → 自动回滚(SG 无损,现仍在旧可用 node_modules)。根因几乎肯定是**原生模块 ABI 不匹配**
   —— CI runner 的 Node ≠ SG 的 **v22.22.0**。**已修的 3 个 bug(都 commit 了)**:(a) build-deps Node 20→22 匹配 SG(原生
   ABI);(b) 加载烟测改真 import(原 require.resolve 只查文件不加载原生绑定,放行了坏树;
   用 async IIFE 避开 tsx --eval 的 top-level-await 限制);(c) deploy 脚本 ready-check
   加宽日志窗口 50→400 + 延长 30→90s(worker 话痨,ready 行几秒滚出小窗口 → 明明 ready
   也误判失败并误回滚)。**仅剩 nicety**:CI deploy-sg 的 GH-runner→Vultr 直连大传输仍会
   drop(255),已用 Mac-mediated 交付绕过;要全自动可把 deploy-sg 改成 Mac-runner 或加
   传输重试。功能与 hygiene 均已完成。
2. **local worker ↺100 = 非活跃问题**:exit 130=SIGINT(手动 restart)、mem 64MB
   (非 OOM)、重启前已稳定 3 天;100 是**生命周期累计**(含历史已修的 EDBHANDLEREXITED
   等),非重启循环。无需处置,持续观察即可。
3. **Phase 3 hyperliquid** → **已启用 series_backfill**(config:`meta.series_backfill_topn
=100000, batch=30`,jsonb merge 保留 expected_metrics)。HL sharpe 本就自派生
   (`risk_derivation=daily-approx`, risk_samples 43-46),~1150 深抓交易员已有;缺口纯
   是**序列深度**——HL 原不在回填带(topn=NULL)。cursor 修复后启用回填,ranks 501+ 会
   逐步深抓 equity series + fills → tf30/tf90 self-derive Sharpe/Sortino/mdd + win_rate
   (fills-replay)覆盖上升。**tf7 保持低是真统计下限**(7 日线 < MIN_RATIO_POINTS+1=8,
   即便算出也是噪声),honest。gtrade(18%)同理可按需启用。

## 关联

- 显示层/评分依赖：`risk_control_score`/`execution_score` 用 mdd/sharpe，长尾修复后
  这些评分的 `score_completeness` 会上升。
- 护栏：Phase 4.1（fill-rate 比率阈值 + 按 tf 拆分）应能在未来自动逮到此类「长期低于
  阈值」的退化——本次是人肉发现的，说明现有「仅字面 0」哨兵漏了它。
