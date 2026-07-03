# 漂移暴露的功能状态 — cut / finish / fix 台账（2026-07-03）

> 长期最优 #3「砍掉或补完半死功能」的核查结论。列漂移扫描(qa:insert-drift)把一批
> code↔schema 大分叉的功能顶了出来。核查可达性后发现：**没有真正"废弃可删"的功能**——
> 它们是 live / 预上线 / 计划中三态。**因此不做单方面删除（删预上线/计划功能是产品决策，
> 且明显不是团队想要的）。** 分类 + 建议如下。

## 分类（按可达性核查）

| 功能             | 页面路由                | 导航/UI 入口                               | 状态            | 建议                                                                                |
| ---------------- | ----------------------- | ------------------------------------------ | --------------- | ----------------------------------------------------------------------------------- |
| **quiz**         | ✅ `(quiz)/quiz`        | ✅ MobileBottomNav/CookieConsent           | **LIVE**        | 保留。matchPercent 漂移已修。                                                       |
| **competitions** | ✅ `(app)/competitions` | ❌ 无 nav link                             | **预上线/孤儿** | 产品决策：要上就补齐 schema（见下），不上就删页面+路由。别放着 URL 可达却 400/500。 |
| **attestation**  | ❌ 无页面               | ❌ 仅 OnChainBadge 占位("feature pending") | **计划中**      | 保留 stub。API/表已建（本轮补了列），但无 UI——等真做时接。                          |
| **NFT 会员**     | ❌ 无页面               | ❌ 无                                      | **计划中**      | 同上。webhook handler 存在但无入口。                                                |

## competitions 的 schema↔code 分叉（若要上线需补齐）

代码读写的列 vs `competitions`/`competition_entries` 实际列：

- `competitions`: 代码要 `name/season_id/start_date/end_date/prizes`，表是 `title/start_at/end_at/prize_pool_cents`、无 `season_id`。
- `competition_entries`: 代码要 `source/score/roi/pnl/updated_at`，表是 `platform/current_value/baseline_value`。

**这是"按一套没落地的设计写了一半"**。要上线：对齐（改代码用真列名，或加列）+ 端到端测。
要放弃：删 `app/(app)/competitions/*` + `app/api/competitions/*`。**需产品拍板，本轮不擅动。**

## 读漂移 backlog（19 处，advisory）

大部分不是这几个功能，而是**live 路由的真实读漂移**（select 了不存在的列 → 400，通常降级为空）：
admin/anomalies、admin/reports、collections、compute-leaderboard/cache、expire-mutes、
export/rankings、groups membership/approve、health/detailed、platforms/health、portfolio/positions、
traders percentile/positions、users activities、trader-queries。

**已修 14/19（有明确正解的全修）** —— 都是"读了不存在的列→400"的 live bug，几处高影响：
account 订阅永远 tier:free、群封禁检查永远失效、静音永不过期、活动页整个 500、CSV 导出 400、
版主/异常/举报读真列名。修法：改真列名 / PostgREST 别名 `key:real_col`(保持返回 key 下游零改动) /
去掉无等价的死列。

**后续又查定义/表结构确认后修掉 3 处 → 17/19 修完（都不是猜）：**

- `percentile`：storage.ts:173 + arena-score-v3 确认三支柱 profitability/risk_control/execution =
  旧命名 return/drawdown/stability，别名到真列。
- `traders/positions`：核实两表列确认**查错表**（trader_portfolio 快照→trader_positions_live 实时），
  重构到实时表 + 字段映射（side/quantity/unrealized_pnl(\_pct)）。
- `collections`：查 insert 确认多态存储（item_type post/activity），读改 item_id/item_type。

**剩 2/19 —— competitions（唯一真产品阻塞）：** `competitions`/`competition_entries` 读
`name/season_id/start_date/prizes` / `score/roi/pnl`——表是 `title/start_at/prize_pool_cents` /
`current_value/baseline_value`，**非干净重命名**（score≠current_value？prizes 是 JSON 还是 cents？
season_id 无等价）。代码按另一套数据模型写、预上线未链接。**不猜**（猜错=上线后错数据）。需产品定:
上→定义数据模型对齐，不上→删 `app/(app)/competitions/*` + `app/api/competitions/*`。

写漂移清零、读漂移 **17/19** 修完（仅剩 competitions 产品阻塞）。`STRICT_READS=1` 可升级读为硬门
——建议 competitions 定夺后再开。

## 结论

- **不删任何功能**（无真废弃；预上线/计划的删了是错）。
- **competitions 是唯一需要产品拍板的**（上→补齐，不上→删）。
- **19 处读漂移是 live bug backlog**，qa:insert-drift 已追踪，逐条修，修完开 STRICT_READS。
- 长期防线已就位：#1 三道 CI 门（qa:insert-drift 写硬门/读咨询、cast 棘轮、gen-types-check）
  绑定 code↔types↔prod；#2 支付金丝雀揪 promo 掩盖的失败。
