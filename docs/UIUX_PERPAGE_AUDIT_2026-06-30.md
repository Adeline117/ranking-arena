# Arena 全站逐页 UI/UX 审计台账 — 2026-06-30

> 方法：9 个 agent 对全部 ~90 路由逐页「上网学 2026 该页型最佳实践 → 读真实代码 → 带优先级发现」。
> **重要**：本台账的发现**已经主控逐条 grep/Read 核实**(死命令 [verify-before-fix])。审计 agent 的结论
> 会过时/出错——下方「⚠️ 审计有误」即核实后推翻的项。修任何一条前仍须再次确认前提成立。
> 前序会话已上线：首页榜单(密度/ScoreMiniBar/showArrow/真 sparkline/冻结列)、核心 6 面、二级面一致性、
> DM/群聊反应回复、passkey、定价信任。prod 5/5 绿。

---

## ⚠️ 审计有误 / 已纠正(核实后)

- **SSRRankingTable「缺 ScoreMiniBar」= 假**。实测 `SSRRankingTable.tsx:14,287` 已有(1A 落过)。仅 Sharpe 仍硬编码 `'—'`(:86)为真。
- **「群已读需新迁移」= 假**。`channel_message_reads(channel_id,user_id,last_read_at)` 表 00065 早建好 + RLS。群已读是**纯接线**,无需迁移。
- **`/channels` 404「P0」= 误判级别**。全站无页面链接 `/channels`(只有 `/api/channels`)。低优先,加个 `redirect('/inbox')` 即可。
- **`/my-posts` 白屏「P0」= 降级**。`features.social` 默认开,顶层 redirect 不触发;只是解析 handle 时短暂空屏,小问题。
- **`/portfolio` 时序图**：核实**无快照数据源**(无 `lib/data/portfolio*`、api 无 snapshot)。不是 UI 接线,需先建快照采集管道(owner 已批本轮做)。

---

## 功能/正确性 P0(已核实为真)

1. **`/hashtag/[tag]` 信息泄漏**：`PostFeed.tsx` 仅支持 groupId/groupIds,**无 tag 参数**;HashtagClient 传 initialPosts 后 PostFeed 分页打全局 `/api/posts` → 滚动追加无关全局帖。修：给 PostFeed 加 `tag` prop(仿 groupId)。
2. **Referral 奖励死代码**：`/api/referral/apply`(发 30 天 Pro)前端**零调用**(已 grep 确认)。承诺奖励永不可得。owner 批：接通双边奖励,先 security/成本审。
3. **Onboarding 孤儿**：注册流从不路由到 `/onboarding`(grep 仅自引用)。修：首注册后路由(gate `onboarding_completed`+Skip)。
4. **`/reset-password` 密码下限 6**(`:289`)：undercut 已上线登录 8 位 + 请求-重置表单泄漏账号存在。修：→8 + 中性提示。
5. **`/wrapped` 死 CSS 类**：grid 用 inline `1fr 1fr`(`:224`),媒体查询找 `.wrapped-card-grid`(`:481`) 但元素无此类 → 移动端溢出。修：加 class。
6. **群聊无已读接线**：`channel_message_reads` 表在,但 `/channels/[channelId]` 不读写它。修：打开/聚焦 upsert `last_read_at`、按它算未读(无迁移)。
7. **`/portfolio` 时序图**：需建快照管道(见上)。

## 重构级(非快速 P0)

- **`/post/[id]`**：用模态盖全局 feed 当详情 → 无 SSR、SEO/LCP 差、关模态露无关 feed。改服务端取该帖、内联渲染(仿 `/feed/[id]`)。大重构,单列。

---

## 跨切面主题(一改多页受益)

- **B1 榜单家族补齐**：`/rankings/{bots,exchanges,tokens,tokens/[token],weekly}` 全没拿到本会话榜单改进。补：语义表(bots/tokens-detail 是 div-grid)、可排序+aria-sort、showArrow 形状冗余、sticky+冻结列+移动卡、facet 计数;tokens/[token] 还要 SSR 预取 + 修破损 breadcrumb。
- **B2 完成 WAI-ARIA tab**：admin/pipeline/favorites/user-center/groups/compare 多处 `role=tab` 缺 tabpanel/aria-controls/箭头键。抽共享 tab 原语。
- **B3 涨跌色盲冗余**：bot/exchange/market/funding/competition/admin 状态点仍纯红绿 → 加 ▲/▼ 或图标。
- **B4 token 漂移**：medal/status/`#fff`/`#2fe57d`-`#ff7c7c` 等硬编码 hex → `var()`。
- **B5 focus 环**：bots/tokens 搜索框、`/u/[handle]/new` 标题+正文、offline/help 卡仍 `outline:none` 无替代。
- **B6 `<h1>` 语义**：`Text` 默认 `as='p'`,admin/monitoring/pipeline 等标题无 h1。
- **B7 hover→键盘/触屏**：learn/help/groups/competitions/tokens 卡 hover 仅 JS。

## i18n 回归(违反铁律)

