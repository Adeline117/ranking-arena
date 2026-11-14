# 全站"数据时间 / 更新时间"展示审计（2026-11）

## 背景与判据

数据实际停在 2026 年 7–8 月，但站内多处时间文案会让用户以为"数据是今天的"。
判据来自 `lib/rankings/source-freshness.ts`：

- `computed_at` 只表示 Arena 重新算分的时间，**不是**数据新鲜度；
- 数据新鲜度只能用来源水位（`leaderboard_source_freshness.source_as_of`），或同等含义的来源采集时间（快照 `scraped_at`、记录 `sourceAsOf`、新闻发布时间、成交/事件时间）；
- 没有可靠水位时显示"未知"或不显示，绝不回退成"现在"或 `computed_at`；
- 超过 48 小时（`RANKING_SOURCE_STALE_MS`）要标注"数据可能延迟"（`dataStaleWarning`）。

时间来源分四类：**来源水位**（正确）、**computed_at**（错误）、**渲染/请求时间**（错误，除非文案明确是"检查于/生成于"）、**其他**（事件时间、首次收录时间、内部运维等，逐条判断）。

## 汇总

共检查 45 处。

| 结论                                                                                           | 数量 |
| ---------------------------------------------------------------------------------------------- | ---- |
| 正确（来源水位、来源采集时间、事件时间，或文案明确写的是检查/生成时间）                        | 24   |
| 错误（`computed_at`、渲染/请求时间、首次收录时间），本 PR 已修                                 | 6    |
| 来源正确但展示会误导（只显示时分、纪元哨兵当真实时间、页脚取最新时间、缺延迟标注），本 PR 已修 | 6    |
| 错误，由 PR #406 修复（本 PR 不改）                                                            | 2    |
| 内部或管理端，不面向用户，不修（其中 2 处列入门禁允许清单）                                    | 4    |
| 留给 owner 决定                                                                                | 1    |
| 其他：死代码随上游修正（#19）、接口有字段但没有界面使用（#39）                                 | 2    |

## 明细

### 核心路径：首页与排行榜

| #   | 位置                                                                                       | 时间来源                                                             | 结论                                                                        | 已修                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | `app/components/home/RankingControls.tsx`"数据截至"                                        | 来源水位（`getInitialTraders` → `summarizeSourceFreshness`，取最旧） | 来源正确，但只显示"时:分"，8 月的数据读起来像今天；没有延迟标注             | 已修：非当天的时间带日期（跨年带年份），超过 48 小时追加"数据可能延迟"，纪元哨兵不显示 |
| 2   | `app/components/home/RankingFooter.tsx` 相对时间和延迟横幅                                 | 来源水位，`isStale`                                                  | 正确                                                                        | 无需修                                                                                 |
| 3   | `/api/traders` 的 `lastUpdated`、`updated_at`                                              | 来源水位                                                             | 正确                                                                        | 无需修                                                                                 |
| 4   | `/api/rankings` 的 `as_of`、`updated_at`                                                   | 来源水位                                                             | 正确                                                                        | 无需修                                                                                 |
| 5   | `/api/v2/rankings` 的 `updated_at`、`staleness_seconds`                                    | 来源水位                                                             | 正确                                                                        | 无需修                                                                                 |
| 6   | `/api/rankings/live` 的 `as_of`                                                            | 固定为 null（未知）                                                  | 正确                                                                        | 无需修                                                                                 |
| 7   | `app/(app)/rankings/exchanges/ExchangeRankingsClient.tsx` 每行"截至"列                     | RPC `arena_exchange_rankings` 的 `scraped_at`（来源采集）            | 正确                                                                        | 无需修（页脚统一标延迟）                                                               |
| 8   | 同上，页脚"Arena · 截至"                                                                   | 取所有行中**最新**的 `asOf`                                          | 来源正确，但取最新会让一个新源掩盖其他过期源                                | 已修：改取最旧（与首页水位规则一致）                                                   |
| 9   | `app/(app)/rankings/weekly/WeeklyArenaClient.tsx` 每行"更新"列                             | RPC `arena_weekly_leaders` 的 `scraped_at`                           | 正确                                                                        | 无需修                                                                                 |
| 10  | 同上，页脚"Arena · 截至"                                                                   | 取最新 `asOf`                                                        | 同 #8                                                                       | 已修：页脚改取最旧；"本周区间"仍按最新快照计算                                         |
| 11  | 同上，BitMart 官方周榜页脚                                                                 | `sources.meta` 中的 `fetchedAt`（抓取官方结果的时间）                | 正确（来源采集时间）                                                        | 无需修                                                                                 |
| 12  | `app/components/common/ProvenanceFooter.tsx`（交易所排行、周榜、代币榜、交易员资料页共用） | 各调用方传入的来源时间                                               | 来源正确；但服务端用 `1970-01-01` 表示未知，会显示成"56 年前"；没有延迟标注 | 已修：纪元或无效值显示"未知"，超过 48 小时追加"数据可能延迟"                           |
| 13  | `app/(app)/rankings/tokens/*` 代币榜页脚                                                   | `sourceAsOf`，缺失时显示"未知"                                       | 正确                                                                        | 无需修（经 #12 获得延迟标注）                                                          |

