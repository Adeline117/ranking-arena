# Arena 全站 UI/UX 审计台账 — 2026-06-29

> 方法：8 个研究 agent 并行，每个先上网研究 2026 最佳实践、再对照 Arena 真实代码找差距。
> 框架 = `arena-design-audit` 10类 + 验收标准 A–E（见 plan / DESIGN.md v2）。
> 优先级：**P0** 挡路/可读性/可达性/信任崩 → **P1** 伤扫读或转化 → **P2** 打磨。
> 基线：2026-06 已跑过全站 QA(96/100)、付费墙统一(18/18)、`var()+hex` alpha 全清、WCAG-AA 对比度修正。
> 本次 = 在成熟体系上系统补齐 2026 新规范 + 旗舰面重设计。

---

## 0. 跨切面主题（最高杠杆，一改全站受益 → Wave 1 优先）

这些缺口在多个 agent 报告里反复出现，是最该先做的：

| 主题                              | 说明                                                                                                                                                                                                                 | 涉及面           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **T1 图表层色盲不安全**           | `Metric` 文本本身带 +/− 号(合规)，但**图表层**(Sparkline 线色、SectorTreemap、SimpleLineChart 填充)涨跌**只靠红/绿**、无形状/方向冗余 → 违反 WCAG 1.4.1。**保留红绿语义(交易者习惯)，加冗余形状/标记**，不改成蓝橙。 | 全站图表         |
| **T2 图表对 AT 不可见**           | `SimpleLineChart`(交易员详情主图)等缺 `role="img"`/`aria-label`/键盘 tooltip/数据表回退 → WCAG 1.1.1/2.1.1。                                                                                                         | 详情、市场       |
| **T3 表语义/aria-sort 不全**      | 榜单行是 `<Link>` 无 `role="row"/"cell"`；PortfolioTable/PositionHistory 等可排序表缺 `aria-sort`。                                                                                                                  | 榜单、详情、组合 |
| **T4 表单 focus 轮廓被去掉**      | 输入框 `outline:none` 仅靠柔光 box-shadow → 可能不满足 WCAG 2.2 §2.4.11(核心路径登录/搜索/结账)。                                                                                                                    | 全站表单         |
| **T5 色 token 漂移**              | 审计过的提亮值(`success #4DFF9A`/`error #FF8E8E`)在 `theme-tokens.ts`，但实际渲染的 CSS 变量是**未审计**的(`#2fe57d`/`#ff7c7c`)；两套不一致。                                                                        | 全站             |
| **T6 tab/filter 控件缺角色**      | 社交各处 filter 行是裸 `<button>`，无 `role="tab"`/`aria-selected`/`aria-pressed`；图标按钮多为 `title` only 无 `aria-label`。                                                                                       | 社交、榜单筛选   |
| **T7 hover-gated 操作触屏不可见** | 分享、对比勾选框 `opacity:0` 直到 hover → 触屏无 hover 永远点不到。                                                                                                                                                  | 榜单卡、feed     |
| **T8 跨页数据不一致**             | 首页 hero 默认 `17,000`/`27`，定价页硬编码 `34,000+`/`32+` → 同产品两套规模，信任受损。                                                                                                                              | 首页、定价       |
| **T9 雷达图反 2026 指南**         | 共 **4 个雷达变体**(ScoreRadar/AbilityRadar/TradingStyleRadar/premium RadarChart)；3 轴雷达=三角形、面积失真、轴序依赖；ScoreRadar aria-label 分母错(35/40/25 vs 实际 60/40)且会插值 `null`。建议换横向条形。        | 详情、榜单       |
| **T10 i18n 回退**                 | 定价 founding banner 是硬编码英文串；feed 时间戳硬编码英文("Just now"/"m ago")。违反 i18n 铁律。                                                                                                                     | 定价、feed       |

---

## 1. 榜单 / 数据表（旗舰核心面）

**已达标**：sticky 表头 + 每列 `aria-sort`、tabular-nums、列显隐持久化、桌面表/移动卡自动切换、键盘导航、reduced-motion。

