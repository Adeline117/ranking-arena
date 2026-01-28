# 项目结构与功能梳理

本文档详细梳理了 Ranking Arena 项目的每个目录和文件的功能。

## 项目概述

**Ranking Arena** 是一个加密货币交易员排行榜与社区平台，聚合多个交易所的跟单数据，提供透明的交易员排名和社区讨论功能。

**技术栈**: Next.js 16 (App Router) + React 19 + TypeScript + Supabase + Tailwind CSS 4

---

## 目录结构详解

### 1. 根目录配置文件

#### 1.1 包管理与构建配置
- **`package.json`** - 项目依赖、脚本命令定义
  - 主要依赖：Next.js、React、Supabase、Stripe、SWR、Zustand
  - 开发工具：Jest、Playwright、Storybook、ESLint、Prettier
  - 脚本命令：开发、构建、测试、格式化、数据抓取等

- **`package-lock.json`** - npm 锁定文件，确保依赖版本一致性

- **`tsconfig.json`** - TypeScript 编译配置
  - 严格模式、ES2022 目标
  - 路径别名 `@/*` 指向根目录

- **`next.config.ts`** - Next.js 配置文件
  - Webpack 配置（处理服务端模块）
  - 图片优化配置（AVIF/WebP、CDN 域名白名单）
  - 安全头配置
  - Sentry 集成
  - Bundle Analyzer 集成

- **`vercel.json`** - Vercel 部署配置
  - Cron 定时任务（数据抓取、更新检查）
  - 缓存头配置（API 响应缓存策略）

#### 1.2 代码质量配置
- **`eslint.config.mjs`** - ESLint 代码检查配置
- **`.prettierrc`** - Prettier 代码格式化配置
- **`.gitignore`** - Git 忽略文件配置

#### 1.3 CI/CD 配置
- **`.github/workflows/ci.yml`** - GitHub Actions CI 配置
  - Lint & 单元测试
  - 构建验证
  - E2E 测试（Playwright）

- **`.github/workflows/deploy.yml`** - GitHub Actions 部署配置
  - 自动部署到 Vercel 生产环境
  - 构建和部署流程

- **`.github/dependabot.yml`** - Dependabot 依赖更新配置
  - 每周自动检查 npm 和 GitHub Actions 依赖更新

#### 1.4 开发工具配置
- **`.vscode/settings.json`** - VS Code 编辑器配置
- **`.vscode/extensions.json`** - 推荐的 VS Code 扩展
- **`.storybook/`** - Storybook 组件文档配置
- **`playwright.config.ts`** - Playwright E2E 测试配置
- **`jest.config.js`** - Jest 单元测试配置
- **`jest.setup.js`** - Jest 测试环境设置

#### 1.5 移动端配置
- **`capacitor.config.json`** - Capacitor 移动端配置
- **`android/`** - Android 原生项目
- **`ios/`** - iOS 原生项目

#### 1.6 监控与错误追踪
- **`instrumentation-client.ts`** - Sentry 客户端配置 (Turbopack compatible)
- **`sentry.edge.config.ts`** - Sentry Edge Runtime 配置
- **`instrumentation.ts`** - Next.js 插桩配置（用于监控）

---

### 2. `/app` - Next.js App Router 应用目录

#### 2.1 页面路由 (`/app`)
- **`page.tsx`** - 首页入口
- **`layout.tsx`** - 根布局（全局 Providers、字体、元数据）
- **`globals.css`** - 全局样式
- **`loading.tsx`** - 全局加载状态
- **`error.tsx`** - 全局错误边界
- **`global-error.tsx`** - 全局错误页面
- **`not-found.tsx`** - 404 页面
- **`robots.ts`** - robots.txt 生成
- **`sitemap.ts`** - sitemap.xml 生成

#### 2.2 用户相关路由
- **`/login`** - 登录页面
- **`/logout`** - 登出页面
- **`/onboarding`** - 新用户引导
- **`/welcome`** - 欢迎页面
- **`/settings`** - 用户设置
- **`/reset-password`** - 密码重置

#### 2.3 交易员相关路由
- **`/trader/[handle]`** - 交易员详情页
- **`/u/[handle]`** - 用户主页
- **`/u/[handle]/new`** - 新用户主页创建

#### 2.4 社区功能路由
- **`/groups`** - 小组列表
- **`/groups/[id]`** - 小组详情页
- **`/groups/[id]/new`** - 创建小组帖子
- **`/groups/[id]/manage`** - 小组管理
- **`/groups/apply`** - 小组申请

- **`/post/[id]`** - 帖子详情
- **`/post/[id]/edit`** - 编辑帖子
- **`/my-posts`** - 我的帖子

- **`/favorites`** - 收藏夹列表
- **`/favorites/[folderId]`** - 收藏夹详情

- **`/following`** - 关注列表
- **`/hot`** - 热门内容

#### 2.5 消息与通知
- **`/messages`** - 消息列表
- **`/messages/[conversationId]`** - 对话详情
- **`/notifications`** - 通知中心

#### 2.6 其他功能路由
- **`/search`** - 搜索页面
- **`/compare`** - 交易员对比
- **`/dashboard`** - 用户仪表板
- **`/help`** - 帮助中心
- **`/pricing`** - 定价页面
- **`/pricing/success`** - 支付成功
- **`/tip`** - 打赏功能
- **`/tip/success`** - 打赏成功
- **`/exchange/auth`** - 交易所认证
- **`/exchange/auth/api-key`** - API Key 认证
- **`/exchange/auth/callback`** - OAuth 回调
- **`/exchange/authorize`** - 交易所授权
- **`/exchange/callback`** - 交易所回调
- **`/offline`** - 离线页面

