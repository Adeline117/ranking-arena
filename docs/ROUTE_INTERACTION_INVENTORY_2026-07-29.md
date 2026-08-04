# ArenaFi 路由与交互清单 — 2026-07-29，滚动更新至 2026-08-03

> 范围：仓库中 79 个 `page.tsx` 页面、主要重定向入口、全局导航和用户可见
> 按钮。本文说明“点击后去哪、谁能点、成功/失败应看到什么”，不把 API 存在
> 当作 UI 已可用。动态路由必须使用真实 canonical identity，不能用过期固定样本。

## 2026-08-03 增量进展（`485f5a550` 之后，截至 `d93a7b99f`）

- 付款结果：`9bd89c219` 将成功限定为 viewer/session-bound exact authority；
  `a78c1e707` 补齐 verifying/success/error、Retry、结果焦点、ARIA、320px 响应式与
  ≥48px 操作控件。这是代码与 P1 UI 证据，Stripe live 仍被 P0 owner gate 关闭。
- 全局 layout：`e3feea06a` 取消 loading shell 对持久导航的重复高度预留，避免路由转场
  flash；最终 SHA 多视口截图仍待做。
- Groups：`e261d20dc` 解散锁，`3725000b` 广播 single-flight/exact ACK，`b637fc1a`
  成员批处理串行、邀请绑定与旧 scope 隔离，`982d33130` 管理帖子稳定 cursor/去重分页。
- Exchange：`7516d39ea` connect、`ec54092a9` list/projection、`dd784a481` sync/generation
  receipt、`1470d448a` disconnect 均在不完整或 owner/exchange 不匹配时 fail-closed。
  真实 read-only credential 的 connect/list/sync/disconnect 生产 canary 未做。
- Settings：`ad9b727eb` 只在唯一 exact `{ success: true }` 回执后显示 unblock 成功；
  `8dba0f30a` 至 `c2635955a` 还逐域绑定认领、主页、关注、小组/聊天设置、2FA、收藏与举报
  的 exact 回执；`f8daad80a`、`5864861c1`、`ba07aa2d9` 关闭成员偏好和关注分页的旧 scope/timeout 假真值。
- Tip / Referral：`32f99908e` 只接受 durable payment truth；`31c6c538b` 保留并原子消费归因
  intent；`d561dc612` / `66cfb27a6` 用 qualification + entitlement grant 区分 pending、scheduled、
  active、expired、revoked，只有 active 显示 unlocked，409 会 GET 对账而非无限重试。
- Post reaction：`9f2ea9355` 绑定 actor/post/request/action/count，补 15 秒硬超时、viewer scope、
  回滚和迟到 ACK 隔离。底层仍是 toggle；响应超时时再次点击可能反向，后续需 desired-state/
  idempotency authority，当前不伪称彻底清零。
- Comment reaction：`ec688dd0b` 再绑定 actor/post/comment/operation/requested reaction；不确定
  结果优先 canonical GET，读不到才回滚 last-good。跨客户端仍是 toggle，靠 refresh/realtime 收敛。
- Activity Feed：`5fed64896` 将首次加载的空白列表和虚假 `Live` 改成预留稳定高度的 Loading，
  加 `aria-live` / `aria-busy`；375px after 截图无重叠。
- Rankings / Search：`6ca74b703`、`0a309e690`、`1006d4e66`、`ee05be684` 分别收紧
  token index、weekly、全局搜索和 exchange leaderboard；transport 与 JSON 都有物理截止，
  旧查询不能覆盖新 scope，loading/last-good/partial/error/empty 不再混用。
- Shared HTTP：`4764a4156` 让共用请求 helper 即使遇到忽略 AbortSignal 的 transport/body
  也会在真实 deadline 结束，调用方取消和迟到结果不会继续落入 UI。
- Bookmark / token detail：`8b6f7529b` 绑定收藏 actor/post/request/folder 与完整批量状态；
  `1a862e542` 绑定 token/period/page 并补 viewer/query 迟到隔离、错误/空态和 44px 控件。
- Hot / reactions：`91281603e` 严格校验 posts/groups 并保留 last-good；`e37e04911` / `257ed300f`
  将 Hot、Groups、共享 store 统一到 exact reaction receipt 和 scope single-flight。底层 toggle
  仍没有 operation ID/desired-state，不能把超时后的服务端状态写成已确定。