| #    | Sev       | 差距                                                                                                                                              | 修复                                                                                             | 文件                                                                      |
| ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1.1  | **P0**    | 表语义对 SR 断裂：容器 `role="table"`+表头 `role="row"`，但数据行是 `<Link>` 无 `role="row"`、cell 无 `role="cell"` → AT 读到「表+表头+0 行」     | 加 `role="row"/"cell"` 或改真语义结构                                                            | `RankingTable.tsx:553-558,1136`、`TraderRow.tsx`、`TraderMetricCells.tsx` |
| 1.2  | **P0→P1** | 涨跌图标只靠色：`Metric` 文本有 +/− 号(合规)，但行内「flash-green/red」变更动画纯色相；`showArrow` 从未启用                                       | 为 ROI/PnL 开 `▲/▼`(带 aria-hidden+sr-only)，flash 配图标                                        | `TraderMetricCells.tsx`、`TraderCard.tsx`、`Metric.tsx:136`               |
| 1.3  | **P1**    | 「sparkline」其实是单根静态条：`TraderCard` 传 `roi=` 无 `data[]` → 永远走 fallback 条，真折线从不渲染；SSR 卡无 sparkline 且 Sharpe 硬编码 `'—'` | 喂 `trader_series`/rank 历史进 `data[]`(已有 `RankSparkline`)，或改名为比率条；SSR 卡接真 Sharpe | `TraderCard.tsx:344`、`Sparkline.tsx`、`SSRRankingTable.tsx:267`          |
| 1.4  | **P1**    | 无密度/紧凑切换：行高固定 58/72px，无用户控件换密度(2026 数据表预期)                                                                              | 工具栏加 紧凑/舒适 切换 → `data-density` 驱动行高                                                | `RankingTable.tsx`、`RankingFilters.tsx`、`ranking-table.css:98`          |
| 1.5  | **P1**    | 降透明度叠在已暗 token 上(PnL 0.7/Win% 0.75/MDD 0.7/估算 0.4/20 行后 0.88) 可能跌破 AA 4.5:1                                                      | 改用对比度核过的专用 token，去掉 nth-child 渐隐或仅作背景                                        | `TraderMetricCells.tsx:128`、`ranking-table.css:275`                      |
| 1.6  | **P1**    | 无冻结首列/真横滚：<767px 网格只是缩，globals 与 responsive 有冲突 `!important` 6 列模板                                                          | 定一种移动表策略；保横滚则 `position:sticky;left:0` 冻结 rank+name                               | `globals.css:1263`、`responsive.css:712`                                  |
| 1.7  | **P2**    | 微排版偏小：排序头/标签 10px                                                                                                                      | 空间允许处抬到 11–12px                                                                           | `ranking-table.css:425`                                                   |
| 1.8  | **P2**    | sticky 偏移硬编码 `top:56`(假设 nav 高度)                                                                                                         | 改用 `--nav-height` 变量                                                                         | `RankingTable.tsx:613`                                                    |
| 1.9  | **P2**    | 排序头 `<button>` 被 re-role 成 columnheader 覆盖按钮语义                                                                                         | `<th role=columnheader>` 内放 `<button>`                                                         | `RankingTable.tsx:659`                                                    |
| 1.10 | **P2**    | 对比勾选框 `opacity:0` 直到 hover → 触屏不可见(T7)                                                                                                | coarse pointer 持久可见                                                                          | `TraderCard.tsx:169`                                                      |

---

## 2. 交易员详情（旗舰核心面）

**已达标**：指标覆盖深(Sharpe/Sortino/Calmar 等)、净值图有 crosshair+label-on-data+全屏、专门 underwater drawdown 图(真 0 基线)、风险免责+freshness。

