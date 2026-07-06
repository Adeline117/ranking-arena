# UI/UX 全面翻修计划 — 2026-07(Owner 逐项把关制)

> **与历史台账的本质区别**:UIUX_AUDIT_2026-06-29 / PERPAGE_2026-06-30 是
> "发现问题→自主修掉"模式,已收官但整体体验仍不达标(owner 判断)。
> 本轮换打法:**逐条用户路径重新走查,每一项改动 owner 亲自拍板才动手**。
> 不是修 bug 清单,是重新审视每个界面该长什么样。

## 工作模式(每单元五步,把关点在第 3/5 步)

```
1. 走查   我在生产站真实走完该路径,标准矩阵截图
          (桌面 1440 + 移动 390) × (zh + en) × (登录前 + 登录后) ≈ 8 态
2. 提案   发一个 Artifact 页:标注截图 + 编号问题清单,每项含
          [严重度 P0/P1/P2 | 问题描述 | 改法提案 | 预估工作量]
3. 把关 ★ owner 逐项批:「1,3,5 做;2 不做;4 改成…」——不批不动手
4. 实施   只做批准项;小步 commit;i18n 四语同步;design tokens;
          改完跑 post-deploy-check
5. 验收 ★ 改后截图追加到同一 Artifact,owner 确认 → 单元关闭 → 下一个
```

**纪律**:

- 一次只开一个单元,上一单元未验收不开下一个
- 未批准的项一律不改(包括"顺手修"——发现新问题记入清单等批)
- 走查中发现的**功能性 bug**(非 UI)单独列出并立即报告,修复也需批准
  (核实为线上 500/数据错误级除外——那类按既有铁律直接修并报备)
- 严重度定义:P0=影响转化/不可用/误导用户;P1=明显不专业/费解;P2=打磨
- 每单元关闭后更新本台账状态

## 单元清单(按核心路径优先级排序)

> **覆盖保证**:2026-07-03 用 `find app -name page.tsx` 枚举出全部 **81 个路由**,
> 逐一挂到单元下(下表 route 列)。新增路由必须同步挂进某单元,否则不算覆盖。

| #   | 单元              | 明确路由清单                                                                                                                                                                                                                                                                                  | 状态      |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| U1  | **首页/排行家族** | `/` + `/rankings/bots` `/rankings/exchanges` `/rankings/tokens` `/rankings/tokens/[token]` `/rankings/weekly`(排序/筛选/预设/周期/分类 tab/分页)                                                                                                                                              | 🔜 下一个 |
| U2  | **实体详情家族**  | `/trader/[handle]`(三页+周期+关注/对比/分享) `/bot/[id]` `/exchange/[slug]` `/share/rank/[trader_key]` `/s/[token]` `/trader/authorize`                                                                                                                                                       | 待排      |
| U3  | **搜索**          | `/search` + ⌘K 全局搜索(中英输入/结果/空态)                                                                                                                                                                                                                                                   | 待排      |
| U4  | **登录/注册**     | `/login` `/logout` `/auth/callback` `/reset-password` `/onboarding` + 多账号切换                                                                                                                                                                                                              | 待排      |
| U5  | **变现路径**      | ProGate 触点 → `/pricing` `/pricing/success` `/tip/success` `/referral` `/claim`(promo 关闭前打磨)                                                                                                                                                                                            | 待排      |
| U6  | **对比**          | 对比浮条 → `/compare`                                                                                                                                                                                                                                                                         | 待排      |
| U7  | **Market 家族**   | `/market` `/market/funding-rates` `/market/open-interest` `/flash-news`                                                                                                                                                                                                                       | 待排      |
| U8  | **内容 feed**     | `/hot` `/feed` `/feed/[id]` `/post/[id]` `/post/[id]/edit` `/my-posts` `/hashtag/[tag]`(发帖/标签/贴纸/投票/评论/reaction)                                                                                                                                                                    | 待排      |
| U9  | **Groups/频道**   | `/groups` `/groups/[id]` `/groups/[id]/manage` `/groups/[id]/new` `/groups/apply` `/channels/[channelId]`                                                                                                                                                                                     | 待排      |
| U10 | **Inbox/消息**    | `/inbox` `/notifications` `/messages` `/messages/[conversationId]` + presence/未读徽章                                                                                                                                                                                                        | 待排      |
| U11 | **个人中心家族**  | `/u/[handle]` `/u/[handle]/new` `/user-center` `/settings` `/settings/linked-accounts` `/watchlist` `/favorites` `/favorites/[folderId]` `/following` `/portfolio` `/exchange/auth` `/exchange/auth/api-key` `/exchange/auth/callback`(注意:watchlist 与 favorites 并存,走查时评估是否该合并) | 待排      |
| U12 | **次级/静态页**   | `/learn` `/learn/[slug]` `/quiz` `/quiz/questions` `/quiz/result` `/wrapped/[handle]` `/about` `/help` `/methodology` `/api-docs` `/status` `/offline` `/privacy` `/terms` `/disclaimer` `/dmca` `/design-system`                                                                             | 待排      |
| U13 | **Admin 后台**    | `/admin` `/admin/data-health` `/admin/monitoring` `/admin/monitoring/pipeline` `/admin/pro-metrics` `/admin/reports`(owner 专用,标准可放宽,排最后)                                                                                                                                            | 待排      |
| U14 | **横切兜底**      | 亮色主题 + ja/ko 全站 sweep(前面各单元遗漏的)                                                                                                                                                                                                                                                 | 最后      |