### 核心路径：交易员详情

| #   | 位置                                                                                                                 | 时间来源                                                                            | 结论                                                                                     | 已修                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 14  | `TraderHeader`"更新于" + `getTraderDetail`                                                                           | main 上是 `computed_at`                                                             | 错误                                                                                     | 由 PR #406 修复，本 PR 不改                                                                                                   |
| 15  | `app/(app)/trader/[handle]/TraderProfileClient.tsx` 传给头部的 `lastUpdated`                                         | `detail.lastUpdated` → **`trackedSince`（首次收录时间）** → 快照 `asOf`             | 错误：#406 让水位缺失时返回 null，这里又回退成首次收录时间，等于抵消了 #406 的失败即关闭 | 已修：去掉 `trackedSince` 回退，只接受来源水位或快照采集时间，纪元哨兵视为未知（`app/components/trader/header-data-time.ts`） |
| 16  | `app/components/trader/performance/PeriodSelector.tsx`"更新于"（服务端资料页 `ServingProfilePanel` 传入快照 `asOf`） | 快照 `scraped_at`                                                                   | 来源正确，但只显示时分；纪元哨兵会显示成 1970 年某个时刻                                 | 已修：非当天带日期，超过 48 小时追加延迟标注，未知不显示                                                                      |
| 17  | `OverviewPerformanceCard` → `PeriodSelector` 的 `lastUpdated`                                                        | 没有任何调用方传值                                                                  | 未接线，不展示                                                                           | 无需修                                                                                                                        |
| 18  | `/api/trader/[platform]/[trader_key]` 的 `updated_at`、`is_stale`、`staleness_seconds`                               | `max(profile.updated_at, computed_at)`；没有数据时是 `1970-01-01`；按 24 小时判过期 | 错误                                                                                     | 已修：取已发布窗口中最旧的来源水位，任一窗口缺水位则为 null 且判过期；阈值改为 48 小时（`lib/rankings/source-watermark.ts`）  |
| 19  | `app/components/trader/TraderPageV2.tsx`"更新于"                                                                     | 来自 #18                                                                            | 死代码（没有页面引用），数据随 #18 修正                                                  | 随 #18 修正                                                                                                                   |
| 20  | `/api/traders/[handle]/full` 的 `updated_at`                                                                         | `detail.trader.lastUpdated`                                                         | main 上是 `computed_at`，#406 合并后为来源水位                                           | 依赖 PR #406                                                                                                                  |
| 21  | 交易员页 JSON-LD `ProfilePage.dateModified`（`lib/seo/structured-data.ts`）                                          | 调用方从不传值，回退成 `new Date()`（渲染时间）                                     | 错误：等于对搜索引擎声称"今天更新"                                                       | 已修：未知时省略该字段                                                                                                        |
| 22  | `app/components/common/RecordProvenanceFooter.tsx` 记录明细                                                          | `sourceAsOf` 和 `observedAt` 分开标注                                               | 正确；补了延迟标注和纪元哨兵处理                                                         | 已修（增强）                                                                                                                  |
| 23  | `app/components/trader/serving/TraderMetaStrip.tsx` 最近交易时间                                                     | 交易所给出的事件时间                                                                | 正确（事件时间）                                                                         | 无需修                                                                                                                        |
| 24  | `app/components/trader/serving/SignalChips.tsx` 最近爆仓时间                                                         | 事件时间                                                                            | 正确                                                                                     | 无需修                                                                                                                        |