| #    | Sev    | 差距                                                                                                                   | 修复                                                  | 文件                                                                           |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| 2.1  | **P1** | 两个并列 hero 数字：ROI 与 PnL 都 hero 字号 800、1fr 1fr                                                               | ROI 设主 hero、PnL 降 lg；走 `Metric` size 分级       | `performance/HeroMetrics.tsx:26`                                               |
| 2.2  | **P1** | **一个 tab 两个周期选择器不同步**：卡片走 `periodStore`，`EquityCurveSection` 自持 local period → 切卡片周期净值图不动 | 统一到 `periodStore`，所有图喂同一源                  | `OverviewPerformanceCard.tsx:97`、`stats/components/EquityCurveSection.tsx:36` |
| 2.3  | **P1** | 雷达反指南且重复：`TradingStyleRadar`(5 混单位轴、6px 标签)+ `ScoreBreakdownSection` 内第二个雷达                      | 换横向条(`ScoreBar` 已有)，只留一个                   | `TradingStyleRadar.tsx`、`ScoreBreakdownSection.tsx:285`                       |
| 2.4  | **P1** | 净值 Y 轴对全正曲线不锚 0：仅当数据跨 0 才画零线 → 小回撤被视觉夸大                                                    | 累计 ROI/PnL 的 y 域含 0 或恒画 0 参考线              | `stats/components/SimpleLineChart.tsx:193`                                     |
| 2.5  | **P1** | Arena Score(招牌指标)从不是 hero，只在小 badge                                                                         | 提升到 hero 附近主指标(配 rank/百分位)                | `HeroMetrics.tsx`、`TraderHeader.tsx:338`                                      |
| 2.6  | **P2** | copy-trade CTA 弱：只是头部下小文本链接；移动 sticky 头无 Copy 动作                                                    | 主链接做成显眼按钮 + sticky 移动头加 Copy             | `ExchangeLinksBar.tsx`、`TraderProfileClient.tsx:544`                          |
| 2.7  | **P2** | 信任/验证信号偏弱(验证、数据源、置信度都是小 badge)                                                                    | 加紧凑「信任」面板(数据源/track-record/验证/更新时间) | `TraderHeader.tsx:338`                                                         |
| 2.8  | **P2** | 无合并风险评分(MDD/波动/Sharpe 需用户自己综合)                                                                         | 派生 1–5/低–高 风险 badge 置 hero 旁                  | `MetricBadgesGrid.tsx`、`AdvancedMetricsCard.tsx`                              |
| 2.9  | **P2** | 当前持仓也被 Pro 墙挡(当前持仓是 copy-trade 核心信任信号)                                                              | 当前持仓(或 top1-2 teaser)免费，仅深历史 gate         | `PortfolioTable.tsx:118`                                                       |
| 2.10 | **P2** | hero/Advanced/Simulator 手搓数字(literal 800、硬 rgba)绕过 `Metric`                                                    | 金额走 `Metric`，rgba 换 token                        | `HeroMetrics.tsx`、`CopyTradeSimulator.tsx:196`                                |
| 2.11 | **P2** | 两 hero 数移动端不 reflow(固定 1fr 1fr，320px 拥挤)                                                                    | <400px 单列堆叠(若 2.1 已降 PnL 则自然解决)           | `HeroMetrics.tsx:28`                                                           |
| 2.12 | **P3** | TraderHeader prop 膨胀(40→~16，见 `docs/reviews/trader-header-audit-2026-04-09.md`)；Tier1 删 6 个死 prop 零风险       | 按 4 tier 瘦身                                        | `TraderHeader.tsx`                                                             |
| 2.13 | **P3** | 插值净值点与真实点无区分；tooltip 仅鼠标；TradingStyleRadar 6px 标签                                                   | 插值段虚线/标注；用 `InfoTooltip`；抬微标签下限       | `SimpleLineChart.tsx:13`、`AdvancedMetricsCard.tsx:546`                        |

---

## 3. 搜索 + 导航 / IA

**已达标**：Cmd/Ctrl+K、typeahead 分组+键盘导航+hover prefetch+did-you-mean、零结果态+recent、16px 输入防 iOS 缩放、移动底栏 3-5 项规则、breadcrumb 广用 `aria-current`。

| #    | Sev    | 差距                                                                                             | 修复                                                             | 文件                                                                   |
| ---- | ------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 3.1  | **P1** | 三套 nav IA 不一致：顶栏 Rankings/Market/Groups/Hot；底栏 +Me；feed 侧栏 Home/Rankings/Market/Me | 抽单一 canonical 主目标集喂三处；统一 `/` 标签(Rankings vs Home) | `NavLinks.tsx:13`、`MobileBottomNav.tsx:414`、`DesktopSidebar.tsx:151` |
| 3.2  | **P1** | 分面筛选无结果计数(facet count 是分面搜索第一预期)                                               | 从已载数据/服务端算 `Label (N)`，0 匹配置灰                      | `RankingFilters.tsx:646`、`MobileFilterSheet.tsx`                      |
| 3.3  | **P1** | 榜单筛选不进 URL → 不可分享/书签/后退(搜索页已正确做)                                            | 筛选状态提到 URL query(仿搜索页)                                 | `RankingFilters.tsx:357` vs `SearchPageClient.tsx:72`                  |
| 3.4  | **P1** | 顶栏搜索 combobox 缺 `aria-activedescendant` → SR 不报箭头移动(榜单搜索已有，可参照)             | input 设 `aria-activedescendant` 指向高亮项                      | `NavSearchBar.tsx:52`、`SearchDropdown.tsx`                            |
| 3.5  | **P1** | Breadcrumb 不发 `BreadcrumbList` JSON-LD(仅 trader 页单独有)                                     | `Breadcrumb.tsx` 可选渲染结构化数据(helper 已存在)               | `ui/Breadcrumb.tsx`、`lib/seo/structured-data.ts`                      |
| 3.6  | **P2** | Cmd+K 只是聚焦不是命令面板(2026 期望 K-bar 动作)                                                 | overlay 加 导航/recent/主题切换 等动作行                         | `TopNavClient.tsx:69`                                                  |
| 3.7  | **P2** | 三套搜索历史存储不互通                                                                           | 统一到 `lib/services/search-history`                             | `useSearchData.ts`、`ranking/useSearchHistory.ts`                      |
| 3.8  | **P2** | 36 个交易所无发现入口(仅搜索可达)                                                                | 加 Market/Exchanges mega-menu 或索引                             | `NavLinks.tsx`                                                         |
| 3.9  | **P2** | 底栏滚动下滑自动隐藏(降低持久可发现性)                                                           | 考虑常驻或仅沉浸态隐藏                                           | `MobileBottomNav.tsx:240`                                              |
| 3.10 | **P2** | `/search` 结果页无键盘导航(仅 dropdown 有)                                                       | 结果链接加 roving-tabindex/箭头导航                              | `SearchPageClient.tsx:300`                                             |
| 3.11 | **P2** | trending 硬编码回退先于真数据渲染且吞 fetch 错                                                   | 真数据前出骨架；catch 改 log                                     | `SearchPageClient.tsx:77`                                              |
| 3.12 | **P2** | Breadcrumb 溢出不折叠(整行省略→移动端藏当前页)                                                   | 窄屏中间项折叠 `Home / … / current`                              | `ui/Breadcrumb.tsx:26`                                                 |