#### 2.7 法律页面 (`(legal)`)
- **`/privacy`** - 隐私政策
- **`/terms`** - 服务条款

#### 2.8 管理后台 (`/admin`)
- **`/admin/page.tsx`** - 管理后台主页面
- **`/admin/hooks/`** - 管理后台 Hooks
  - `useAdminAuth.ts` - 管理员认证
  - `useUsers.ts` - 用户管理
  - `useReports.ts` - 举报管理
  - `useApplications.ts` - 申请管理
  - `useAlertConfig.ts` - 提醒配置
  - `useStats.ts` - 统计信息
  - `useFreshness.ts` - 数据新鲜度
- **`/admin/components/`** - 管理后台组件
  - `DashboardTab.tsx` - 仪表板标签页
  - `UserManagementTab.tsx` - 用户管理标签页
  - `ReportsTab.tsx` - 举报管理标签页
  - `GroupApplicationsTab.tsx` - 小组申请标签页
  - `AlertConfigTab.tsx` - 提醒配置标签页
  - `ScraperStatusTab.tsx` - 爬虫状态标签页
  - `GroupEditTab.tsx` - 小组编辑标签页

#### 2.9 样式文件 (`/styles`)
- **`animations.css`** - 动画样式
- **`responsive.css`** - 响应式样式
- **`trader-animations.css`** - 交易员页面动画

---

### 3. `/app/api` - API 路由层 (111+ endpoints)

#### 3.1 交易员相关 API (`/api/traders`, `/api/trader`)
- **`/api/traders/route.ts`** - 获取交易员列表（支持分页、筛选、排序）
- **`/api/traders/[handle]/full/route.ts`** - 获取交易员完整信息
- **`/api/traders/[handle]/route.ts`** - 获取交易员详情
- **`/api/traders/[handle]/positions/route.ts`** - 获取持仓信息
- **`/api/traders/[handle]/equity/route.ts`** - 获取权益曲线
- **`/api/traders/[handle]/percentile/route.ts`** - 获取百分位数排名
- **`/api/traders/claim/route.ts`** - 认领交易员账户

#### 3.2 帖子相关 API (`/api/posts`)
- **`/api/posts/route.ts`** - 获取帖子列表、创建帖子
- **`/api/posts/[id]/route.ts`** - 获取帖子详情、更新、删除
- **`/api/posts/[id]/like/route.ts`** - 点赞/取消点赞
- **`/api/posts/[id]/comments/route.ts`** - 获取评论列表、发表评论
- **`/api/posts/[id]/comments/like/route.ts`** - 评论点赞
- **`/api/posts/[id]/bookmark/route.ts`** - 收藏帖子
- **`/api/posts/[id]/repost/route.ts`** - 转发帖子
- **`/api/posts/[id]/pin/route.ts`** - 置顶帖子
- **`/api/posts/[id]/vote/route.ts`** - 投票
- **`/api/posts/[id]/poll-vote/route.ts`** - 投票功能
- **`/api/posts/[id]/edit/route.ts`** - 编辑帖子
- **`/api/posts/[id]/delete/route.ts`** - 删除帖子
- **`/api/posts/bookmarks/status/route.ts`** - 获取收藏状态
- **`/api/posts/link-preview/route.ts`** - 链接预览
- **`/api/posts/upload-image/route.ts`** - 上传图片

#### 3.3 小组相关 API (`/api/groups`)
- **`/api/groups/[id]/posts/[postId]/delete/route.ts`** - 删除小组帖子
- **`/api/groups/[id]/comments/[commentId]/delete/route.ts`** - 删除评论
- **`/api/groups/[id]/complaints/route.ts`** - 举报管理
- **`/api/groups/[id]/complaints/[complaintId]/vote/route.ts`** - 投票举报
- **`/api/groups/[id]/leader-election/route.ts`** - 组长选举
- **`/api/groups/[id]/leader-election/start-voting/route.ts`** - 开始投票
- **`/api/groups/[id]/leader-election/vote/route.ts`** - 投票
- **`/api/groups/[id]/members/[userId]/mute/route.ts`** - 禁言成员
- **`/api/groups/[id]/members/[userId]/role/route.ts`** - 修改成员角色
- **`/api/groups/[id]/edit-apply/route.ts`** - 小组编辑申请
- **`/api/groups/applications/route.ts`** - 小组申请列表
- **`/api/groups/applications/[id]/approve/route.ts`** - 批准申请
- **`/api/groups/applications/[id]/reject/route.ts`** - 拒绝申请
- **`/api/groups/apply/route.ts`** - 提交小组申请
- **`/api/groups/edit-applications/route.ts`** - 编辑申请列表
- **`/api/groups/edit-applications/[id]/approve/route.ts`** - 批准编辑申请
- **`/api/groups/edit-applications/[id]/reject/route.ts`** - 拒绝编辑申请
- **`/api/groups/subscribe/route.ts`** - 订阅小组

#### 3.4 用户相关 API (`/api/users`, `/api/follow`)
- **`/api/users/[handle]/full/route.ts`** - 获取用户完整信息
- **`/api/users/[handle]/followers/route.ts`** - 获取粉丝列表
- **`/api/users/[handle]/following/route.ts`** - 获取关注列表
- **`/api/users/[handle]/bookmark-folders/route.ts`** - 获取收藏夹列表
- **`/api/users/follow/route.ts`** - 关注/取消关注用户
- **`/api/follow/route.ts`** - 关注交易员
- **`/api/following/route.ts`** - 获取关注列表

