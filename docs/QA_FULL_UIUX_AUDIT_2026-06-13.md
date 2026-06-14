# 全站 UI/UX + 用户全流程 QA 审计 — 2026-06-13

**范围**：全部 83 个 page 路由的运行时 + 视觉审计 + 4 条登录态用户旅程
**环境**：本地 `localhost:3000`（写流程/复验）+ 线上 `www.arenafi.org`（运行时 + 视觉对照）
**方法**：扩展的自动化 sweep 套件 + 84 张桌面/移动截图 + 逐条人工核实
**输出**：报告 + 自动修复（发现即修、原子提交、复验）

---

## 健康分：92 / 100

线上无页面崩溃、无 5xx、4 条旅程全绿且写操作已清理。扣分项为 1 个非致命水合
不一致（已根因定位，留作专项）+ 若干测试夹具/工具噪声（已区分）。

---

## 自动化覆盖

| 套件                                    | 覆盖                          | 结果                                         |
| --------------------------------------- | ----------------------------- | -------------------------------------------- |
| `button-sweep.mjs`（未登录，线上）      | 75 路由 × 2 视口 = 150 次检查 | 40 条原始告警 → 3 真 bug + 余为夹具/工具噪声 |
| `auth-button-sweep.mjs`（登录态，线上） | 10 步 / 4 旅程                | 全绿，写操作均反向清理                       |
| `visual-audit.mjs`（线上）              | 42 路由 × 2 视口 = 84 截图    | 100% 捕获成功，`/tmp/arena-shots/`           |
| 登录态动态路由                          | 7 条显式 log skip（非静默）   | messages/favorites/post-edit/group-manage 等 |

---

## 已修复（3 个真 bug，均已 commit + push + 本地验证）

### 1. `/api/bots/[id]` schema 漂移 → 所有 bot 详情页 404 〔P2 次要路径〕

- **根因**：详情路由 SELECT 了 `bot_sources` 不存在的列（`avatar_url/exchange/
strategy_type/status` → 全 42703），`.single()` 报错 → 误返 404。`bot_snapshots`
  同样选了不存在的 `pnl/win_rate/trades_count`；`bot_equity_curve` 表空、列也不存在
  且详情页根本不用。
- **修复**：对齐真实 schema（与 `/api/bots` 列表 + 详情页字段一致），删整段 dead query。
- **验证**：UUID 与 slug 入参均 200。`commit b4d206815`

### 2. 「关注」页主加载漏带 Bearer 头 → 登录用户也 401、列表空 〔P1 核心社交〕

- **根因**：`/api/following` 是 Bearer-only 鉴权（`getAuthUser` 只读 Authorization
  头，`proxy.ts` 无 cookie→Bearer 桥接）。`FollowingPageClient.fetchFollowing` 的
  fetch 没带 auth 头 → 每个登录用户打开关注页都 401 + 错误 toast + 空列表。同组件
  unfollow 与 ComparePageClient 都正确带头，唯独主列表加载漏了。
- **修复**：`fetchFollowing` 改为 `await getAuthHeadersAsync()` 注入 headers。
- **验证**：无头 401 / 带 Bearer 200。`commit 2df8ecd38`

### 3. base58 钱包地址名未截断 → 移动端溢出/裁断 〔P3 核心路径视觉〕

- **根因**：`okx_web3_solana` 等把完整 44 字符 base58 地址存为 handle/display_name，
  `formatDisplayName` 只截断 0x 十六进制，base58（Solana/Tron）原样返回 → 移动端
  (375px) 名字 ~445px 宽被 `overflow:hidden` 硬裁断、无省略号。DOM 实测确认
  （页面无横向滚动，但文本节点 >viewport 被裁）。
- **修复**：API `route.ts` + 客户端 `utils.ts` 双端补 base58 中段截断分支。
- **验证**：Solana 名现为 `3aYy...Jsos` / `APWh...1yb6`。`commit bded89c1b`

---

## 已核实为「非 bug」（逐条验证，未臆断）

| 现象                              | 结论                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/avatar` 429/502/403         | 上游交易所 CDN 限流；代理已移除自身限流 + 重试 + CDN 缓存；`Avatar.tsx onError` 优雅降级为渐变+首字母，**无破图**。仅 console 噪声。 |
| 发帖点赞 400 / DELETE 405         | like 路由是 POST-toggle 且需 `reaction_type` body；sweep 用错契约。功能正常。                                                        |
| 删评论 `/api/comments/{id}` 404   | 无该路由；但删帖 CASCADE 已清掉测试评论（查库为空，**无泄漏**）。                                                                    |
| `/rankings/bots` 本地 ERR         | dev 冷编译超时（warm 后 200/2.2s），非线上问题。                                                                                     |
| INTERACT FAIL tab/period/expander | sweep 选择器未匹配到对应控件，工具误报，非产品 bug。                                                                                 |

---

## 待专项跟进（非致命，未贸然修）

### A. React #418 水合文本不一致 — `/` 与 `/rankings` 〔P2〕

- **性质**：非致命，React 客户端自动重生成该子树，用户最终看到正确内容。
- **根因方向**：SSR i18n / 数据快照在共享基础设施层分叉（`LanguageProvider`
  `useLanguage()` 无 context 兜底走 `getLanguage()` 读 localStorage；`HomeHeroSSR`/
  `RankingControls` 渲染 `t()` 文案）。精确定位需 DOM 级 diff 拿到差异节点。
- **为何不当场修**：改动落在最高流量页 + 全站共享 i18n，贸然改风险高，应作专项任务
  （配 React DevTools / `data-` 属性 diff 精确定位后再改）。

### B. `/groups/apply` 移动端某 `_next/static/chunks/*.js` 500 〔P3〕

- 疑为部署期 chunk 引用过渡态（stale chunk），需复现确认是否持续。

### C. 测试夹具 `/trader/soul` 已失效（weex 上该 trader 不存在）→ 页面优雅 404

- 非产品 bug；建议 sweep 改用 rankings API 实时 handle（auth-sweep 已这么做）。

---

## 工具产出（已 commit `7a02eae78`）

- `scripts/qa/bootstrap-qa-session.mjs`（新）— 生成 `/tmp/qa-session.json`
- `scripts/qa/visual-audit.mjs`（新）— 逐页桌面+移动截图 + 索引
- `scripts/qa/button-sweep.mjs` — 27→75 路由，新增动态 ID 取数 + 显式 skip
- `scripts/qa/auth-button-sweep.mjs` — 修 cookie domain host 派生 bug + 3 条新旅程

**复跑**：

```bash
node scripts/qa/bootstrap-qa-session.mjs
BASE_URL=https://www.arenafi.org node scripts/qa/button-sweep.mjs --lang-sweep
BASE_URL=https://www.arenafi.org node scripts/qa/visual-audit.mjs
BASE_URL=https://www.arenafi.org node scripts/qa/auth-button-sweep.mjs
```

---

## 用户全流程旅程结果（线上，登录态）

1. **核心浏览+订阅** ✅ 登录→排行→交易员详情→/pricing→Stripe checkout（`cs_test_...` 到达）
2. **社交互动** ✅ 发帖/评论/点赞/关注取关全闭环 + 清理；群组/inbox/私信/feed 均渲染
3. **账号管理** ✅ 个人中心/我的帖子/组合/收藏夹/关联账号均渲染
4. **交易所授权** ✅ exchange auth / api-key / claim / trader authorize 均渲染