### SEO：sitemap、OG 图片、徽章

| #   | 位置                                                                                         | 时间来源                                       | 结论                                                                   | 已修                                    |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| 25  | `app/sitemap.ts` 交易员页 `lastModified`                                                     | `computed_at`                                  | 错误                                                                   | 已修：改为该来源的 90D 水位，未知则省略 |
| 26  | `app/api/sitemap-xml/route.ts` 交易员页 `<lastmod>`                                          | `computed_at`                                  | 错误                                                                   | 已修：同 #25                            |
| 27  | 两份 sitemap 中静态页（/、/rankings、/market 等）的 `lastModified: now`                      | 生成时间                                       | 用户不可见；但对 /rankings、/market 这类数据页，等于对爬虫声称"刚更新" | 未修，留给 owner（见下文）              |
| 28  | OG 图片 `app/api/og/{trader,exchange,rank,compare,homepage,quiz}`、`app/api/share/rank-card` | 不展示时间（`computed_at` 只用于发布资格校验） | 正确                                                                   | 无需修                                  |
| 29  | 可嵌入徽章 `app/api/badge/trader/[handle]`                                                   | 不展示时间                                     | 正确                                                                   | 无需修                                  |

### 其他页面

| #   | 位置                                                              | 时间来源                                                            | 结论                           | 已修                                                                                 |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 30  | `app/(app)/flash-news/FlashNewsPageClient.tsx`"最后更新"          | 浏览器请求完成的时刻（`new Date()`），只显示时分秒                  | 错误：抓取停了也显示"刚刚更新" | 已修：改为最新一条快讯的发布时间，带日期，超过 48 小时追加延迟标注，列表为空时不显示 |
| 31  | `app/components/sidebar/NewsFlash.tsx`                            | 新闻 `published_at`                                                 | 正确                           | 无需修                                                                               |
| 32  | `app/components/market/CoreCards.tsx`"价格源检查于"               | 请求时间，文案明确写的是"检查于"                                    | 正确                           | 无需修                                                                               |
| 33  | `app/(app)/market/open-interest/OpenInterestClient.tsx`"数据截至" | 各行来源 `timestamp` 的最大值，超过 24 小时的行被隐藏并计数         | 正确                           | 无需修                                                                               |
| 34  | `app/components/market/LiveTradesFeed.tsx`                        | 成交事件时间                                                        | 正确                           | 无需修                                                                               |
| 35  | `app/components/feed/ActivityFeed.tsx`"更新于"                    | 最新动态的 `occurred_at`                                            | 正确（事件时间）               | 无需修                                                                               |
| 36  | `app/(app)/status/page.tsx` 来源新鲜度、最近发布、最后检查        | `build-freshness-report` 的水位；发布时间和检查时间文案都写得明确   | 正确                           | 无需修                                                                               |
| 37  | Hero 统计 `getHeroStats`                                          | 不带时间字段                                                        | 正确                           | 无需修                                                                               |
| 38  | 对比页 `app/(app)/compare`                                        | 不展示时间（`computed_at` 只用于发布资格）                          | 正确                           | 无需修                                                                               |
| 39  | 搜索结果、热搜 `lastUpdated`                                      | 结果不展示时间；热搜接口的 `lastUpdated` 是聚合时间，但没有界面使用 | 其他（未展示）                 | 无需修                                                                               |
| 40  | bot 页                                                            | `botDataAsOf` 键没有使用，页面不展示数据时间                        | 正确                           | 无需修                                                                               |
| 41  | 邮件模板 `lib/services/email.ts`、周报 `weekly-digest`            | 模板不含时间；周报路由已退役（返回 410）                            | 正确                           | 无需修                                                                               |

