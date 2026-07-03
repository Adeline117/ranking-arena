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

已修范式：auto-post(leaderboard_ranks display_name→handle/roi)、moderation(posts.user_id→author_id)、
messages(conversations 去 updated_at)。**其余逐条改真列名即可，qa:insert-drift 读咨询已追踪。**
写漂移已清零（硬门绿）。设 `STRICT_READS=1` 可把读也升级为硬门（建议修完 19 处后开）。

## 结论

- **不删任何功能**（无真废弃；预上线/计划的删了是错）。
- **competitions 是唯一需要产品拍板的**（上→补齐，不上→删）。
- **19 处读漂移是 live bug backlog**，qa:insert-drift 已追踪，逐条修，修完开 STRICT_READS。
- 长期防线已就位：#1 三道 CI 门（qa:insert-drift 写硬门/读咨询、cast 棘轮、gen-types-check）
  绑定 code↔types↔prod；#2 支付金丝雀揪 promo 掩盖的失败。