#### 3.5 交易所绑定 API (`/api/exchange`)
- **`/api/exchange/authorize/route.ts`** - 授权交易所连接
- **`/api/exchange/connect/route.ts`** - 连接交易所
- **`/api/exchange/disconnect/route.ts`** - 断开连接
- **`/api/exchange/oauth/authorize/route.ts`** - OAuth 授权
- **`/api/exchange/oauth/callback/route.ts`** - OAuth 回调
- **`/api/exchange/oauth/refresh/route.ts`** - 刷新 OAuth Token
- **`/api/exchange/sync/route.ts`** - 同步交易所数据
- **`/api/exchange/verify-ownership/route.ts`** - 验证账户所有权

#### 3.6 支付相关 API (`/api/stripe`, `/api/subscription`)
- **`/api/stripe/create-checkout/route.ts`** - 创建 Stripe 支付会话
- **`/api/stripe/portal/route.ts`** - 访问 Stripe 客户门户
- **`/api/stripe/verify-session/route.ts`** - 验证支付会话
- **`/api/stripe/webhook/route.ts`** - Stripe Webhook 处理
- **`/api/subscription/route.ts`** - 订阅管理
- **`/api/checkout/route.ts`** - 结算
- **`/api/tip/route.ts`** - 打赏
- **`/api/tip/checkout/route.ts`** - 打赏结算

#### 3.7 定时任务 API (`/api/cron`)
- **`/api/cron/fetch-hot-traders/route.ts`** - 抓取热门交易员（每15分钟）
- **`/api/cron/fetch-followed-traders/route.ts`** - 更新关注交易员（每小时）
- **`/api/cron/check-data-freshness/route.ts`** - 检查数据新鲜度（每3小时）
- **`/api/cron/fetch-traders/route.ts`** - 抓取交易员列表（各交易所）
- **`/api/cron/fetch-traders/[platform]/route.ts`** - 按平台抓取交易员
- **`/api/cron/fetch-details/route.ts`** - 抓取交易员详情（每2小时）
- **`/api/cron/check-trader-alerts/route.ts`** - 检查交易员提醒
- **`/api/cron/trigger-fetch/route.ts`** - 手动触发抓取

#### 3.8 数据抓取 API (`/api/scrape`)
- **`/api/scrape/binance/route.ts`** - 抓取 Binance 数据
- **`/api/scrape/mexc/route.ts`** - 抓取 MEXC 数据
- **`/api/scrape/trigger/route.ts`** - 手动触发抓取

#### 3.9 消息与通知 API
- **`/api/messages/route.ts`** - 获取消息列表
- **`/api/messages/start/route.ts`** - 开始对话
- **`/api/conversations/route.ts`** - 获取对话列表
- **`/api/notifications/route.ts`** - 获取通知列表
- **`/api/notifications/mark-read/route.ts`** - 标记通知已读

#### 3.10 收藏夹 API (`/api/bookmark-folders`)
- **`/api/bookmark-folders/route.ts`** - 创建/获取收藏夹
- **`/api/bookmark-folders/[id]/route.ts`** - 更新/删除收藏夹
- **`/api/bookmark-folders/[id]/subscribe/route.ts`** - 订阅收藏夹
- **`/api/bookmark-folders/subscribed/route.ts`** - 获取订阅的收藏夹

#### 3.11 管理后台 API (`/api/admin`)
- **`/api/admin/stats/route.ts`** - 获取统计信息
- **`/api/admin/users/route.ts`** - 用户管理
- **`/api/admin/users/[id]/ban/route.ts`** - 封禁用户
- **`/api/admin/users/[id]/unban/route.ts`** - 解封用户
- **`/api/admin/reports/route.ts`** - 举报管理
- **`/api/admin/reports/[id]/resolve/route.ts`** - 处理举报
- **`/api/admin/alert-config/route.ts`** - 提醒配置
- **`/api/admin/data-report/route.ts`** - 数据报告
- **`/api/admin/import-binance/route.ts`** - 导入 Binance 数据

#### 3.12 其他功能 API
- **`/api/health/route.ts`** - 健康检查
- **`/api/health/detailed/route.ts`** - 详细健康状态
- **`/api/market/route.ts`** - 市场数据
- **`/api/search/route.ts`** - 搜索（内联在页面中）
- **`/api/compare/route.ts`** - 交易员对比
- **`/api/portfolio/suggestions/route.ts`** - 投资组合建议
- **`/api/risk-alerts/route.ts`** - 风险提醒
- **`/api/risk-alerts/config/route.ts`** - 风险提醒配置
- **`/api/trader-alerts/route.ts`** - 交易员提醒
- **`/api/saved-filters/route.ts`** - 保存的筛选器
- **`/api/translate/route.ts`** - 翻译服务
- **`/api/avatar/route.ts`** - 头像上传
- **`/api/avoid-list/route.ts`** - 屏蔽列表
- **`/api/export/route.ts`** - 数据导出
- **`/api/push/subscribe/route.ts`** - 推送通知订阅
- **`/api/pro-official-group/route.ts`** - Pro 官方小组
- **`/api/docs/route.ts`** - API 文档生成
- **`/api/test-binance/route.ts`** - 测试 Binance 连接

#### 3.13 Webhook API
- **`/api/webhook/stripe/route.ts`** - Stripe Webhook（备用）

---

### 4. `/app/components` - React 组件库