### 内部、管理端与运维

| #   | 位置                                                                                                                      | 时间来源                                     | 结论                                                                                          | 已修                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| 42  | `app/api/admin/observability/route.ts` 的 `latestUpdate`                                                                  | `computed_at`                                | 只有管理员可见，监控的是算分是否还在跑                                                        | 不修，列入允许清单                    |
| 43  | `lib/data/trader/mappers.ts` `mapLeaderboardRow().lastUpdated`                                                            | `computed_at`                                | 内部字段：`getInitialTraders` 把它写回 `computed_at` 做发布校验；展示前由来源水位覆盖（#406） | 不修，列入允许清单；#406 合并后可改名 |
| 44  | `daily-digest`（Telegram）、`weekly-report`、`lib/harness/health-checks.ts`、`compute-leaderboard-watchdog`、admin 监控页 | `computed_at` 或检查时间                     | 运维内部，监控算分活性；在 V1 下没有排程                                                      | 不修                                  |
| 45  | `/api/platforms/health` 的 `freshness`                                                                                    | `pipeline_logs.ended_at`（抓取任务结束时间） | 只有接口，没有界面使用                                                                        | 不修，记录在案                        |

PDF 导出（`lib/utils/export.ts`）页眉的日期是导出当天，页脚写的是"Generated by Arena"，属于生成时间，不是数据时间，未计入上表；页眉日期是否加"生成于"前缀交给 owner。

## 防复发门禁

- 脚本：`scripts/qa/data-time-honesty-check.mjs`（纯文件扫描，不联网）；单测：`scripts/qa/data-time-honesty-check.test.mjs`（纳入 `qa:sweep-unit`）；命令：`npm run qa:data-time`；挂在 `.github/workflows/ci.yml` 的 `lint-typecheck` 任务上。
- 规则（刻意窄而准）：
  1. `display-key-from-computed-at`：`lastUpdated`、`updated_at`、`asOf`、`lastmod`、`dateModified` 等展示时间键，从 `computed_at` 或 `computedAt` 取值；
  2. `render-computed-at`：`.tsx` 中把 `computed_at` 交给 `formatTimeAgo`、`toLocale*String`、`new Date`、`formatDataClock` 或 `dateTime=`；
  3. `tracked-since-as-updated`：`lastUpdated` 回退到 `trackedSince`。
- 允许清单：`scripts/qa/data-time-honesty-allowlist.json`，现有 2 条（#42、#43），数量必须完全一致：新增违规会失败；修掉一处但不调低清单也会失败，所以清单只能减少。
- 不扫描：测试、`app/api/cron/`、`lib/ingest/`、i18n 文件、生成类型。`select('…computed_at…')` 这类只用于发布资格的读取不会被误报。

## 留给 owner 的问题

1. sitemap 静态页（尤其是 /rankings、/market、/hot）的 `lastModified: now` 是否改成省略或用水位（#27）。
2. 快讯页"最后更新："现在显示的是最新一条快讯的发布时间。如果希望文案更准确，可以改成"最新快讯："，这需要改四种语言的文案。
3. 首页"数据截至"在数据不是当天时会带上日期（如"Aug 16, 09:30 AM"），超过 48 小时还会跟一句"数据可能延迟"。在数据停更期间，首页会一直显示这条提示，这是有意的诚实降级。
4. PDF 导出页眉日期是否加"生成于"前缀。