- Compare：`d93a7b99f` 严格绑定有序 source/account 分区、following composite identity 与计数，
  为订阅/关注/搜索/对比各请求 lane 增加物理截止、owner/query generation、last-good/error、
  精确 401 登录恢复和至少 44px 的交互目标。
- 仓库/QA：`2c198f9f6` / `06614c69e` 删除退休入口与 442 行零调用帖子 hooks；`2069f462c`
  给 visual/button sweep 动态 sampler 加稳定 User-Agent。核心本地截图 10 路由 × 2 视口
  **20/20** 成功且均 HTTP 200，动态 trader authority 不健康被明确 skip。
- 本地定向证据：每个切片均通过相关 Jest/Node 合同、ESLint、全量 TypeScript 与 diff-check。
  整体生产仍是 **NO-GO**：数据库恢复/精确
  migration ledger、CopyTrading cap、凭据轮换、Stripe readiness、部署 SHA 与生产 E2E 仍是外部
  或 owner blockers。核心流程与 source freshness 仍未做生产验证，只保留已有的
  **37 registered boards / 34 public-ranking allowed / 23 families** 仓库口径，不得宣称“44 所交易所”。

## 1. 全局交互合同

所有页面和按钮共用以下规则：

1. Logo/Home 回 `/`；主导航进入 Rankings、Market、Groups、Hot/Feed；用户菜单进入
   个人主页、User Center、Inbox、Claim、Referral、Portfolio、Saved、Settings、Logout。
2. 未登录用户触发写动作时进入 `/login?next=<原路径>`；登录恢复完成后才消费一次
   pending intent，不能在短暂伪未登录状态下丢失动作。
3. 服务器写入成功必须有精确 ACK；HTTP 200、空对象、0 行或 owner 不匹配都不是成功。
4. 加载、真空、权限拒绝和请求失败是四种不同 UI。刷新失败保留 last-good，并显示
   Retry；不能把错误画成“暂无数据”。
5. Delete、Unlink、Revoke、Leave、Unfollow 等破坏性动作需要确认；服务端未确认前不从
   UI 永久消失，失败要恢复原状态。