---

## 4. 登录 + Onboarding

**已达标**：16px 输入、`autoComplete`/`enterKeyHint` 正确、OTP 无密码选项、强度计、限流倒计时、in-app-browser OAuth 回退、UTM/referral 捕获、多账号、reset 不泄露账号存在。

| #    | Sev    | 差距                                                                                                                                   | 修复                                                               | 文件                                                                               |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 4.1  | **P1** | **整个 5 步 onboarding 是孤儿死代码**：邮箱/OAuth/Privy 注册都 →`/?welcome=1` 横幅，从不路由到 `/onboarding`(follow/join 正是激活 aha) | 首注册后路由到 `/onboarding`(gate `onboarding_completed`，留 Skip) | `LoginPageClient.tsx:518`、`auth/callback/page.tsx:156`、`PrivyLoginButton.tsx:44` |
| 4.2  | **P1** | code-login 账号枚举：`shouldCreateUser:false` 暴露「邮箱未注册」                                                                       | 返回中性「若账号存在已发码」(同 reset 行为)                        | `LoginPageClient.tsx:299`                                                          |
| 4.3  | **P1** | 无 passkey/WebAuthn(2026 主方法)                                                                                                       | 加 passkey(Supabase WebAuthn 或 Privy passkeys)                    | `login/components/SocialLogin.tsx`、`lib/privy/config.ts`                          |
| 4.4  | **P1** | 密码下限弱(6 位、无泄露库筛查)                                                                                                         | 抬到 8、低于 fair 阻止提交、可选 HIBP 筛查                         | `LoginPageClient.tsx:481`、`RegisterForm.tsx:226`                                  |
| 4.5  | **P2** | OTP 验证后注册仍强制设密码(摩擦无收益)                                                                                                 | 密码可选(「稍后设置」)                                             | `RegisterForm.tsx`                                                                 |
| 4.6  | **P2** | 社交/钱包登录埋在折叠下(crypto 受众应突出)                                                                                             | Google+Wallet 提到邮箱表单上方                                     | `LoginPageClient.tsx:942`、`SocialLogin.tsx`                                       |
| 4.7  | **P2** | 两套 onboarding 状态键 + reset 抽出组件是死代码                                                                                        | 统一 `onboarding_completed`(DB 支撑)；接活/删 reset 组件           | `onboarding/page.tsx:59`、`reset-password/*`                                       |
| 4.8  | **P2** | Privy 主题硬编码 dark(忽略浅色偏好)                                                                                                    | 传入当前主题                                                       | `lib/privy/config.ts:15`                                                           |
| 4.9  | **P2** | 错误解析靠英文子串(本地化即失效)                                                                                                       | 按 Supabase 错误码/状态分支                                        | `LoginPageClient.tsx:549`                                                          |
| 4.10 | **P2** | OTP 单文本框非分段 6 格                                                                                                                | 6 段自动前进+粘贴分发+完成自动提交                                 | `login/components/OTPVerification.tsx`                                             |
| 4.11 | **P2** | claim 登出态死胡同(toast 后停)                                                                                                         | 选中即开登录弹窗(保留选中)再续验证                                 | `claim/page.tsx:101`                                                               |
| 4.12 | **P2** | 登录页裸表单无价值框架/社会证明                                                                                                        | 加 value/trust 面板                                                | `LoginPageClient.tsx:676`                                                          |
| 4.13 | **P2** | reset 不预校验 recovery token(过期仅在 updateUser 报通用错)                                                                            | 挂载时校验，出「链接过期」态                                       | `reset-password/page.tsx:215`                                                      |
| 4.14 | **P2** | onboarding 写入 best-effort 静默吞错(可能「完成」却没存)                                                                               | surface 部分失败/重试，确认写入再标完成                            | `onboarding/page.tsx:176`                                                          |