#### 4.1 基础组件 (`/Base`)
- **`Button.tsx`** - 按钮组件（多种变体、尺寸、状态）
- **`Text.tsx`** - 文本组件（排版、样式）
- **`Box.tsx`** - 容器组件（布局、间距）
- **`OptimizedImage.tsx`** - 优化的图片组件（懒加载、响应式）

#### 4.2 UI 组件 (`/UI`)
- **`Card.tsx`** - 卡片组件
- **`Dialog.tsx`** - 对话框组件
- **`Toast.tsx`** - 提示消息组件
- **`Avatar.tsx`** - 头像组件
- **`LoadingSpinner.tsx`** - 加载动画
- **`Skeleton.tsx`** - 骨架屏组件
- **`EmptyState.tsx`** - 空状态组件
- **`ErrorMessage.tsx`** - 错误消息组件
- **`LazyImage.tsx`** - 懒加载图片
- **`VirtualList.tsx`** - 虚拟列表（性能优化）
- **`BookmarkModal.tsx`** - 收藏夹模态框
- **`FollowListModal.tsx`** - 关注列表模态框
- **`FollowButton.tsx`** - 关注按钮
- **`FavoriteButton.tsx`** - 收藏按钮
- **`MessageButton.tsx`** - 消息按钮
- **`UserFollowButton.tsx`** - 用户关注按钮
- **`ExchangeLogo.tsx`** - 交易所 Logo
- **`ProBadge.tsx`** - Pro 徽章
- **`ScoreRulesModal.tsx`** - 评分规则模态框
- **`ThemeToggle.tsx`** - 主题切换
- **`LanguageToggle.tsx`** - 语言切换
- **`GlobalProgress.tsx`** - 全局进度条
- **`PageTransition.tsx`** - 页面过渡动画
- **`CookieConsent.tsx`** - Cookie 同意组件
- **`Disclaimer.tsx`** - 免责声明
- **`ContactSupportButton.tsx`** - 联系支持按钮

#### 4.3 图表组件 (`/Charts`)
- **`EquityCurve.tsx`** - 权益曲线图
- **`PnLChart.tsx`** - 盈亏图表
- **`DrawdownChart.tsx`** - 回撤图表
- **`ChartTimeSelector.tsx`** - 图表时间选择器

#### 4.4 交易员组件 (`/Trader`)
- **`TraderHeader.tsx`** - 交易员头部信息
- **`TraderTabs.tsx`** - 交易员标签页导航
- **`TraderAboutCard.tsx`** - 交易员简介卡片
- **`OverviewPerformanceCard.tsx`** - 概览绩效卡片
- **`PerformanceCharts.tsx`** - 绩效图表集合
- **`RiskMetricsCard.tsx`** - 风险指标卡片
- **`AccountRequiredStats.tsx`** - 账户必需统计
- **`LivePositions.tsx`** - 实时持仓
- **`PortfolioTable.tsx`** - 投资组合表格
- **`SimilarTraders.tsx`** - 相似交易员推荐
- **`ClaimTraderButton.tsx`** - 认领交易员按钮
- **`TraderFeed.tsx`** - 交易员动态流
- **`PinnedPost.tsx`** - 置顶帖子
- **`CreatedGroups.tsx`** - 创建的小组
- **`UserBookmarkFolders.tsx`** - 用户收藏夹
- **`UserHomeLayout.tsx`** - 用户主页布局
- **`TradingViewShell.tsx`** - TradingView 图表外壳
- **`stats/StatsPage.tsx`** - 统计页面
- **`stats/TradingStats.tsx`** - 交易统计
- **`stats/TrustStats.tsx`** - 信任统计
- **`stats/AdditionalStats.tsx`** - 额外统计
- **`stats/PerformanceChart.tsx`** - 绩效图表
- **`stats/FrequentlyTraded.tsx`** - 常用交易
- **`stats/ExpectedDividends.tsx`** - 预期分红

#### 4.5 功能组件 (`/Features`)
- **`RankingTable.tsx`** - 排行榜表格
- **`RankingTableCompact.tsx`** - 紧凑版排行榜
- **`CategoryRankingTabs.tsx`** - 分类排行榜标签页
- **`PostFeed.tsx`** - 帖子流组件
- **`PostFeed/PostCard.tsx`** - 帖子卡片
- **`PostFeed/PostActions.tsx`** - 帖子操作按钮
- **`PostFeed/PostModal.tsx`** - 帖子详情模态框
- **`PostFeed/AvatarLink.tsx`** - 头像链接
- **`PostFeed/hooks/usePosts.ts`** - 帖子数据 Hook
- **`PostFeed/hooks/usePostTranslation.ts`** - 帖子翻译 Hook
- **`EnhancedSearch.tsx`** - 增强搜索组件
- **`SearchDropdown.tsx`** - 搜索下拉菜单
- **`CompareTraders.tsx`** - 交易员对比组件
- **`TraderDrawer.tsx`** - 交易员抽屉组件
- **`MarketPanel.tsx`** - 市场面板
- **`VoteButtons.tsx`** - 投票按钮
- **`SocialShare.tsx`** - 社交分享
- **`Onboarding.tsx`** - 新用户引导

#### 4.6 首页组件 (`/Home`)
- **`HomePage.tsx`** - 首页主组件
- **`RankingSection.tsx`** - 排行榜区域
- **`SidebarSection.tsx`** - 侧边栏区域
- **`TimeRangeSelector.tsx`** - 时间范围选择器
- **`hooks/useAuth.ts`** - 认证 Hook
- **`hooks/useSubscription.ts`** - 订阅 Hook
- **`hooks/useTraderData.ts`** - 交易员数据 Hook

