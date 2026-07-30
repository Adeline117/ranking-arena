# ArenaFi 路由与交互清单 — 2026-07-29

> 范围：仓库中 79 个 `page.tsx` 页面、主要重定向入口、全局导航和用户可见
> 按钮。本文说明“点击后去哪、谁能点、成功/失败应看到什么”，不把 API 存在
> 当作 UI 已可用。动态路由必须使用真实 canonical identity，不能用过期固定样本。

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
   或 tab 语义；触控目标遵循当前 40px 最低门，核心手机动作优先 44px。
7. Cookie banner、移动底栏、FAB、toast 与输入法共享 safe-area，不能互相覆盖。
8. `source + exchange_trader_id` 是交易账户身份；handle 只用于展示/路由。任何 Follow、
   Watch、Compare、Share、Alert、Claim 都必须保留 source。

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
| `/search?q=`               | Traders/Posts/People/Groups tabs、输入、Clear、结果卡、Load more                                                                                                                        | 四类独立 loading/empty/error；交易员结果保留 source；People 只读公开 profile；点击进入对应实体。                                                                         |
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

| 路由                        | 主要入口和按钮                                                                                                                     | 点击结果与状态合同                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/login`                    | OAuth/邮箱或 OTP、Passkey、Submit、Forgot/Reset、Terms、返回                                                                       | 成功回 `next`；provider 原始错误不回显；auth restore 期间不重复提交；被删/封禁主体 fail-closed。                            |
| `/auth/callback`            | 自动完成、Retry、返回登录                                                                                                          | 校验 state/session 后按 onboarding truth 跳转；超时和失败有显式 UI，不能按“注册不足 30 秒”猜新用户。                        |
| `/logout`                   | 自动登出、返回登录/首页                                                                                                            | 清理当前 session 与本地 viewer cache；失败不能展示仍已退出的假状态。                                                        |
| `/reset-password`           | 发送验证码、New password、Confirm、Submit、返回登录                                                                                | 中性提示避免泄漏账号存在；密码策略与注册一致；验证码/更新 ACK 不完整即失败。                                                |
| `/onboarding`               | 语言、主题、兴趣、推荐 trader Follow、推荐 group Join、Back/Next/Skip/Finish                                                       | Follow/Join intents 全部落库或明确失败后才完成；同一 viewer scope；Skip 也持久化 completion。                               |
| `/claim`                    | Search、结果卡、Back/change trader、CEX/DEX method、Verify & Claim、FAQ                                                            | 见下方按钮级流程；所有步骤保存 source+account，失败可重试且不变成“无结果”。                                                 |
| `/trader/authorize`         | 旧授权入口                                                                                                                         | 服务端重定向到 canonical `/claim`，不显示 2 秒空白或宣传未实现 copy-trade。                                                 |
| `/exchange/auth`            | 选择交易所/OAuth/API-key、Continue、Cancel                                                                                         | 只允许支持的 read-only 连接路径；保留返回路径；权限说明在提交前可见。                                                       |
| `/exchange/auth/api-key`    | Exchange、API key/secret/passphrase、权限说明、Connect、Cancel                                                                     | 拒绝可交易/提现凭据；成功保存只读 proof 并进入 Portfolio/Settings；失败不缓存明文。                                         |
| `/exchange/auth/callback`   | OAuth state 完成、Retry、返回                                                                                                      | state 只能原子消费一次；owner/account lifecycle 不匹配即拒绝。                                                              |
| `/u/[handle]`               | Following/Followers、Follow/Unfollow、Message、Edit Profile、返回榜单、Posts/Stats/Portfolio tabs、linked trader tabs、Create post | viewer 与 owner 分离；隐私设置关闭时关系数不可点；Edit 仅 owner→`/settings`；Message 受 DM 权限；非交易员隐藏无意义 stats。 |
| `/u/[handle]/new`           | Edit/Preview tabs、正文、图片/视频上传、插入/删除/拖动、Sticker、Poll 开关/选项/单双选、Cancel、Publish                            | owner-only；上传私有/受控资源；离开有 unsaved guard；重复点击只发布一次；失败保留草稿和媒体。                               |
| `/user-center`              | Profile、活动/账户 tabs、Edit/Settings、查看内容                                                                                   | 当前 viewer 数据；auth 未恢复不先显示陌生空态；导航 section 可键盘切换。                                                    |
| `/settings/linked-accounts` | Connect/Disconnect OAuth/social account、返回 Settings                                                                             | 只操作当前 viewer；disconnect 二次确认；最后一个登录方式受保护，失败保留原连接。                                            |
| `/portfolio`                | Add exchange/wallet、Sync、Remove、资产/positions/analytics tabs、Retry                                                            | credential 只读；单源同步失败不清空其他来源；Remove 等服务器确认；equity projection 原子发布。                              |
| `/referral`                 | Copy code/link、Share、查看进度/奖励、返回                                                                                         | attribution 原子且可重试；不能靠客户端计数发权益；分享失败仍可手动复制。                                                    |
| `/pricing`                  | Monthly/Yearly/Lifetime、Subscribe/Start、Manage billing、FAQ                                                                      | 套餐和 price 必须明确；未登录保存 intent；浏览器只跳规范 Stripe Checkout/Portal；readiness 未通过时真实收费关闭。           |
| `/pricing/success`          | Verify、前往首价值动作、收据/管理、Referral                                                                                        | 只有已验证 session/entitlement 才显示成功；pending 有重试，不能用 query string 自证 Pro。                                   |
| `/tip/success`              | 验证付款、返回原帖/收款人、Share                                                                                                   | 绑定真实 checkout/tip identity；pending/failed 与 success 分开，不在前端猜金额或收款人。                                    |

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
| `privacy`              | Show followers/following/Pro badge、DM permission、Blocked users、Retry、Unblock                                                      | 关系隐私立即影响 public profile；block list 错误不显示空；unblock exact ACK。                                                               |
| `referral` 卡片        | Copy/Share、查看进度                                                                                                                  | 只展示服务端资格；复制失败给可选中文本。                                                                                                    |
| `account`              | Export data、Download、Logout、Delete account、Cancel/Confirm                                                                         | export 校验 MIME/长度/文件名；删除 modal 对 password/OTP provider 采用真实 proof，先持久化 settlement intent，再删除 auth；可安全恢复重试。 |

Settings 左侧/顶部 section 导航更新 `?section=` 并支持浏览器前进/后退；sticky Save bar 只在
有未保存变化时出现，Save/Discard 必须绑定当前 viewer revision，不能覆盖另一标签页的新值。