> 注：4.2/4.3/4.4 偏安全，4.1 偏激活，UI/UX 与功能交叉；安全项执行前会另行确认。

---

## 5. 定价 + 付费墙 + 首页 Hero 转化

**已达标**：3 档(Free/Pro/Lifetime)+「MOST POPULAR」+默认年付、年付锚定划线价、founding 稀缺进度条、一键直达 Stripe、Apple/Google Pay、idempotency、TOCTOU 锁、blur 软墙、success 轮询校验、hero 标题 5 词过 5 秒测试。

| #    | Sev    | 差距                                                                                                                                | 修复                                                                                       | 文件                                                     |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 5.1  | **P0** | 试用信息自相矛盾：顶 badge「all plans 7 天试用」，FAQ「是否有试用」答「免费档…」(无试用)，Lifetime 无试用                           | 统一口径：试用仅月/年付；修 FAQ；badge 改「Pro plans」                                     | `PricingPageClient.tsx:187,1216`、`membership-config.ts` |
| 5.2  | **P1** | 跨页统计不一致(T8)：定价 34,000+/32+/30min vs hero 17000/27                                                                         | 两处都取单一服务端真值                                                                     | `PricingPageClient.tsx:233`、`HomeHeroSSR.tsx:28`        |
| 5.3  | **P1** | founding banner 硬编码英文串(T10)+价格硬编码                                                                                        | `t()` 包裹+从 `PRICING` 插值                                                               | `PricingPageClient.tsx:219`                              |
| 5.4  | **P1** | 付费墙无 analytics + 无 价格/试用框架：`goUpgrade` 仅 push 无 `paywall_blocked` 事件(铁律要求)，`UpsellCard` 无价格锚/试用/社会证明 | `goUpgrade` 触发 `paywall_blocked`；卡加「from $4.99/mo·7 天试用」+ 社会证明；CTA 改收益式 | `ProGate.tsx:125,194`                                    |
| 5.5  | **P1** | CTA 旁无信任/担保信号(Stripe 安全、退款埋 FAQ)                                                                                      | CTA 下加信任条「🔒 Stripe·7 天退款·随时取消」；hero 加「无需信用卡」                       | `PricingPageClient.tsx`、`HomeHeroSSR.tsx:169`           |
| 5.6  | **P2** | 年省只显 -% 不显绝对金额；`-%` 用硬 `#ffd700`                                                                                       | 加「省 $X/年」；hex 换 token                                                               | `PricingPageClient.tsx:312,489`                          |
| 5.7  | **P2** | Lifetime 锚点在网格下方，无法向上锚定 Pro                                                                                           | 将 Lifetime 价值上提到对比区内/上                                                          | `PricingPageClient.tsx:328`                              |
| 5.8  | **P2** | ProGate 丢了 PremiumGate 的 per-feature benefit 映射 → 多数 gate 回退通用文案                                                       | 移植 `featureKey→benefits` 默认映射进 ProGate                                              | `ProGate.tsx:176` vs `PremiumGate.tsx:74`                |
| 5.9  | **P2** | hero 无低承诺「Browse Rankings」CTA(`heroCTABrowse` 串已存在却没用)                                                                 | 加次 CTA →`/rankings`                                                                      | `HomeHeroSSR.tsx:157`、`en-core.ts:285`                  |
| 5.10 | **P2** | referral↔checkout 脱节(checkout 收 promo 但流程不传)                                                                                | 从 URL/referral 上下文传 `promotionCode`                                                   | `PricingPageClient.tsx:128`、`useDirectCheckout.ts:29`   |
| 5.11 | **P2** | FAQ/对比表硬编码 inline 与 `membership-config` 导出并存且已漂移                                                                     | 统一到 `membership-config`                                                                 | `PricingPageClient.tsx`、`membership-config.ts:53`       |

---

## 6. 数据可视化 / 图表