#### 4.7 布局组件 (`/Layout`)
- **`TopNav.tsx`** - 顶部导航栏
- **`MobileNav.tsx`** - 移动端导航
- **`MobileBottomNav.tsx`** - 移动端底部导航

#### 4.8 高级功能组件 (`/Pro`)
- **`AdvancedFilter.tsx`** - 高级筛选器
- **`PremiumGate.tsx`** - Premium 功能门控
- **`ProFeaturesPanel.tsx`** - Pro 功能面板
- **`ScoreBreakdown.tsx`** - 评分分解
- **`TraderComparison.tsx`** - 交易员对比（Pro 版）
- **`UpgradePrompt.tsx`** - 升级提示

#### 4.9 Premium 组件 (`/Premium`)
- **`Paywall.tsx`** - 付费墙
- **`PremiumBadge.tsx`** - Premium 徽章

#### 4.10 小组组件 (`/Groups`)
- **`PremiumGroupCard.tsx`** - Premium 小组卡片

#### 4.11 图标系统 (`/Icons`)
- **`IconSystem.tsx`** - 图标系统组件
- **`index.ts`** - 图标导出

#### 4.12 工具组件 (`/Utils`)
- **`ErrorBoundary.tsx`** - 错误边界组件
- **`AnalyticsProvider.tsx`** - 分析服务提供者
- **`LanguageProvider.tsx`** - 语言提供者
- **`LanguageSwitcher.tsx`** - 语言切换器
- **`KeyboardShortcuts.tsx`** - 键盘快捷键
- **`ServiceWorkerRegistration.tsx`** - Service Worker 注册
- **`StreamingBoundary.tsx`** - 流式边界组件
- **`ExportButton.tsx`** - 导出按钮
- **`JsonLd.tsx`** - 结构化数据（JSON-LD）

#### 4.13 服务器组件 (`/Server`)
- **`TraderListServer.tsx`** - 交易员列表服务器组件
- **`MarketDataServer.tsx`** - 市场数据服务器组件

#### 4.14 其他组件
- **`Providers.tsx`** - 全局 Context Providers 集合
- **`ExchangeConnection.tsx`** - 交易所连接组件
- **`ExchangeQuickConnect.tsx`** - 快速连接交易所

---

### 5. `/lib` - 共享库代码

#### 5.1 API 层 (`/api`)
- **`middleware.ts`** - API 中间件（认证、限流、错误处理）
- **`auth.ts`** - API 认证工具
- **`response.ts`** - 统一响应格式
- **`errors.ts`** - 错误类型定义
- **`validation.ts`** - 请求验证
- **`client.ts`** - API 客户端
- **`logger-middleware.ts`** - 日志中间件
- **`versioning.ts`** - API 版本控制
- **`openapi-generator.ts`** - OpenAPI 文档生成

#### 5.2 数据层 (`/data`)
- **`trader.ts`** - 交易员数据操作
- **`trader-loader.ts`** - 交易员数据加载器
- **`trader-snapshots.ts`** - 交易员快照
- **`trader-claims.ts`** - 交易员认领
- **`trader-followers.ts`** - 交易员关注者
- **`posts.ts`** - 帖子数据操作
- **`comments.ts`** - 评论数据操作
- **`notifications.ts`** - 通知数据操作
- **`avoid-list.ts`** - 屏蔽列表数据
- **`user-trading.ts`** - 用户交易数据
- **`invites.ts`** - 邀请数据

#### 5.3 React Hooks (`/hooks`)
- **`useSWR.ts`** - SWR 数据获取 Hook（增强版）
- **`SWRConfig.tsx`** - SWR 全局配置
- **`useSWRFetch.ts`** - SWR 请求 Hook
- **`useApiMutation.ts`** - API 变更操作 Hook
- **`useDataFetching.ts`** - 数据获取 Hook
- **`useFormValidation.tsx`** - 表单验证 Hook
- **`useImagePreload.ts`** - 图片预加载 Hook
- **`useIntersectionObserver.ts`** - 交叉观察器 Hook
- **`useMobileGestures.ts`** - 移动端手势 Hook
- **`useNetworkStatus.tsx`** - 网络状态 Hook
- **`useOptimisticUpdate.ts`** - 乐观更新 Hook
- **`usePushNotifications.ts`** - 推送通知 Hook
- **`useRealtime.ts`** - 实时订阅 Hook
- **`useSettings.ts`** - 设置 Hook
- **`useSubmit.ts`** - 表单提交 Hook
- **`useCsrf.ts`** - CSRF Token Hook

#### 5.4 状态管理 (`/stores`)
- **`index.ts`** - Zustand Stores 导出

#### 5.5 Supabase 客户端 (`/supabase`)
- **`client.ts`** - Supabase 客户端（浏览器端）
- **`server.ts`** - Supabase 服务器端客户端

#### 5.6 工具函数 (`/utils`)
- **`arena-score.ts`** - Arena Score 计算算法
- **`format.ts`** - 格式化工具（数字、货币、日期）
- **`date.ts`** - 日期处理工具
- **`sanitize.ts`** - 内容清理（XSS 防护）
- **`validation.ts`** - 数据验证工具
- **`ranking.ts`** - 排名计算
- **`avatar.ts`** - 头像处理
- **`csrf.ts`** - CSRF 保护
- **`logger.ts`** - 日志工具
- **`cache.ts`** - 缓存工具
- **`redis.ts`** - Redis 客户端
- **`server-cache.ts`** - 服务器端缓存
- **`rate-limit.ts`** - 限流工具
- **`circuit-breaker.ts`** - 熔断器模式
- **`anomaly-detection.ts`** - 异常检测
- **`similarity.ts`** - 相似度计算
- **`portfolio-builder.ts`** - 投资组合构建器
- **`content.ts`** - 内容处理
- **`lazy-import.tsx`** - 懒加载导入
- **`data-validation.ts`** - 数据验证
- **`env.ts`** - 环境变量工具