6. 所有 icon-only 按钮有可读名称；键盘有 `focus-visible`；切换项使用 `aria-pressed`
   或 tab 语义；目标至少满足 [WCAG 2.2 24×24 CSS px](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)，
   项目核心手机动作采用 [Apple 44×44 pt](https://developer.apple.com/design/human-interface-guidelines/accessibility)
   级目标。
7. Cookie banner、移动底栏、FAB、toast 与输入法共享 safe-area，不能互相覆盖。
8. `source + exchange_trader_id` 是交易账户身份；handle 只用于展示/路由。任何 Follow、
   Watch、Compare、Share、Alert、Claim 都必须保留 source。
9. 帖子媒体成功回执必须精确绑定当前 viewer、`posts/<owner>/...` 对象路径、配置的
   Supabase origin 和服务器验证的 MIME/size；URL-only、跨 owner、外域或扩展字段均失败。
10. App route loading shell 复用已持久渲染的 TopNav 几何，不再添加第二个 nav spacer；
    验证结束的 success/error 标题接收焦点，loading/error 有对应 live-region 语义。

## 2. 排名数据到用户动作的核心链路

```text
arena.sources / region routing
  → ingest scheduler
  → Tier-A RAW + parse evidence
  → staging validation
  → PASSED publication snapshot
  → profile / series / position enrichment
  → score input manifest + source watermark
  → atomic leaderboard generation/publication
  → /api/rankings, /api/traders, /api/v2/rankings
  → SSR 最终三栏首屏
  → filter / sort / paginate / refresh
  → profile / follow / watch / compare / share / alert / claim
```

抓取成功不等于可公开排名；只有通过证据门并在 freshness 窗口内的 source board 才能
发布。失败来源保留 last-good，不写假 0。当前产品口径是 live ranking source boards，
不是“44 个交易所”。

## 3. 排行榜、发现与市场页面

| 路由                       | 主要入口和按钮                                                                                                                                                                          | 点击结果与状态合同                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                        | 90D/30D/7D、All/Futures/Spot/Web3、Human/Bot、Advanced、Style、Search、Sort、View/Density/Columns、Saved filter、Reset、行卡、Follow、Watch、Compare、Share、Export、Load more、Refresh | 周期切换立即 abort 旧请求且不禁用新按钮；筛选/排序/分页保留 URL 和 source identity；行卡进 `/trader/[handle]`；失败保留榜单与 source watermark。SSR 首帧直接是最终三栏。 |
| `/rankings`                | 导航别名                                                                                                                                                                                | 回到 canonical 排名体验，不维护第二套状态。                                                                                                                              |
| `/rankings/exchanges`      | 周期、市场板、排序、交易所卡/行                                                                                                                                                         | 打开 `/exchange/[slug]`；来源不可用显示 degraded/error，不把 source board 数写成公司数。                                                                                 |
| `/rankings/tokens`         | 周期、token 搜索、排序、热门 token、行卡                                                                                                                                                | 点击 token 进 `/rankings/tokens/[token]`；popular 模块失败不拖垮主榜，保留 last-good 或诚实 503。                                                                        |
| `/rankings/tokens/[token]` | 返回 Tokens、周期、交易账户行、Follow/Compare                                                                                                                                           | 只显示该 token 有证据的交易账户；点击进精确 trader；未知 token 为明确 not-found，不回退到全榜。                                                                          |
| `/rankings/weekly`         | 周榜窗口、分类、交易员行、分享                                                                                                                                                          | 打开精确账户或分享卡；周榜生成失败显示上一份带时间的可信结果。                                                                                                           |
| `/trader/[handle]`         | linked-account tabs、7D/30D/90D、Overview/Stats/Portfolio/Posts、Follow、Watch、Alert、Compare、Share、Claim、Edit、Similar                                                             | account tab 切换 source/account，不按同名猜测；Claim 携带 source+account；Edit 仅 owner；未知值为 `—`，错误与无数据分开。                                                |
| `/exchange/[slug]`         | 返回/面包屑、周期、聚合指标、交易员列表、排序                                                                                                                                           | 进入该 source family 的真实 board/trader；未知 slug 明确 404；更新时间来自 source watermark。                                                                            |
| `/compare`                 | 搜索、从 Following 添加、Remove、指标/图表、Export、Share                                                                                                                               | URL 使用多个 `source:exchange_trader_id`；缺失项给 warning 并从 canonical URL 移除；Remove 精确账户，不折叠跨所同 ID。                                                   |
| `/search`（`?q=`）         | Traders/Posts/People/Groups tabs、输入、Clear、结果卡、Load more                                                                                                                        | 四类独立 loading/empty/error；交易员结果保留 source；People 只读公开 profile；点击进入对应实体。                                                                         |
| `/share/rank/[trader_key]` | 打开 Arena、Copy link、系统分享                                                                                                                                                         | 只渲染已发布 rank identity；失效 key 不生成看似实时的分享卡。                                                                                                            |
| `/wrapped/[handle]`        | 周期/年度摘要、分享、下载、打开交易员                                                                                                                                                   | 手机卡不溢出；handle 必须解析到 serving account，否则明确空态。                                                                                                          |
| `/s/[token]`               | 公共短链/分享落地、继续浏览                                                                                                                                                             | 校验 token 格式与有效期；过期不渲染 live OG；view count 失败不阻断只读落地。                                                                                             |
| `/market`                  | 总览 tabs/cards、Funding、Open Interest、Trades/Signals 入口、Refresh                                                                                                                   | 各 widget 独立失败，不让单一数据源清空整页；手机入口可达，不用 hover 才出现。                                                                                            |
| `/market/funding-rates`    | symbol 搜索、exchange 过滤、排序、APR/热力、刷新                                                                                                                                        | 比较同一口径的 funding/APR；错误保留上次结果；颜色外还有符号/数值冗余。                                                                                                  |
| `/market/open-interest`    | symbol/exchange 过滤、排序、USD/张数、刷新                                                                                                                                              | 24h 变化和份额有文本/符号；部分来源失败显 degraded，不能合成假总量。                                                                                                     |
| `/flash-news`              | All/Breaking、关键词、刷新、新消息 pill、新闻卡                                                                                                                                         | 新内容先缓冲，用户点 pill 后合入，避免阅读位置跳动；失败保留已读列表。                                                                                                   |
| `/status`                  | Refresh、组件状态、事件历史、帮助链接                                                                                                                                                   | health authority 不可达即 Unknown/Failed，不能显示全绿或 100%；不暴露内部凭据。                                                                                          |
| `/offline`                 | Retry、返回已缓存页面                                                                                                                                                                   | `online` 事件可自动重试；离线文案跟随 locale，不能无限 spinner。                                                                                                         |

## 4. 登录、账户、认领和个人主页

| 路由                        | 主要入口和按钮                                                                                                                     | 点击结果与状态合同                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                    | OAuth/邮箱或 OTP、Passkey、Submit、Forgot/Reset、Terms、返回                                                                       | 成功回 `next`；provider 原始错误不回显；auth restore 期间不重复提交；被删/封禁主体 fail-closed。                                       |
| `/auth/callback`            | 自动完成、Retry、返回登录                                                                                                          | 校验 state/session 后按 onboarding truth 跳转；超时和失败有显式 UI，不能按“注册不足 30 秒”猜新用户。                                   |
| `/logout`                   | 自动登出、返回登录/首页                                                                                                            | 清理当前 session 与本地 viewer cache；失败不能展示仍已退出的假状态。                                                                   |
| `/reset-password`           | 发送验证码、New password、Confirm、Submit、返回登录                                                                                | 中性提示避免泄漏账号存在；密码策略与注册一致；验证码/更新 ACK 不完整即失败。                                                           |
| `/onboarding`               | 语言、主题、兴趣、推荐 trader Follow、推荐 group Join、Back/Next/Skip/Finish                                                       | Follow/Join intents 全部落库或明确失败后才完成；同一 viewer scope；Skip 也持久化 completion。                                          |
| `/claim`                    | Search、结果卡、Back/change trader、CEX/DEX method、Verify & Claim、FAQ                                                            | 见下方按钮级流程；所有步骤保存 source+account，失败可重试且不变成“无结果”。                                                            |
| `/trader/authorize`         | 旧授权入口                                                                                                                         | 服务端重定向到 canonical `/claim`，不显示 2 秒空白或宣传未实现 copy-trade。                                                            |
| `/exchange/auth`            | 选择交易所/OAuth/API-key、Continue、Cancel                                                                                         | 只允许支持的 read-only 连接路径；保留返回路径；权限说明在提交前可见。                                                                  |
| `/exchange/auth/api-key`    | Exchange、API key/secret/passphrase、权限说明、Connect、Cancel                                                                     | 拒绝可交易/提现凭据；只有 exact viewer+exchange connect 回执才进入 Portfolio/Settings；失败不缓存明文。                                |
| `/exchange/auth/callback`   | OAuth state 完成、Retry、返回                                                                                                      | state 只能原子消费一次；owner/account lifecycle 不匹配即拒绝。                                                                         |
| `/u/[handle]`               | Following/Followers、Follow/Unfollow、Message、Edit Profile、返回榜单、Posts/Stats/Portfolio tabs、linked trader tabs、Create post | viewer 与 owner 分离；隐私设置关闭时关系数不可点；Edit 仅 owner→`/settings`；Message 受 DM 权限；非交易员隐藏无意义 stats。            |
| `/u/[handle]/new`           | Edit/Preview tabs、正文、图片/视频上传、插入/删除/拖动、Sticker、Poll 开关/选项/单双选、Cancel、Publish                            | owner-only；上传私有/受控资源；离开有 unsaved guard；重复点击只发布一次；失败保留草稿和媒体。                                          |
| `/user-center`              | Profile、活动/账户 tabs、Edit/Settings、查看内容                                                                                   | 当前 viewer 数据；auth 未恢复不先显示陌生空态；导航 section 可键盘切换。                                                               |
| `/settings/linked-accounts` | Connect/Disconnect OAuth/social account、返回 Settings                                                                             | 只操作当前 viewer；disconnect 二次确认；最后一个登录方式受保护，失败保留原连接。                                                       |
| `/portfolio`                | Add exchange/wallet、Sync、Remove、资产/positions/analytics tabs、Retry                                                            | 列表只接受 owner-bound 安全投影；Sync 绑定 exchange+credential generation 回执；Remove 需 exact disconnect ACK；单源失败不清空其他源。 |
| `/referral`                 | Copy code/link、Share、查看进度/奖励、返回                                                                                         | attribution 原子且可重试；不能靠客户端计数发权益；分享失败仍可手动复制。                                                               |
| `/pricing`                  | Monthly/Yearly/Lifetime、Subscribe/Start、Manage billing、FAQ                                                                      | 套餐和 price 必须明确；未登录保存 intent；浏览器只跳规范 Stripe Checkout/Portal；readiness 未通过时真实收费关闭。                      |
| `/pricing/success`          | Verify、Retry、前往 Rankings/Compare/Settings、收据/管理、Referral                                                                 | 只有 exact session/entitlement authority 才显示成功；verifying 不可交互、error 可重试；结果焦点/ARIA 明确，小屏控件 ≥48px。            |
| `/tip/success`              | 验证付款、返回原帖/收款人、Share                                                                                                   | 绑定真实 checkout/tip identity；pending/failed 与 success 分开，不在前端猜金额或收款人。                                               |

### 4.1 Claim 按钮级路径

1. 用户从交易员详情点 **Claim**：URL/intent 带 `source + exchange_trader_id`；从导航
   直接进入时用 Search 搜 handle、账户 ID 或平台线索。
2. **Search** 请求中保留旧结果；失败出现 **Retry**；真零结果才显示 empty。
3. 点结果卡后显示平台、source、账户 ID，再选 **CEX** 或 **DEX**；**Change trader**
   回搜索但不串用旧账户的证明。
4. CEX 的 **Verify & Claim** 只接受 read-only credential/平台证明；双击被 single-flight
   拦截；写/提现权限、owner 漂移、残缺 ACK 都失败。
5. DEX 的 **Connect wallet / Sign message** 只签 challenge，不发链上交易；nonce、origin、
   wallet 与 active profile 原子绑定，重放失败。
6. 自动证明不足时进入 manual review，显示 pending/approved/rejected；失败不自动改 primary。
7. 成功后进入个人主页/Settings Trader Links，可改 label、设 primary、unlink；这些动作均以
   服务端 exact ACK 为准。

### 4.2 Settings `/settings?section=...` 按钮级路径

| Section                | 控件和动作                                                                                                                            | 成功/失败合同                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`              | Avatar/Cover 上传、裁切、Remove、Handle、Bio、Discard、Save                                                                           | 图片先预览，保存失败回滚 URL；handle 冲突内联提示；Discard 恢复服务器真值。                                                                 |
| `security`             | Change email/password、Send reset code、Setup/Verify/Disable 2FA、backup codes、Add/Remove passkey、Retry list、Revoke other sessions | active profile + recent proof；passkey/2FA mutation exact ACK；列表失败显示 Retry；OTP-only 用户不被虚假密码要求卡住。                      |
| `wallet`               | Connect、Sign、Set/查看 wallet、Disconnect                                                                                            | 签名前说明用途；nonce/origin/owner 校验；disconnect 与 account lifecycle 串行，失败保留连接。                                               |
| `linked-accounts` 卡片 | Manage linked accounts                                                                                                                | 跳 `/settings/linked-accounts`，返回保留 section。                                                                                          |
| `exchanges`            | Add、OAuth/API-key connect、Sync、Remove、Retry                                                                                       | 只读权限；单连接错误不覆盖其他连接；remove 等 exact ACK。                                                                                   |
| `trader-links`         | Claim/link、Edit label、Set primary、Unlink                                                                                           | source/account 精确身份；primary 投影原子；viewer 切换时旧请求不可落入新用户。                                                              |
| `api-keys`             | Create、一次性 Reveal/Copy、查看 30 天 Usage、Retry、Revoke、Upgrade                                                                  | 列表/usage 验证 exact payload；失败不显示 0；完整 secret 只出现一次；刷新失败时保留尚未复制的 secret；revoke exact ACK。                    |
| `alerts`               | Enable/Edit/Delete trader alert、历史、Browse traders                                                                                 | 绑定 source/account；保存失败保留编辑值；Browse 回 `/`。                                                                                    |
| `notifications`        | Follow/Like/Comment/Mention/Message/Trader events、Email digest、Haptic toggles                                                       | 单项保存；失败回滚 toggle；通知 authority 不可达不显示已保存。                                                                              |
| `privacy`              | Show followers/following/Pro badge、DM permission、Blocked users、Retry、Unblock                                                      | 关系隐私立即影响 public profile；block list 错误不显示空；unblock 只接受唯一 exact `{ success: true }` ACK，否则保留列表并报错。            |
| `referral` 卡片        | Copy/Share、查看进度                                                                                                                  | 只展示服务端资格；复制失败给可选中文本。                                                                                                    |
| `account`              | Export data、Download、Logout、Delete account、Cancel/Confirm                                                                         | export 校验 MIME/长度/文件名；删除 modal 对 password/OTP provider 采用真实 proof，先持久化 settlement intent，再删除 auth；可安全恢复重试。 |

Settings 左侧/顶部 section 导航更新 `?section=` 并支持浏览器前进/后退；sticky Save bar 只在
有未保存变化时出现，Save/Discard 必须绑定当前 viewer revision，不能覆盖另一标签页的新值。

## 5. 关注、收藏、通知与私聊

| 路由                         | 主要入口和按钮                                                                       | 点击结果与状态合同                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `/following`                 | Traders/People 分类、排序、交易员/用户卡、Unfollow、Load more、Retry                 | 账户 follow 与 user follow 分开；交易账户使用 source/account；刷新失败保留列表；Unfollow 等 exact ACK。             |
| `/watchlist`                 | 搜索/排序、交易员行、Remove、打开详情、Retry                                         | 与榜单/详情 Watch 状态同源；remove 失败不假消失；mutation 使用 bearer user authority。                              |
| `/favorites`                 | My folders/Subscribed tabs、Create folder、folder 卡、Subscribe/Unsubscribe、Retry   | 两类 snapshot 独立分页；private folder 只对 owner；订阅数来自同一快照；create/rename/delete 等服务端确认。          |
| `/favorites/[folderId]`      | Back、Rename/Privacy/Delete、帖子/交易员项、Remove、Subscribe、Load more             | owner、subscriber、public viewer 看到不同动作；folder/post audience 同快照；超出 limit+1 或形状不完整 fail-closed。 |
| `/saved`                     | Traders/Posts/Alerts tabs、Open、Remove、Manage alert、Retry                         | 每类独立 loading/error/empty；tab 状态可链接；失败不清空其他 tab。                                                  |
| `/notifications`             | 类型 filter、通知项、Mark read、Mark all read、Delete/Clear、Load more、Retry        | 先过滤后原子分页；read/delete exact ACK；点击项先保证持久 read，再到 canonical link；重复系统事件 dedupe。          |
| `/inbox`                     | Notifications/Conversations tabs、filter/search、Mark read、New message/group、Retry | auth restore 完成后才判空；两个 tab 独立错误；返回/深链保留选中 tab。                                               |
| `/channels`                  | 兼容入口                                                                             | 进入 canonical inbox/channel 体验，不保留第二套孤儿列表。                                                           |
| `/channels/[channelId]`      | Back、成员/设置、文本/附件、Send、Reply、Reaction、Copy/Delete、搜索、Load older     | membership 在每次读写同快照复核；消息和 reaction 原子；附件私有重签名；打开/聚焦更新 read state。                   |
| `/messages`                  | Direct/Group、搜索、新建会话、会话行、Retry                                          | list/search 使用原子 authority；搜索结果可导航到尚未在初始页加载的会话；错误不显示“没有消息”。                      |
| `/messages/[conversationId]` | Back、信息/设置、发送、附件、Reply、Reaction、Copy/Delete、搜索、Load older          | start/read/page/settings/reaction 各自原子；actor/recipient active；删除内容不返回；私有媒体每次授权。              |

### 5.1 通知生成与点击闭环

1. 排名变化或交易员事件先形成稳定 identity（source、trader、日期、旧值、新值/position）。
2. service-only batch authority 以 500 条分片写入，逐条返回 `CREATED`、`DEDUPLICATED`
   或 `RECIPIENT_UNAVAILABLE`；ACK 必须与请求逐项绑定。
3. 只有 `CREATED` 发 push；分片失败可重跑，dedupe 不会重复通知。
4. 新 position 的 seen-state 只在 durable notification ACK 后推进，不能先消费事件后丢通知。
5. 用户点通知后进入精确 trader/post/group/conversation；目标已删除时显示明确 unavailable，
   不跳到无关同名实体。

## 6. 帖子、Feed 与 Groups 社交交互

| 路由                  | 主要入口和按钮                                                                                        | 点击结果与状态合同                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/feed`               | Following/推荐流、排序、帖子卡、Like/Downvote、Bookmark、Repost、Share、Report、Comment、Load more    | optimistic 动作失败 rollback；分页不混入无权限帖子；登录 intent 回原位置。                                                                                 |
| `/feed/[id]`          | Back、目标 activity/post、完整互动条、Comments                                                        | SSR 目标实体；不存在或不可见明确 404/permission；不以全局 feed 模态冒充详情。                                                                              |
| `/hot`                | 时间/类别 tabs、帖子卡、互动、Load more、Refresh                                                      | hot score authority 漂移时 fail-closed/last-good；tab 用标准键盘语义。                                                                                     |
| `/post/[id]`          | Back、Like/Downvote、Bookmark、Repost、Share、Report、Comment/Reply/Reaction；owner Edit/Delete       | 只渲染该帖和 thread；canonical audience；Delete 要 owner 双谓词、exact 单行 DB/客户端 ACK；registry 上线前不得直接删除 Storage。                           |
| `/post/[id]/edit`     | Edit/Preview、正文/媒体、@mention picker、图片移动/删除、Cancel、Save                                 | owner-only；鉴权失败跳回带 redirect 的登录或明确错误；unsaved guard；正文/facet/join/count 原子 CAS；严格媒体/ACK；失败保留草稿。                          |
| `/my-posts`           | Draft/Published 等分类、Open、Edit/Delete、Retry                                                      | 当前 viewer scope；解析 profile 期间有稳定占位；删除确认后才移除。                                                                                         |
| `/hashtag/[tag]`      | 标签 header、排序、帖子互动、Load more                                                                | tag 贯穿所有分页；不能首屏按 tag、后续混入全局帖子。                                                                                                       |
| `/groups`             | 推荐/已加入/我管理、Search、group 卡、Follow/Join/Apply、Create/Apply                                 | 未登录保留 intent；每类独立状态；权限/会员级别在服务端决定。                                                                                               |
| `/groups/apply`       | 小组资料、规则、头像、Edit/Preview、Cancel、Submit                                                    | 必填/长度内联校验；头像回执绑定当前 owner/path/origin；账户切换丢弃旧完成；unsaved guard；重复提交 single-flight；失败保留表单。                           |
| `/groups/[id]`        | Follow、Join/Apply/Leave、频道/帖子/成员 tabs、创建帖子、成员卡、Share/Report                         | private/premium/member/admin audience 在同一 authority；Leave/Follow exact ACK；tab 深链可恢复。                                                           |
| `/groups/[id]/new`    | Edit/Preview、正文/图片/视频/投票、@mention、Cancel、Publish                                          | member permission 每次提交复核；媒体回执绑定 owner/path/origin/MIME/size；原子发布与严格 ACK；unsaved guard；失败保留内容。                                |
| `/groups/[id]/manage` | Applications、Members、Roles、Mute/Remove/Ban、Invite、Broadcast、Posts Load more、Settings、Dissolve | owner/admin fail-closed；解散在 confirm 期间即锁定；广播/邀请/批量成员动作 single-flight 且 scope-bound；批处理串行；分页用 pin+time+id 稳定 cursor 去重。 |

### 6.1 帖子与评论按钮真值

- **Like/Downvote/Reaction**：UI 可即时反馈，但失败必须回滚到服务器计数；同一用户同一对象
  的互斥关系由服务器保证。
- **Bookmark**：写入 canonical post identity；原帖变私密/删除后 folder read 不得继续泄露。
- **Repost**：重复点击去重；原帖 audience 改变时 repost 不能扩大可见范围。
- **Share/Copy**：只分享 canonical public URL；系统 Share 不可用时回退 Copy，失败给可选中文本。
- **Report**：选择原因、可选证据、Submit/Cancel；提交原子且幂等，不向被举报者泄露 reporter。
- **Comment/Reply**：目标 post/comment audience 同事务复核；blocked relationship fail-closed；发送失败
  保留输入；Delete 仅 owner/moderator 并等待 ACK。

## 7. Learn、帮助、法务和测验

| 路由              | 主要入口和按钮                                            | 点击结果与状态合同                                                             |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/learn`          | Search、category、文章卡                                  | 打开 `/learn/[slug]`；无结果与请求失败分开；键盘可操作。                       |
| `/learn/[slug]`   | TOC/锚点、上一篇/下一篇、返回 Learn、相关链接             | slug 不存在 404；标题锚点可复制；长文焦点/滚动不被 sticky header 遮挡。        |
| `/methodology`    | TOC、公式/来源说明、排行榜 CTA                            | 清楚区分 source board、评分、freshness、异常值与未知值；不写无法证明的宣传数。 |
| `/help`           | Search/分类、FAQ expander、Contact/Report issue、相关链接 | accordion 有 `aria-expanded`；无结果可清除搜索；外链说明目标。                 |
| `/api-docs`       | Endpoint 索引、language tabs、Copy code、Try/升级入口     | Copy 有成功/失败反馈；示例不含 secret；权限/限额与当前 API tier 同源。         |
| `/quiz`           | Start、规则/返回                                          | 建立新的 quiz session 或进入 questions；重复点击不创建多个进度。               |
| `/quiz/questions` | 选项、Back/Next、进度、Submit                             | 未选择时明确提示；前后导航保留答案；最终提交一次。                             |
| `/quiz/result`    | 结果解释、Restart、Share、返回排行榜                      | 只使用本次有效结果；直接深链无 session 时给恢复/重新开始，不伪造分数。         |
| `/about`          | 产品/方法链接、开始探索                                   | 进入排名或 Methodology；统计口径引用 live source boards。                      |
| `/privacy`        | TOC/锚点、相关设置/联系                                   | 当前 locale 单显；Last updated 明确；隐私设置深链到 Settings。                 |
| `/terms`          | TOC/锚点、相关政策                                        | 当前 locale 单显；接受条款不暗示已完成收费授权。                               |
| `/disclaimer`     | TOC、风险说明、返回                                       | 明确非投资建议与数据延迟；不遮挡主要导航。                                     |
| `/dmca`           | TOC、联系/提交流程                                        | 提供所需材料和处理路径；邮件/外链可访问。                                      |

## 8. Admin 页面

所有 Admin 页面都要求服务端 admin 判定；未登录/非管理员显示 401/403 或安全重定向，
不能先渲染敏感数据再隐藏，也不能把 authority 失败画成 0。

| 路由                         | 主要入口和按钮                                  | 点击结果与状态合同                                                                   |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/admin`                     | tab/nav、Refresh、运维 action、详情链接         | `?tab=` 支持前进/后退；写动作有确认与审计；数据源失败显 Unknown/Error。              |
| `/admin/monitoring`          | 组件/来源状态、Refresh、进入 Pipeline           | JWT 调 canonical authority；不把 401/timeout 显示为健康或零平台。                    |
| `/admin/monitoring/pipeline` | 时间/来源 tabs、日志/attempt、Refresh、诊断入口 | partial success 与 failure 分开；大表分页；请求失败保留 last-good。                  |
| `/admin/pro-metrics`         | 时间窗、KPI/趋势、导出/刷新                     | 真实 entitlement/收入投影；Stripe readiness 未过时显 blocked，不猜 0。               |
| `/admin/reports`             | filter、打开目标、Assign/Resolve/Dismiss、证据  | moderator 权限同事务；操作幂等、有 audit log；被删内容用 tombstone，不串到别的对象。 |

## 9. 完整用户旅程验收顺序

### 9.1 未登录发现旅程

`/` 最终三栏首帧 → 切 30D → 筛 Futures → Search → 打开 trader → 切账户/周期 →
Compare/Share → Follow 触发登录 → 登录完成回 trader → Follow exact ACK → `/following` 可见。

### 9.2 认领与主页旅程

Trader **Claim** → source/account 已预选 → CEX read-only 或 DEX sign challenge → pending/approved
状态 → `/settings?section=trader-links` 改 label/primary → `/u/[handle]` 展示 linked trader →
Edit Profile 修改头像/封面/handle/bio → Save revision → public viewer 看到已确认版本。

### 9.3 社交旅程

`/hot`/`/feed` 打开 post → Like/Bookmark/Comment → `/favorites` 查看 canonical post →
进入 group、Join/Apply → channel send/reply/reaction → notification 原子生成 → Inbox 点击回原对象。

### 9.4 账户与收费安全旅程

Settings 添加 passkey/2FA → revoke other sessions → 创建 API key、复制一次性 secret、查看 30 日
usage → revoke → Pricing 只在 readiness 通过后进入官方 Stripe Checkout → Portal 只到官方 billing
域 → Export data → Delete account 持久化 settlement intent、注销 auth、可安全恢复重试。

## 10. 覆盖与剩余验收

- 本清单覆盖 79 个仓库页面文件，并额外记录 `/rankings` canonical alias。
- 公共 read-only sweep 目前覆盖 69 条可实例化 route × desktop/mobile；需要真实 ID 的 post、
  group、feed、share route 从 API 动态获取，不能再使用固定 `soul` 样本判断健康。
- 需登录的 channel、conversation、favorite detail、post edit、group manage/new、profile composer
  必须由双账号 auth sweep 覆盖；admin 使用独立最小权限 fixture。
- 最终截图矩阵至少包含 375×812、768×1024、1280×800、1440×900，明/暗主题和中/英；
  first-paint 另外启用慢 hydration 与 backend unavailable；长文案控件补日文 320/375px。
- 当前 NO-GO 原因和 P0/P1/P2 总表见 `docs/FULL_LAUNCH_AUDIT_2026-07-18.md`。