- 全英文：`/admin/monitoring`、`/admin/monitoring/pipeline`、`/admin/pro-metrics`、`/referral`、多 success/`logout`/`trader/authorize`。
- 硬编码中文：`/admin/data-health` 副标题 + `toLocaleString('zh-CN')`。
- 双语堆叠(应按 locale 单显)：`/terms`、`/privacy`、`/methodology`。
- 非响应 `t`：`/offline`。硬编码 `en-US` 日期：`/feed/[id]`、funding/OI。

## 转化/激活

- **`/referral`**：奖励从不展示 → hero 讲清「邀 3 得 30 天 Pro」+进度条+可编辑分享语(i18n)+双边激励+修两张重复 stat 卡(+接通发放,见 P0#2)。
- **`/pricing/success`**：去/可暂停 30s 自动跳;主 CTA 指向具体首价值动作;收益清单改可点 checklist;加收据行+referral 交叉推。
- **`/tip/success`**：确认金额+收款人+原帖;5s→15s/可关;分享回路;返回原帖。
- **`/pricing` 余项**：年省显美元金额;FAQ/对比表统一到 membership-config 单一源;Lifetime 锚点上提。
- **`/auth/callback`**：新用户判定用 DB `onboarding_completed`(非 30s 时钟);超时/失败 UI;不回显 provider 原始错误。

## 实体/详情

- **`/bot/[id]`**：加净值曲线(SimpleLineChart 零基线)+数据新鲜度/风险披露+APY/ROI 拆列+语义表+hero 指标/排名+主 CTA/分享。
- **`/exchange/[slug]`**：修「每 5 分钟更新」vs `revalidate=1800` 矛盾;加聚合统计+logo+分布图;表头 scope/冻结列;token 化。
- **`/u/[handle]`**：关注数→`<button>` 可键盘;验证徽章 aria;非交易员隐藏 stats/portfolio 死 tab;加 About 区。
- **`/compare`**：owner 批 → 走全站 Pro-free promo(见下),并恢复搜索/从榜单加入;雷达换分组条;矩阵语义表;👑 加 sr-only。
- **composer(`/u/[handle]/new`、`groups/[id]/new`、`post/[id]/edit`、`groups/apply`)**：focus 环、计数器 aria-describedby/live、必填 aria、edit/preview tab 角色、**unsaved-changes 守卫**(全缺)、抽共享 composer。
- **`/trader/authorize`**：现 2s 空跳 → 做真 copy-trade 同意屏 或 服务端 redirect 到 `/claim`。

## 市场/事件

- **funding-rates**：加年化 APR 列(P0,跨所可比)、热力图强度、symbol×exchange 透视、symbol 搜索。
- **open-interest**：加 24h Δ/趋势(P0)、按所分布、份额比例条、USD/张数切换。
- **`/market`**：全局市场态条(总市值/24h 量/BTC 占比);修固定高度 widget 截断;真「更新于 Xs」;移动补 signals。
- **flash-news**：「N 条新」缓冲 pill;breaking 置顶/分组;日期分隔;breaking-only+关键词搜索。
- **competitions**：实时倒计时;容量进度条;tab 计数;create end>start>now 校验+内联错误+缺 prize/entry;detail 倒计时+当前用户高亮+名次 ▲/▼+平台下拉。

## 内容/个人/Admin/法务

- **长文 TOC+锚点**(最频繁)：renderMarkdown 标题加 id slug;learn 文章/methodology/api-docs/legal 加 TOC;learn hub 搜索/分类;正文用 primary 文本。
- **api-docs**：endpoint 索引+copy 按钮+语言 tab+渲染 `ENDPOINTS[].name`。
- **`/status`**：显可用性 % + 事件历史(非进程 uptime);真错误文案。
- **静默失败→error/empty 分离**：watchlist(非 ok 静默)、portfolio、monitoring、status;watchlist 行用 `<Link>` 不要 `window.location.href`;移动改卡片。
- **settings**：修「Linked Accounts」标签 vs 内容(实为 trader/exchange links)错配 + `TraderLinksSection` 双渲染;section nav 用 `<nav>` landmark + `?section=` 入 URL + IntersectionObserver。
- **admin**：5 兄弟路由 UI 不可达 → 加 admin shell nav;tab 入 `?tab=`;tab 10>7 收 overflow;`/admin/reports` 加 triage 动作+内容链接+访问拒绝态;`/admin/pro-metrics` KPI 加趋势 Δ;data-health 状态点加形状。
- **legal**：5 页统一 `t()` 单语言 + TOC + Key-Points 摘要 + Last-Updated。
- **`/s/[token]`**：token 格式校验、过期不发 live OG、view-count `.catch()`。
- **`/offline`**：`useLanguage()`、online 事件自动重试、token 化 PnL 色。

---

## owner 已定决策(2026-06-30)

1. **全站 Pro-free 限时免费 promo**(替代 /compare 单点)：加单一开关让所有 Pro 功能限时免费、清楚标注、一键可加回。
   实现：`lib/types/premium.ts` 单 const `PRO_FREE_PROMO` → 客户端(useSubscription/effectiveIsPremium)+服务端(`hasFeatureAccess`/`getFeatureLimits`)同源;全站横幅标注「限时免费」;revert=置 false。**不删任何付费墙/checkout 代码。**
2. **Referral**：接通双边奖励,先 security+成本审再上。
3. **Portfolio**：本轮建快照采集管道 + 时序图(后端工程)。