**已达标**：`SimpleLineChart` label-on-data+真 0 基线+split fill；`SectorTreemap` squarified+diverging legend；动画图表 reduced-motion 合规。

| #    | Sev    | 差距                                                                             | 修复                                                                      | 文件                                                                                    |
| ---- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 6.1  | **P0** | 涨跌纯红/绿无冗余形状(T1)                                                        | 保红绿语义 + 加 ▲/▼ / 端点标记 / 虚实线等冗余；CVD 自检                   | `Sparkline.tsx:37,89`、`RankTrendSparkline.tsx:111`、`SimpleLineChart.tsx:216`          |
| 6.2  | **P0** | 主净值图对 AT 不可见(T2)：无 `role=img`/`aria-label`/数据表回退                  | 加 `role=img`+带值 aria-label + 隐藏 `<table>` 回退                       | `SimpleLineChart.tsx`                                                                   |
| 6.3  | **P1** | tooltip 仅鼠标/触摸无键盘(仅 treemap 有 onKeyDown)                               | 数据点 Tab/箭头可达，focus 出同 tooltip;或落 #6.2 数据表作键盘路径        | `SimpleLineChart.tsx`、`DrawdownChart.tsx`、`RankTrendSparkline.tsx`                    |
| 6.4  | **P1** | n 轴雷达遍布(T9)：3 轴=三角形、面积失真；ScoreRadar Exec 轴已废仍画              | 换 grouped 横向条；至少删死 Exec 轴                                       | `ScoreRadar.tsx`、`AbilityRadar.tsx`、`TradingStyleRadar.tsx`、`premium/RadarChart.tsx` |
| 6.5  | **P1** | `ScoreRadar` aria-label 分母错(35/40/25 vs 60/40)且插值 `null`                   | 修分母、删 Exec、guard null                                               | `ScoreRadar.tsx:92`                                                                     |
| 6.6  | **P1** | treemap 色硬编码 RGB 红绿非 CVD 安全；键盘 focus 的 tooltip 位置陈旧(0,0)        | 换 CVD diverging(锚 0%)；onFocus 从节点 rect 设 tooltipPos                | `SectorTreemap.tsx`                                                                     |
| 6.7  | **P2** | `SimpleLineChart` 网格线在固定 viewBox 位[0,25,50,75,100] 不对应数据值=chartjunk | 对齐真刻度(带标签)或删，仅留 0 基线                                       | `SimpleLineChart.tsx:362`                                                               |
| 6.8  | **P2** | `DrawdownChart` aria-label 无值；base `Sparkline` 无端点/极值标记                | drawdown label 加 maxDD 值；Sparkline 加当前值端点(仿 RankTrendSparkline) | `DrawdownChart.tsx`、`Sparkline.tsx`                                                    |
| 6.9  | **P2** | FearGreedGauge 速度表数据墨水比低、无趋势                                        | 可保留，下方加小历史 sparkline                                            | `FearGreedGauge.tsx`                                                                    |
| 6.10 | **P2** | 无自定义/brush 时间范围(RankTrendSparkline 硬编码 30D)                           | 全屏净值加 brush；rank-trend 暴露周期选择                                 | `EquityCurveSection.tsx`、`RankTrendSparkline.tsx:42`                                   |

---

## 7. 社交 / 私信 / 通知

**状态**：`features.social` 默认 ON 且 repo 无 `false` 覆盖 → **所有社交面当前是 live 的**。
**已达标**：乐观更新一律 delta-based(非快照)；DM 线程现代(virtualized + typing + 已读回执 + sending/sent/failed 重试 + presence)。