#### 5.7 交易所集成 (`/exchange`)
- **`binance.ts`** - Binance API 封装
- **`bybit.ts`** - Bybit API 封装
- **`bitget.ts`** - Bitget API 封装
- **`coinex.ts`** - CoinEx API 封装
- **`mexc.ts`** - MEXC API 封装
- **`encryption.ts`** - API Key 加密存储
- **`index.ts`** - 交易所 API 导出

#### 5.8 类型定义 (`/types`)
- **`trader.ts`** - 交易员类型
- **`post.ts`** - 帖子类型
- **`comment.ts`** - 评论类型
- **`notification.ts`** - 通知类型
- **`index.ts`** - 类型导出

#### 5.9 缓存层 (`/cache`)
- **`index.ts`** - 缓存工具（Redis + 内存回退）
- **`keys.ts`** - 缓存键定义
- **`memory-fallback.ts`** - 内存缓存回退

#### 5.10 功能模块
- **`analytics/`** - 数据分析
  - `tracker.ts` - 事件追踪
  - `events.ts` - 事件定义
  - `hooks.ts` - 分析 Hooks
  - `funnel.ts` - 漏斗分析
  - `business-metrics.ts` - 业务指标

- **`security/`** - 安全工具
  - `input-validation.ts` - 输入验证

- **`compliance/`** - 合规功能（GDPR）
  - `gdpr.ts` - GDPR 合规
  - `consent.ts` - 用户同意
  - `data-export.ts` - 数据导出
  - `data-deletion.ts` - 数据删除

- **`premium/`** - Premium 功能
  - `index.ts` - Premium 功能检查
  - `hooks.tsx` - Premium Hooks

- **`feature-flags/`** - 功能开关
  - `index.ts` - 功能标志定义
  - `hooks.tsx` - 功能标志 Hooks

- **`stripe/`** - Stripe 支付集成
  - `index.ts` - Stripe 客户端

- **`alerts/`** - 提醒服务
  - `send-alert.ts` - 发送提醒

- **`services/`** - 业务服务
  - `trading-metrics.ts` - 交易指标计算
  - `risk-alert.ts` - 风险提醒服务
  - `push-notification.ts` - 推送通知服务

- **`admin/`** - 管理功能
  - `auth.ts` - 管理员认证

- **`config/`** - 配置管理
  - `env.ts` - 环境变量配置
  - `feature-flags.ts` - 功能标志配置

- **`monitoring/`** - 监控
  - `index.ts` - 监控工具

- **`seo/`** - SEO 优化
  - `metadata.ts` - 元数据生成
  - `structured-data.ts` - 结构化数据

- **`schemas/`** - Zod 验证模式
  - `index.ts` - Schema 定义

- **`ab-testing/`** - A/B 测试
  - `index.ts` - A/B 测试工具

- **`a11y/`** - 无障碍功能
  - `hooks.ts` - 无障碍 Hooks
  - `keyboard-nav.ts` - 键盘导航

- **`cron/`** - 定时任务工具
  - `utils.ts` - Cron 工具函数

- **`i18n.ts`** - 国际化配置
- **`logger.ts`** - 日志工具
- **`design-tokens.ts`** - 设计令牌
- **`theme-tokens.ts`** - 主题令牌

---

### 6. `/scripts` - 数据脚本

#### 6.1 数据导入脚本 (`import_*.mjs`)
- **`import_binance_futures.mjs`** - 导入 Binance 期货数据
- **`import_binance_spot.mjs`** - 导入 Binance 现货数据
- **`import_binance_web3.mjs`** - 导入 Binance Web3 数据
- **`import_binance_futures_api.mjs`** - 通过 API 导入 Binance 期货
- **`import_bybit.mjs`** - 导入 Bybit 数据
- **`import_bitget_futures.mjs`** - 导入 Bitget 期货数据
- **`import_bitget_futures_v2.mjs`** - 导入 Bitget 期货数据（v2）
- **`import_bitget_spot.mjs`** - 导入 Bitget 现货数据
- **`import_bitget_spot_v2.mjs`** - 导入 Bitget 现货数据（v2）
- **`import_mexc.mjs`** - 导入 MEXC 数据
- **`import_kucoin.mjs`** - 导入 KuCoin 数据
- **`import_coinex.mjs`** - 导入 CoinEx 数据
- **`import_okx_web3.mjs`** - 导入 OKX Web3 数据
- **`import_gmx.mjs`** - 导入 GMX 数据