> 顺序依据 CLAUDE.md Product Priority:核心路径(首页→排行→详情→搜索→
> 登录→Pro)优先于次级(Market/社交/Library)。owner 可随时调序/插队。

## 把关操作方式

- 每单元的提案 Artifact 发出后,直接回复编号即可:
  **「1,3,5 做;2 不做;4 改成只留桌面端」**
- 想现场看:提案里每项附生产 URL,可直接点开核对
- 中途想改优先级/加单元:直接说,台账即时更新

## 已定历史决策(继续有效,提案不再重复问)

- 保红绿配色 + 加形状区分(色盲友好)
- 当前持仓免费可见
- 安全项全纳入
- hero「18 交易所」与文案「45+ exchanges」并存是刻意的,不当 bug 修
- **榜单哲学(2026-07-04 owner 拍板)**:排名只看窗口 ROI/PnL,零交易 holder
  合法上榜不降权不设门槛;WIN 列 `trades_count===0` → Holder 徽章(已上线)

## 关联工程项(对应单元实施时必须纳入提案)

- **U1/U2 — tri-state 指标显示语义进 registry**(数据全面性计划 P2b):
  MetricDef 加可选 `zeroLabel?: i18nKey`,渲染约定 = 显式 0+zeroLabel→语义
  标签(Holder 是首例)/ null→破折号+平台注记 / 能力外→N/A note。实现在
  `MetricGrid.tsx` 通用渲染,替代散落 if。
- **U2 — Overview 双轨归一**(P2c,M2):`MetricBadgesGrid.tsx`(14 固定
  prop 的 pre-registry 旧物)迁 `metric-registry`,消灭「同一指标两条读
  路径」(bybit sortino 断链温床)。

## 进度记录

| 日期       | 单元                                     | 提案数                       | 批准           | 完成   | 备注                                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------------- | ---------------------------- | -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-04 | 全站 U1-U14 走查(agent team)             | ~136                         | —              | —      | 14 单元逐路由真点走查完成(桌面/移动×zh/en×登录前后);证据在 scratchpad/sweep/u\*-findings.md                                                                                                                                                                     |
| 2026-07-04 | 真点终验(部署后)                         | —                            | —              | 验证   | ✅已验证修好:/compare 渲染对比数据、pricing FAQ 不崩、reset 亮色白卡黑字。⏳待部署验证:铃铛补 ToastProvider(2463fff07 部署队列中,dpl 未更新)。误诊已交代:compare「promo 门」二次修实为无害冗余(hasFeatureAccess 本就认 promo;403 是测试脚本缺 UA 触发 bot 拦截) |
| 2026-07-04 | 修复第一波(3 worktree agent 并行+主会话) | —                            | (全部去做授权) | **31** | 崩溃类全灭(compare 空渲染/铃铛崩/编辑打不开/pricing FAQ 崩/交易所绑定崩)+谎报类修正(关注假成功/success 谎报付款/status 绿勾)+OI 陈旧过滤/flash-news 来源链接/移动横滚/reset-onboarding 黑底黑字/群feed点不进/举报入口。tsc+build 双绿,CI 部署中,待真点验证      |
| 2026-07-03 | U1 首页/排行家族                         | 17(P0×7 P1×7 P2×2 +1 需拍板) | 待批           | —      | 提案 Artifact 已发;排行 5 子页中 4 个坏/空(bots 143 天未刷/exchanges+weekly 全空/tokens 近空);登录态补查在批准后进行                                                                                                                                            |