| #    | Sev    | 差距                                                                                         | 修复                                                               | 文件                                                                                           |
| ---- | ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 7.1  | **P0** | 评论 composer 的图片附件按钮只 toast「coming soon」=用户级死胡同                             | 删按钮或接真上传(复用 DM `useFileUpload`)                          | `post/comments/CommentInput.tsx:229`                                                           |
| 7.2  | **P0** | HotContent 内 `{false && …}` 死付费墙块(~110 行)在 live 文件                                 | 删死分支                                                           | `hot/HotContent.tsx:255`                                                                       |
| 7.3  | **P1** | feed 类型筛选在已取页上客户端做，且筛选时隐藏 Load-More → 筛选视图静默截断                   | 筛选下推 API；筛选时保留分页                                       | `feed/ActivityFeed.tsx:158,311`                                                                |
| 7.4  | **P1** | 通知无分组聚合(「X 和另 5 人赞了」)                                                          | 按 `type+reference_id` 聚合 + actor 头像栈                         | `inbox/NotificationsList.tsx:383`、`lib/data/notifications.ts`                                 |
| 7.5  | **P1** | 通知类型筛选也在分页后做(同 7.3 截断)                                                        | 服务端 `type` 参数或取满页                                         | `NotificationsList.tsx:22`                                                                     |
| 7.6  | **P1** | Hot 下拉刷新 `window.location.reload()` 全页刷新                                             | 改 React Query `invalidateQueries`                                 | `hot/HotContent.tsx:74`                                                                        |
| 7.7  | **P1** | feed「Live」脉冲点纯装饰无 realtime(误导)                                                    | 接 Supabase realtime + 「新帖」跳顶，或去掉 Live                   | `ActivityFeed.tsx:140,213`                                                                     |
| 7.8  | **P1** | DM 缺 反应/引用回复/编辑/链接预览(2026 chat table-stakes)                                    | 至少加 emoji 反应+引用回复；URL→富链接预览                         | `messages/.../MessageBubble.tsx`、`MessageInput.tsx`                                           |
| 7.9  | **P1** | tab/filter 裸 button 无 `role=tab`/`aria-selected`；图标按钮无 `aria-label`；hover 走 JS(T6) | 加 tab 角色/aria；图标加 aria-label；hover 移 CSS `:focus-visible` | `ActivityFeed.tsx:388`、`GroupsFeedPage.tsx:150`、`HotContent.tsx:153`、`PostListItem.tsx:328` |
| 7.10 | **P1** | GroupsFeedPage 静默吞群加载错(`_loadingGroups`/`_groupsError` 设了不渲染)                    | 渲染 error/loading + 重试                                          | `GroupsFeedPage.tsx:41`                                                                        |
| 7.11 | **P2** | ActivityFeed/Hot 初载无骨架(纯文字 loading)                                                  | 加匹配布局的卡骨架                                                 | `ActivityFeed.tsx`、`HotContent.tsx:202`                                                       |
| 7.12 | **P2** | feed Share 仅 hover 可见(触屏不可见,T7)+仅剪贴板无 Web Share+静默+时间戳硬编码英文(T10)      | 常显/点击展开;Web Share 回退+toast;本地化 `formatRelativeTime`     | `feed/ActivityFeedItem.tsx:31,85,280`                                                          |
| 7.13 | **P2** | 评论仅 1 层；展开「全部一次性」；评论无举报/permalink                                        | 允许 ≥2 层或扁平带上下文;分页回复;加评论举报                       | `post/comments/CommentThread.tsx:179`                                                          |
| 7.14 | **P2** | trader Activity feed 无 like/comment/react(只读流)                                           | 定夺：保只读 或 加轻反应                                           | `ActivityFeedItem.tsx`                                                                         |
| 7.15 | **P2** | 分页模式不一(PostFeed/DM 虚拟化无限,ActivityFeed/Hot/通知手动 Load-More)                     | 同质 feed 统一 IntersectionObserver 无限滚                         | `ActivityFeed.tsx:319`、`NotificationsList.tsx:495`                                            |
| 7.16 | **P2** | DM 死代码(`onTyping` 未挂)+重试上限不一(5 vs 10)                                             | 删死 prop、对齐重试上限                                            | `messages/.../page.tsx:674`、`useConversationMessages.ts:94`                                   |
| 7.17 | **P2** | `SocialComingSoonPage`(kill-switch 态)无 waitlist 捕获、图标缺 aria-hidden、无 `<h1>`        | 加邮箱捕获+`<h1>`+`aria-hidden`                                    | `ui/SocialComingSoon.tsx:42`                                                                   |
| 7.18 | **P2** | PostContent 图片固定 px、裸 `<img>`、空 alt、无 lightbox                                     | 响应式尺寸、`next/image`、描述性 alt、点击放大                     | `post/shared/PostContent.tsx:107,197`                                                          |

> 工作树里 `ConversationsList.tsx`/`NotificationsList.tsx`/`format.ts` 的未提交改动经核实=纯 token 重构(无行为变更)。

---

## 8. 可达性 / 移动 / 动效（跨切面）

**已达标(强)**：全局 reduced-motion kill switch + view-transition 复位、reduced-transparency 兜底、`RankChangeIndicator` 是色盲安全范本(▲/▼+sr-only+色)、skip link、44–48px touch、safe-area、visualViewport 键盘检测、offline+sw。