#### 6.2 详情抓取脚本 (`fetch_*_details.mjs`)
- **`fetch_details_fast.mjs`** - 快速抓取交易员详情（主要脚本）
- **`fetch_binance_trader_details.mjs`** - 抓取 Binance 交易员详情
- **`fetch_binance_trader_details_fast.mjs`** - 快速抓取 Binance 详情
- **`fetch_binance_trader_details_balanced.mjs`** - 平衡模式抓取 Binance
- **`fetch_binance_web3_trader_details.mjs`** - 抓取 Binance Web3 详情
- **`fetch_all_binance_details.mjs`** - 抓取所有 Binance 详情
- **`fetch_bybit_trader_details.mjs`** - 抓取 Bybit 交易员详情
- **`fetch_bitget_trader_details.mjs`** - 抓取 Bitget 交易员详情
- **`fetch_mexc_trader_details.mjs`** - 抓取 MEXC 交易员详情
- **`fetch_mexc_avatars.mjs`** - 抓取 MEXC 头像
- **`fetch_kucoin_trader_details.mjs`** - 抓取 KuCoin 交易员详情
- **`fetch_okx_trader_details.mjs`** - 抓取 OKX 交易员详情
- **`fetch_position_history.mjs`** - 抓取持仓历史
- **`fetch_position_history_v2.mjs`** - 抓取持仓历史（v2）
- **`fetch_position_history_batch.mjs`** - 批量抓取持仓历史

#### 6.3 数据库设置脚本 (`setup_*.sql`)
- **`setup_all.sql`** - 一次性执行所有设置脚本
- **`setup_supabase_tables.sql`** - 基础 Supabase 表结构
- **`setup_community_tables.sql`** - 社区功能表
- **`setup_comment_system.sql`** - 评论系统表
- **`setup_bookmark_folders.sql`** - 收藏夹表
- **`setup_bookmark_repost.sql`** - 收藏转发表
- **`setup_repost_as_post.sql`** - 转发作为帖子
- **`setup_trader_follows.sql`** - 交易员关注表
- **`setup_trader_alerts.sql`** - 交易员提醒表
- **`setup_trader_claims.sql`** - 交易员认领表
- **`setup_user_messaging.sql`** - 用户消息表
- **`setup_user_exchange_tables.sql`** - 用户交易所表
- **`setup_group_management.sql`** - 小组管理表
- **`setup_group_applications.sql`** - 小组申请表
- **`setup_premium_groups.sql`** - Premium 小组表
- **`setup_pro_member_groups.sql`** - Pro 成员小组表
- **`setup_stripe_tables.sql`** - Stripe 支付表
- **`setup_subscriptions.sql`** - 订阅表
- **`setup_arena_score.sql`** - Arena Score 评分表
- **`setup_avatar_storage.sql`** - 头像存储
- **`setup_cover_storage.sql`** - 封面存储
- **`setup_avoid_list.sql`** - 屏蔽列表表
- **`setup_saved_filters.sql`** - 保存的筛选器表
- **`setup_translation_cache.sql`** - 翻译缓存表
- **`setup_folder_subscriptions.sql`** - 收藏夹订阅表
- **`setup_tips.sql`** - 打赏表
- **`setup_pro_badge.sql`** - Pro 徽章表
- **`setup_invites.sql`** - 邀请表

#### 6.4 数据库迁移脚本 (`add_*.sql`, `create_*.sql`, `migrate_*.sql`)
- **`add_group_rules.sql`** - 添加小组规则
- **`add_multi_period_roi.sql`** - 添加多周期 ROI
- **`add_premium_only_to_applications.sql`** - 添加 Premium 专属申请
- **`add_season_id_constraint.sql`** - 添加赛季 ID 约束
- **`create_oauth_states_table.sql`** - 创建 OAuth 状态表
- **`create_polls_table.sql`** - 创建投票表
- **`create_trader_detail_tables.sql`** - 创建交易员详情表
- **`migrate_source_names.sql`** - 迁移来源名称

#### 6.5 数据维护脚本
- **`calculate_arena_scores.mjs`** - 计算 Arena Score
- **`cleanup_data.mjs`** - 数据清理
- **`cleanup_old_snapshots.mjs`** - 清理旧快照
- **`check_data.mjs`** - 数据检查
- **`validate_data.mjs`** - 数据验证
- **`optimize_indexes.sql`** - 优化数据库索引

#### 6.6 测试与工具脚本
- **`test_all_scrapers.mjs`** - 测试所有爬虫
- **`test_binance_scrape.mjs`** - 测试 Binance 抓取
- **`parallel_scrape.mjs`** - 并行抓取
- **`run_migration.mjs`** - 运行迁移
- **`test-mcp.mjs`** - 测试 MCP
- **`setup-mcp-env.sh`** - 设置 MCP 环境
- **`deploy-vercel.sh`** - Vercel 部署脚本

#### 6.7 工具库 (`/lib`)
- **`data-validation.mjs`** - 数据验证工具
- **`stealth-browser.mjs`** - 隐身浏览器配置（反爬虫）

---

### 7. `/worker` - 独立爬虫服务

独立部署的爬虫服务，可运行在 Railway 等平台。

#### 7.1 核心文件
- **`src/index.ts`** - 服务入口
- **`src/cli.ts`** - CLI 命令行工具
- **`src/db.ts`** - 数据库连接
- **`src/logger.ts`** - 日志工具
- **`src/types.ts`** - 类型定义

#### 7.2 爬虫实现 (`/scrapers`)
- **`base.ts`** - 爬虫基类
- **`binance-futures.ts`** - Binance 期货爬虫
- **`binance-spot.ts`** - Binance 现货爬虫
- **`bitget-futures.ts`** - Bitget 期货爬虫
- **`bitget-spot.ts`** - Bitget 现货爬虫
- **`bybit.ts`** - Bybit 爬虫
- **`index.ts`** - 爬虫导出

#### 7.3 配置文件
- **`package.json`** - Worker 依赖
- **`Dockerfile`** - Docker 配置
- **`railway.json`** - Railway 部署配置
- **`tsconfig.json`** - TypeScript 配置
- **`README.md`** - Worker 文档

---

### 8. `/supabase` - 数据库迁移

- **`migrations/`** - Supabase 数据库迁移文件
  - 按时间顺序的 SQL 迁移文件
  - 用于版本控制和数据库结构管理

- **`config.toml`** - Supabase 配置文件
- **`README.md`** - 迁移文档

---

### 9. `/e2e` - E2E 测试

使用 Playwright 编写的端到端测试。

- **`home.spec.ts`** - 首页测试
- **`auth.spec.ts`** - 认证测试
- **`posts.spec.ts`** - 帖子功能测试
- **`groups.spec.ts`** - 小组功能测试
- **`search.spec.ts`** - 搜索功能测试
- **`trader-detail.spec.ts`** - 交易员详情测试
- **`api.spec.ts`** - API 测试

---

### 10. `/stories` - Storybook 组件文档

组件文档和可视化测试。

- **`Introduction.mdx`** - Storybook 介绍
- **`Base/`** - 基础组件故事
  - `Button.stories.tsx`
  - `Text.stories.tsx`
  - `Box.stories.tsx`
- **`Charts/`** - 图表组件故事
  - `EquityCurve.stories.tsx`
  - `PnLChart.stories.tsx`
- **`UI/`** - UI 组件故事
  - `Card.stories.tsx`

---

### 11. `/docs` - 项目文档

- **`README.md`** - 项目主文档（已存在）
- **`ARCHITECTURE.md`** - 系统架构文档
- **`ARENA_SCORE_METHODOLOGY.md`** - Arena Score 算法详解
- **`SUPABASE_SETUP.md`** - Supabase 配置指南
- **`PERFORMANCE_OPTIMIZATION.md`** - 性能优化文档
- **`OPTIMIZATION_SUMMARY.md`** - 优化措施汇总
- **`MCP_SETUP.md`** - MCP 设置文档
- **`MCP_ENV_SETUP.md`** - MCP 环境设置
- **`QUICK_SETUP_MCP.md`** - MCP 快速设置
- **`VERCEL_DEPLOY.md`** - Vercel 部署指南
- **`ACCOUNT_REQUIRED_FIELDS.md`** - 账户必需字段文档
- **`BUTTON_TEST_CHECKLIST.md`** - 按钮测试清单

---

### 12. `/public` - 静态资源

- **`icons/icon.svg`** - 应用图标
- **`manifest.json`** - PWA 清单文件
- **`index.html`** - HTML 模板（Capacitor）
- **`sw.js`** - Service Worker 脚本
- **`openapi.json`** - OpenAPI 规范文件

---

### 13. `/resources` - 资源文件

- **`icon.svg`** - 应用图标源文件
- **`splash.svg`** - 启动画面

---

## 功能模块总结

### 核心功能
1. **多交易所排行榜** - 聚合 10+ 交易所数据
2. **Arena Score 评分系统** - 综合评估交易员
3. **交易员详情页** - 完整的绩效和统计信息
4. **实时数据更新** - 定时任务自动抓取和更新

### 社区功能
1. **帖子系统** - 发帖、评论、点赞、转发、投票
2. **小组讨论** - 创建小组、申请加入、管理权限
3. **关注系统** - 关注交易员和用户
4. **收藏系统** - 收藏夹管理和订阅
5. **消息系统** - 私信和通知
6. **翻译功能** - 中英文自动翻译

### 高级功能
1. **交易所账户绑定** - 绑定 API Key 解锁更多数据
2. **交易员认领** - 交易员可认领自己的账户
3. **风险提醒** - 监控关注交易员的异常变动
4. **投资组合建议** - 基于风险偏好的组合推荐
5. **Premium 订阅** - Stripe 支付集成
6. **管理后台** - 用户管理、举报处理、数据监控

### 技术特性
1. **性能优化** - 缓存策略、虚拟滚动、图片优化
2. **安全防护** - XSS、CSRF、限流、加密存储
3. **SEO 优化** - 元数据、结构化数据、sitemap
4. **移动端支持** - PWA、响应式设计、Capacitor
5. **错误监控** - Sentry 集成
6. **测试覆盖** - 单元测试、E2E 测试

---

## 数据流

### 交易员数据同步
1. **定时任务** (Vercel Cron) → 触发抓取
2. **爬虫脚本** → 抓取各交易所数据
3. **数据清洗** → 标准化格式
4. **数据库存储** → 存入 Supabase
5. **Arena Score 计算** → 计算评分
6. **缓存更新** → 更新 Redis 缓存

### 用户请求流程
1. **客户端请求** → Next.js API 路由
2. **中间件处理** → 认证、限流、验证
3. **数据层查询** → Supabase + Redis
4. **响应返回** → 统一格式响应

### 实时更新
- **Supabase Realtime** → WebSocket 推送
- 帖子、评论、通知实时更新

---

## 部署架构

- **前端部署** - Vercel (边缘部署)
- **数据库** - Supabase (托管 PostgreSQL)
- **缓存** - Upstash Redis
- **爬虫服务** - Railway (独立部署)
- **监控** - Sentry
- **CI/CD** - GitHub Actions

---

## 开发流程

1. **本地开发** - `npm run dev`
2. **代码检查** - `npm run lint`
3. **类型检查** - `npm run type-check`
4. **单元测试** - `npm test`
5. **构建验证** - `npm run build`
6. **E2E 测试** - `npm run test:e2e`
7. **提交代码** → GitHub
8. **CI 验证** → 自动运行测试
9. **部署** → Vercel 自动部署

---

本文档提供了项目结构的完整概览。每个目录和文件都有明确的职责，便于团队协作和代码维护。