| #    | Sev                   | 差距                                                                                          | 修复                                                                                 | 文件                                                                          |
| ---- | --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 8.1  | **P1**(若 <3:1 则 P0) | 表单 `outline:none` 仅靠柔光(T4)→ 可能不满足 §2.4.11(登录/搜索/结账核心路径)                  | `:focus-visible` 保 2px 实 outline 或验证柔光对比并加实环                            | `globals.css:721,2361`                                                        |
| 8.2  | **P1**                | `Metric.showArrow` 死代码且无 aria-hidden/sr-only；`colorBySign` 强加于 ratio/number 时变纯色 | 启用方向指示(或文档化 sign-only)；箭头加 aria-hidden+sr-only(仿 RankChangeIndicator) | `Metric.tsx:136`                                                              |
| 8.3  | **P1**                | `aria-sort` 覆盖不全(仅 7 处,榜单有,其他可排序表缺,T3)                                        | 所有可排序 columnheader 加 `aria-sort`                                               | `PortfolioTable.tsx`、`PositionHistoryView.tsx`、`portfolio/PositionList.tsx` |
| 8.4  | **P2**                | 色 token 漂移(T5):审计值在 theme-tokens,渲染的是未审计 CSS 变量                               | 统一到一处,CSS 变量指向审计值                                                        | `globals.css:155,198`、`theme-tokens.ts:39,126`                               |
| 8.5  | **P2**                | focusRing token 误导/未用(0.5 alpha 可能 <3:1,被 globals 覆盖)                                | 删 0.5-alpha token 或对齐实环;验证 tinted 态上对比                                   | `design-tokens.ts:372`、`globals.css:706,1701`                                |
| 8.6  | **P2**                | reflow(1.4.10) 仅榜单验证;其他密表未确认 320px 无 2D 滚                                       | 确认组合/持仓表 320px 卡片化                                                         | `PortfolioTable.tsx`、`PositionList.tsx`                                      |
| 8.7  | **P2**                | 无 `forced-colors`/`prefers-contrast` 处理(Windows 高对比可能消失 glass/gradient 按钮)        | 加 forced-colors 兜底(系统色+可见边框)                                               | `globals.css`                                                                 |
| 8.8  | **P2**                | SkipLink 靠 inline onFocus/onBlur 改样式(脆弱);只有 skip-to-content                           | reveal 移 CSS `:focus`;加 skip-to-nav                                                | `Providers/Accessibility.tsx:13`                                              |
| 8.9  | **P2**                | `Text` 语义 `as` 与视觉 size/weight 解耦(允许标题序错配)                                      | lint 守卫或耦合默认                                                                  | `base/Text.tsx:5`                                                             |
| 8.10 | **P2**                | 图标按钮目标尺寸需抽查(≥24px 或足够间距)                                                      | 审 icon-only 按钮                                                                    | `base/Button.tsx:61` + 调用点                                                 |

---

## 修复波映射（驱动后续执行）

- **Wave 1 跨切面**：T1(色盲冗余-Metric/Sparkline 层)、T3+8.3(aria-sort/表语义)、T4+8.1(表单 focus)、T5+8.4(色 token 漂移)、T6+7.9(tab/filter 角色)、T7(hover→触屏)、T8+5.2(跨页统计单一源)、T10(i18n 回退)。+ 共享外壳一致性。
- **Wave 2 核心 6 面**：榜单(1.x)、详情(2.x)、搜索/IA(3.x)、登录/onboarding(4.x)、定价/hero(5.x)。先做各面 P0/P1。
- **Wave 3 二级**：社交(7.x)、市场图表(6.6/6.9)、学习/个人/设置/quiz/legal/admin 一致性扫。
- **Wave 4 旗舰重设计**：榜单表格(1.1/1.4/1.6 + 密度/移动卡/行内可视化)先在 `/design-system` 原型；详情(2.1–2.5 hero 层级/周期统一/雷达换条/0 基线/Score 提升)+ TraderHeader 瘦身。
- **Wave 5 验证**：图表 a11y(6.2/6.3)、回抓截图、lint/type-check/qa:buttons、post-deploy-check、修死 fixture `/trader/soul`、更新 DESIGN.md/PROGRESS.md。

## 决策项（执行中需用户拍板）

1. **色语言**：研究建议涨跌改蓝橙(CVD 最佳)，但与「不改语义色含义」冲突。**默认：保红绿 + 加冗余形状**(交易者习惯)。若想更激进可单列。
2. **当前持仓免费化**(2.9) 牵涉付费策略 → 产品决策。
3. **安全项**(4.2 枚举/4.3 passkey/4.4 密码下限) 偏功能/安全，非纯 UI；执行前单独确认。
4. **DM 反应/回复**(7.8) 是较大功能建设,非纯打磨。
