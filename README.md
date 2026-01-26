# Ranking Arena

加密货币交易员排行榜与社区平台。聚合 20+ CEX/DEX 交易所和 DeFi 协议的跟单数据，提供透明的交易员排名和社区讨论功能。

## 最近更新

### v2.1 - 2026年1月26日

**平台类型定义更新:**
- 新增 `okx_futures` 平台类型到 GRANULAR_PLATFORMS
- 新增 `okx_web3` 平台类型到 GRANULAR_PLATFORMS
- 为新平台添加 PLATFORM_CATEGORY 分类映射
- 为新平台添加 PLATFORM_RATE_LIMITS 速率限制配置

**Cron 定时任务配置:**
- 新增 OKX Futures 定时抓取任务 (每4小时执行)
- 新增 Weex 定时抓取任务 (每4小时执行，错开5分钟)
- 更新 lib/cron/utils.ts 中的 PLATFORM_SCRIPTS 配置
- 支持 7D/30D/90D 三个时间周期的数据抓取

**数据抓取脚本:**
- 新增 scripts/import/import_okx_futures.mjs - OKX 期货跟单排行榜抓取
- 新增 scripts/import/import_hyperliquid.mjs - Hyperliquid DEX 排行榜抓取
- 新增 scripts/import/import_dydx.mjs - dYdX DEX 排行榜抓取
- OKX Futures API 集成：使用公开 API 获取交易员数据
- Arena Score 计算：基于 ROI、回撤、胜率的综合评分

### v2.0 - 2026年1月

**新增交易所支持:**
- HTX (火币) - 期货跟单排行榜，支持 7D/30D/90D 周期
- Weex - 期货跟单排行榜，支持 7D/30D/90D 周期
- Hyperliquid - L1 永续 DEX 排行榜（需要 Puppeteer 抓取）
- dYdX - 永续 DEX 排行榜（需要 Puppeteer 抓取）
- Uniswap - 现货交易排行榜 (通过 Dune Analytics)

**DeFi 数据集成:**
- Dune Analytics 连接器 - 链上数据聚合
- GMX / Hyperliquid / Uniswap 链上排行榜
- Nansen 钱包分析集成

**架构升级:**
- 统一连接器架构 (`connectors/`) - 标准化数据源接入
- Cloudflare Worker 代理 - 绕过交易所 IP 限制
- 原子计数器函数 - 防止并发竞争条件
- Rankings API 优化 - 更好的筛选和排序

**移动端改进:**
- PullToRefresh 下拉刷新组件
- 推送通知 API
- 响应式 CSS 优化

## 目录

- [功能特性](#功能特性)
- [支持的交易所和协议](#支持的交易所和协议)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [数据库设置](#数据库设置)
- [开发指南](#开发指南)
- [测试](#测试)
- [数据抓取系统](#数据抓取系统)
- [Cron 定时任务](#cron-定时任务)
- [部署](#部署)
- [API 文档](#api-文档)
- [性能优化](#性能优化)
- [安全特性](#安全特性)
- [移动端支持](#移动端支持)
- [许可证](#许可证)

## 功能特性

### 核心功能

- **多交易所排行榜** - 聚合主流交易所 Copy Trading 数据
- **Arena Score 评分系统** - 综合评估交易员的收益能力和风险控制
  - 收益分 (85%): 基于年化收益强度，使用 tanh 函数平滑处理极端值
  - 回撤分 (8%): 基于最大回撤风险，根据时间周期调整阈值
  - 稳定分 (7%): 基于胜率稳定性，45%-70% 区间映射
- **多时间维度** - 支持 7天/30天/90天 ROI 对比
- **交易员详情** - 绩效统计、历史记录、持仓分布、权益曲线

### 社区功能

- **帖子系统** - 发帖、评论、点赞、投票
- **小组讨论** - 创建和管理讨论小组
- **收藏夹** - 收藏交易员和帖子
- **关注系统** - 关注交易员和用户
- **消息系统** - 私信和通知
- **翻译功能** - 中英文自动翻译

### 高级功能

- **交易所账户绑定** - 绑定交易所账户解锁更多数据
- **交易员认领** - 交易员可认领自己的账户
- **风险提醒** - 监控关注交易员的异常变动
- **组合建议** - 基于风险偏好的交易员组合推荐
- **Premium 订阅** - 解锁高级功能
- **Cloudflare Worker 代理** - 绕过交易所 IP 限制
- **移动端推送通知** - 实时接收交易员动态

## 支持的交易所和协议

### CEX 期货交易所

| 交易所 | 平台标识 | 数据来源 | 抓取频率 | 支持周期 |
|--------|----------|----------|----------|----------|
| Binance | binance_futures | 公开 API | 每4小时 | 7D/30D/90D |
| Bybit | bybit | 公开 API | 每4小时 | 7D/30D/90D |
| Bitget | bitget_futures | 公开 API | 每4小时 | 7D/30D/90D |
| OKX | okx_futures | 公开 API | 每4小时 | 7D/30D/90D |
| MEXC | mexc | 公开 API | 每4小时 | 7D/30D/90D |
| HTX (火币) | htx_futures | 公开 API | 每4小时 | 7D/30D/90D |
| KuCoin | kucoin | 公开 API | 每4小时 | 7D/30D/90D |
| CoinEx | coinex | 公开 API | 每4小时 | 7D/30D/90D |
| Weex | weex | 公开 API | 每4小时 | 7D/30D/90D |
| BitMart | bitmart | 公开 API | 每4小时 | 7D/30D/90D |
| Phemex | phemex | 公开 API | 每4小时 | 7D/30D/90D |

### CEX 现货交易所

| 交易所 | 平台标识 | 数据来源 | 抓取频率 | 支持周期 |
|--------|----------|----------|----------|----------|
| Binance | binance_spot | 公开 API | 每4小时 | 7D/30D/90D |
| Bitget | bitget_spot | 公开 API | 每4小时 | 7D/30D/90D |

### DeFi / 链上协议

| 协议 | 平台标识 | 数据来源 | 抓取频率 | 说明 |
|------|----------|----------|----------|------|
| GMX | gmx | Arbitrum 链上 | 每4小时 | Arbitrum 永续合约协议 |
| Hyperliquid | hyperliquid | L1 API | 每4小时 | L1 永续 DEX，需要 Puppeteer |
| dYdX | dydx | dYdX API | 每4小时 | 永续 DEX，v4 版本 |
| Uniswap | dune_uniswap | Dune Analytics | 每6小时 | 现货 DEX 交易排行 |

### Web3 钱包

| 平台 | 平台标识 | 数据来源 | 抓取频率 | 说明 |
|------|----------|----------|----------|------|
| Binance Web3 | binance_web3 | Binance API | 每4小时 | Binance Web3 钱包排行 |
| OKX Web3 | okx_web3 | OKX API | 每4小时 | OKX Web3 钱包排行 |

### 链上数据源

| 数据源 | 平台标识 | 说明 |
|--------|----------|------|
| Dune Analytics GMX | dune_gmx | GMX 链上交易排行榜 |
| Dune Analytics Hyperliquid | dune_hyperliquid | Hyperliquid 链上交易排行榜 |
| Dune Analytics Uniswap | dune_uniswap | Uniswap 交易排行榜 |
| Dune Analytics DeFi | dune_defi | 综合 DeFi 排行榜 |
| Nansen | nansen | 钱包分析和 Smart Money 追踪 |

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 前端框架 | Next.js | 16 | App Router, Server Components, Turbopack |
| UI 库 | React | 19 | 最新的 React 特性，包括 Suspense 和 Server Components |
| 类型系统 | TypeScript | 5 | 严格类型检查，禁止 any 类型 |
| 样式 | Tailwind CSS | 4 | 原子化 CSS，响应式设计 |
| 状态管理 | Zustand | 5 | 轻量级状态管理，支持持久化 |
| 数据获取 | SWR | 最新版 | 数据缓存、重新验证、乐观更新 |
| 表单验证 | Zod | 最新版 | Schema 验证，类型推断 |
| 图表 | Lightweight Charts | 最新版 | 轻量级金融图表，权益曲线展示 |
| 数据库 | Supabase (PostgreSQL) | - | 托管数据库 + Auth + Realtime + RLS |
| 缓存 | Upstash Redis | - | 分布式缓存 + 限流 + 会话存储 |
| 支付 | Stripe | - | 订阅支付和打赏功能 |
| 部署 | Vercel | - | 边缘部署 + Serverless + Cron Jobs |
| 监控 | Sentry | - | 错误追踪 + 性能监控 + 会话回放 |
| 爬虫 | Puppeteer | - | 无头浏览器数据抓取，支持 Stealth 模式 |
| 代理 | Cloudflare Worker | - | 绕过交易所 IP 限制 |

## 系统架构

```
                         客户端 (Browser / Mobile / Capacitor App)
                                           |
                                           v
                              Cloudflare CDN / Edge Cache
                                           |
                                           v
                              Next.js Middleware Layer
                     (认证验证 / CORS / CSP / CSRF / IP 限流)
                                           |
                                           v
                                     API 路由层
                       (withApiMiddleware 统一包装 / 版本控制)
                                           |
               +---------------+-----------+-----------+---------------+
               |               |           |           |               |
               v               v           v           v               v
          Supabase        Upstash      外部API      Stripe      Cloudflare
        (PostgreSQL)      (Redis)     (交易所)      (支付)       Worker
               |               |           |                      (代理)
               v               v           |
          Realtime         Rate          |
          WebSocket       Limiter        |
                                         v
                              +-------------------+
                              | 交易所 API 列表    |
                              +-------------------+
                              | Binance API       |
                              | Bybit API         |
                              | Bitget API        |
                              | OKX API           |
                              | MEXC API          |
                              | HTX API           |
                              | KuCoin API        |
                              | CoinEx API        |
                              | Weex API          |
                              | GMX (Arbitrum)    |
                              | Hyperliquid API   |
                              | dYdX API          |
                              | Dune Analytics    |
                              +-------------------+
```

### 数据流

1. **交易员数据同步流程**:
   - Vercel Cron 每4小时触发定时任务
   - 调用 `/api/cron/fetch-traders/[platform]` 端点
   - 执行对应的抓取脚本 (scripts/import/import_*.mjs)
   - 清洗和标准化数据，计算 Arena Score
   - 存入 trader_snapshots 和 trader_sources 表

2. **用户请求流程**:
   - 请求到达 -> Middleware (认证/限流/CSRF)
   - API Handler 处理 -> 数据层 (Supabase + Redis 缓存)
   - 响应返回 -> CDN 缓存

3. **实时更新**:
   - Supabase Realtime WebSocket 推送
   - 帖子、评论、通知的实时更新

## 项目结构

```
ranking-arena/
├── app/                              # Next.js App Router
│   ├── api/                          # API 路由 (120+ endpoints)
│   │   ├── traders/                  # 交易员相关 API
│   │   │   ├── route.ts              # 交易员列表
│   │   │   └── [handle]/             # 交易员详情
│   │   │       ├── route.ts          # 基本信息
│   │   │       ├── positions/        # 持仓信息
│   │   │       └── equity/           # 权益曲线
│   │   ├── posts/                    # 帖子相关 API
│   │   ├── groups/                   # 小组相关 API
│   │   ├── rankings/                 # 排行榜 API
│   │   │   └── route.ts              # 统一排行榜接口
│   │   ├── exchange/                 # 交易所绑定 API
│   │   ├── scrape/                   # 数据抓取 API
│   │   │   └── proxy/                # Cloudflare Worker 代理
│   │   ├── push/                     # 推送通知 API
│   │   ├── cron/                     # 定时任务 API
│   │   │   ├── fetch-traders/        # 交易员数据抓取
│   │   │   │   └── [platform]/       # 按平台分类
│   │   │   │       └── route.ts      # 动态路由处理
│   │   │   ├── fetch-details/        # 交易员详情抓取
│   │   │   ├── discover-rankings/    # 发现新排行榜
│   │   │   ├── check-data-freshness/ # 数据新鲜度检查
│   │   │   └── refresh-hot-scores/   # 热度评分刷新
│   │   ├── admin/                    # 管理后台 API
│   │   └── stripe/                   # 支付相关 API
│   │
│   ├── components/                   # React 组件
│   │   ├── Base/                     # 基础组件 (Button, Text, Box)
│   │   ├── UI/                       # UI 组件 (Card, Modal, Toast, Skeleton)
│   │   ├── Trader/                   # 交易员相关组件
│   │   ├── Features/                 # 功能组件 (RankingTable, EnhancedSearch)
│   │   ├── Charts/                   # 图表组件 (EquityChart, PnLChart)
│   │   ├── Home/                     # 首页组件 (StatsBar, FeedPage)
│   │   ├── Providers/                # Context Providers (Language, Theme)
│   │   └── Layout/                   # 布局组件 (TopNav, MobileBottomNav)
│   │
│   ├── trader/[handle]/              # 交易员详情页
│   ├── rankings/                     # 排行榜页面
│   │   └── page.tsx                  # Rankings V2 页面
│   ├── groups/                       # 小组功能
│   ├── compare/                      # 交易员对比
│   ├── hot/                          # 热门交易员
│   ├── search/                       # 搜索页面
│   ├── u/[handle]/                   # 用户主页
│   ├── admin/                        # 管理后台
│   └── [其他路由]/
│
├── connectors/                       # 数据连接器 (统一接口)
│   ├── base/                         # 基础连接器接口和类型定义
│   │   ├── types.ts                  # 通用类型定义
│   │   └── connector.ts              # 基础连接器类
│   ├── binance/                      # Binance 连接器
│   │   ├── futures.ts                # 期货数据
│   │   ├── spot.ts                   # 现货数据
│   │   └── web3.ts                   # Web3 钱包数据
│   ├── bybit/                        # Bybit 连接器
│   ├── bitget/                       # Bitget 连接器
│   ├── okx/                          # OKX 连接器
│   │   ├── futures.ts                # 期货数据
│   │   └── web3.ts                   # Web3 钱包数据
│   ├── mexc/                         # MEXC 连接器
│   ├── htx/                          # HTX (火币) 连接器
│   ├── kucoin/                       # KuCoin 连接器
│   ├── coinex/                       # CoinEx 连接器
│   ├── weex/                         # Weex 连接器
│   ├── gmx/                          # GMX 连接器 (Arbitrum)
│   ├── hyperliquid/                  # Hyperliquid 连接器
│   ├── dydx/                         # dYdX 连接器
│   ├── dune/                         # Dune Analytics 连接器
│   │   ├── base.ts                   # 基础 Dune 查询
│   │   ├── gmx.ts                    # GMX 链上排行榜
│   │   ├── hyperliquid.ts            # Hyperliquid 链上排行榜
│   │   ├── uniswap.ts                # Uniswap 交易排行榜
│   │   └── defi.ts                   # 综合 DeFi 排行榜
│   └── nansen/                       # Nansen 钱包分析
│
├── cloudflare-worker/                # Cloudflare Worker 代理服务
│   ├── src/                          # Worker 源码
│   │   └── index.ts                  # 主入口
│   ├── wrangler.toml                 # Wrangler 配置
│   └── package.json                  # 依赖配置
│
├── lib/                              # 共享库
│   ├── api/                          # API 工具
│   │   ├── middleware.ts             # API 中间件 (认证/限流/CSRF)
│   │   ├── versioning.ts             # API 版本控制
│   │   └── response.ts               # 响应格式化
│   ├── cron/                         # Cron 任务工具
│   │   └── utils.ts                  # PLATFORM_SCRIPTS 配置
│   ├── data/                         # 数据获取层
│   ├── exchange/                     # 交易所 API 封装
│   ├── hooks/                        # React Hooks
│   │   ├── useRankingsV2.ts          # 排行榜数据 Hook
│   │   └── useTrader.ts              # 交易员数据 Hook
│   ├── stores/                       # Zustand Stores
│   ├── supabase/                     # Supabase 客户端
│   │   ├── client.ts                 # 浏览器客户端
│   │   └── server.ts                 # 服务端客户端
│   ├── utils/                        # 工具函数
│   │   ├── arena-score.ts            # Arena Score 计算
│   │   ├── circuit-breaker.ts        # 熔断器实现
│   │   ├── rate-limit.ts             # 限流工具
│   │   └── logger.ts                 # 日志工具
│   ├── types/                        # TypeScript 类型
│   │   ├── leaderboard.ts            # 排行榜相关类型
│   │   │   ├── GRANULAR_PLATFORMS    # 平台标识列表
│   │   │   ├── PLATFORM_CATEGORY     # 平台分类映射
│   │   │   └── PLATFORM_RATE_LIMITS  # 平台速率限制
│   │   └── trading-platform.ts       # 交易平台类型
│   ├── analytics/                    # 埋点分析
│   ├── cache/                        # 缓存策略
│   ├── compliance/                   # 合规 (GDPR)
│   ├── security/                     # 安全工具
│   └── design-tokens.ts              # 设计系统 Tokens
│
├── scripts/                          # 数据脚本
│   ├── import/                       # 数据导入脚本
│   │   ├── import_binance_futures_api.mjs    # Binance 期货
│   │   ├── import_binance_spot.mjs           # Binance 现货
│   │   ├── import_binance_web3.mjs           # Binance Web3
│   │   ├── import_bybit.mjs                  # Bybit
│   │   ├── import_bitget_futures_v2.mjs      # Bitget 期货
│   │   ├── import_bitget_spot_v2.mjs         # Bitget 现货
│   │   ├── import_mexc.mjs                   # MEXC
│   │   ├── import_okx_futures.mjs            # OKX 期货
│   │   ├── import_okx_web3.mjs               # OKX Web3
│   │   ├── import_htx.mjs                    # HTX (火币)
│   │   ├── import_kucoin.mjs                 # KuCoin
│   │   ├── import_coinex.mjs                 # CoinEx
│   │   ├── import_weex.mjs                   # Weex
│   │   ├── import_gmx.mjs                    # GMX
│   │   ├── import_hyperliquid.mjs            # Hyperliquid
│   │   ├── import_dydx.mjs                   # dYdX
│   │   └── import_dune.mjs                   # Dune Analytics
│   ├── fetch_*_details.mjs           # 详情抓取脚本
│   └── setup_*.sql                   # 数据库设置脚本
│
├── worker/                           # 独立爬虫服务
│   └── src/scrapers/                 # 各交易所爬虫
│
├── supabase/                         # 数据库迁移
│   └── migrations/                   # SQL 迁移文件
│       ├── 00001_initial_schema.sql
│       ├── 00002_binance_trader_details.sql
│       └── ...                       # 更多迁移文件
│
├── e2e/                              # E2E 测试 (Playwright)
├── stories/                          # Storybook 组件文档
├── android/                          # Android 原生项目 (Capacitor)
├── ios/                              # iOS 原生项目 (Capacitor)
├── public/                           # 静态资源
├── docs/                             # 项目文档
├── vercel.json                       # Vercel 配置 (Cron Jobs)
├── capacitor.config.json             # Capacitor 配置
└── package.json                      # 项目依赖
```

## 快速开始

### 环境要求

- Node.js >= 20
- npm >= 10
- PostgreSQL (通过 Supabase 托管)

### 安装步骤

```bash
# 克隆项目
git clone https://github.com/your-username/ranking-arena.git
cd ranking-arena

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入必要配置

# 设置数据库
# 在 Supabase SQL Editor 执行 scripts/setup_all.sql

# 启动开发服务器
npm run dev
```

访问 http://localhost:3000

## 环境变量配置

创建 `.env.local` 文件并配置以下变量:

```bash
# Supabase (必需)
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Upstash Redis 缓存 (推荐，不配置则使用内存缓存)
UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token

# Stripe 支付 (可选，订阅功能需要)
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=your-stripe-publishable-key

# Sentry 错误监控 (可选)
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn
SENTRY_ORG=your-sentry-org
SENTRY_PROJECT=your-sentry-project
SENTRY_AUTH_TOKEN=your-sentry-auth-token

# Dune Analytics (可选，链上数据需要)
DUNE_API_KEY=your-dune-api-key

# 其他配置
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=your-cron-secret
```

## 数据库设置

### 初始化数据库

在 Supabase SQL Editor 中按顺序执行以下脚本:

```bash
# 基础表结构
scripts/setup_supabase_tables.sql
scripts/setup_community_tables.sql
scripts/setup_comment_system.sql

# 功能表
scripts/setup_bookmark_folders.sql
scripts/setup_trader_follows.sql
scripts/setup_trader_alerts.sql
scripts/setup_user_messaging.sql

# 高级功能
scripts/setup_stripe_tables.sql
scripts/setup_arena_score.sql
scripts/setup_premium_groups.sql

# 或者一次性执行
scripts/setup_all.sql
```

### 核心数据表

| 表名 | 说明 | 主要字段 |
|------|------|----------|
| trader_sources | 交易员来源信息 | source, source_trader_id, handle, profile_url |
| trader_snapshots | 交易员快照数据 | source, source_trader_id, season_id, roi, pnl, arena_score |
| trader_profiles | 交易员详情 | platform, trader_key, display_name, avatar_url |
| posts | 帖子 | content, author_id, like_count, comment_count |
| comments | 评论 | content, author_id, post_id, parent_id |
| groups | 小组 | name, description, member_count |
| user_follows | 用户关注 | follower_id, following_id |
| trader_follows | 交易员关注 | user_id, platform, trader_key |

### 数据库迁移

项目使用 Supabase Migrations 管理数据库版本:

```bash
# 查看迁移文件
ls supabase/migrations/

# 主要迁移文件
00001_initial_schema.sql
00002_binance_trader_details.sql
00003_add_season_id_constraint.sql
00004_performance_optimizations.sql
...
00021_atomic_counter_functions.sql
```

## 开发指南

### 常用命令

```bash
# 开发
npm run dev              # 启动开发服务器 (Turbopack)
npm run build            # 构建生产版本
npm run start            # 启动生产服务器

# 代码质量
npm run lint             # ESLint 检查
npm run lint:fix         # ESLint 自动修复
npm run format           # Prettier 格式化
npm run type-check       # TypeScript 类型检查

# 测试
npm run test             # 运行单元测试 (Jest)
npm run test:watch       # 监听模式测试
npm run test:coverage    # 测试覆盖率
npm run test:e2e         # 运行 E2E 测试 (Playwright)

# 组件文档
npm run storybook        # 启动 Storybook
npm run build-storybook  # 构建 Storybook

# 分析
npm run analyze          # 包大小分析
```

### 代码规范

- 使用 TypeScript 严格模式，禁止 any 类型
- 遵循 ESLint + Prettier 规则
- 组件使用函数式组件 + Hooks
- API 使用 `withApiMiddleware` 包装器
- 数据获取使用 SWR 或 Server Components
- 使用 `lib/design-tokens.ts` 中的设计 Tokens

### 添加新数据源

1. 在 `lib/types/leaderboard.ts` 中添加平台标识:

```typescript
// GRANULAR_PLATFORMS 数组中添加
export const GRANULAR_PLATFORMS = [
  // ... 现有平台
  'new_platform',
] as const

// PLATFORM_CATEGORY 中添加分类
export const PLATFORM_CATEGORY: Record<GranularPlatform, TradingCategory> = {
  // ... 现有映射
  new_platform: 'futures', // 或 'spot' / 'onchain'
}

// PLATFORM_RATE_LIMITS 中添加速率限制
export const PLATFORM_RATE_LIMITS: Record<GranularPlatform, RateLimiterConfig> = {
  // ... 现有配置
  new_platform: {
    max_requests: 20,
    window_ms: 60_000,
    min_delay_ms: 2500,
    max_delay_ms: 5000,
    max_concurrent: 2
  },
}
```

2. 创建导入脚本 `scripts/import/import_new_platform.mjs`

3. 在 `lib/cron/utils.ts` 的 PLATFORM_SCRIPTS 中添加配置:

```typescript
export const PLATFORM_SCRIPTS = {
  // ... 现有配置
  new_platform: [
    { name: 'new_platform_7d', script: 'scripts/import/import_new_platform.mjs', args: ['7D'] },
    { name: 'new_platform_30d', script: 'scripts/import/import_new_platform.mjs', args: ['30D'] },
    { name: 'new_platform_90d', script: 'scripts/import/import_new_platform.mjs', args: ['90D'] },
  ],
}
```

4. 在 `vercel.json` 中添加 Cron 任务:

```json
{
  "path": "/api/cron/fetch-traders/new_platform",
  "schedule": "0 */4 * * *"
}
```

## 测试

### 单元测试 (Jest)

```bash
npm run test                    # 运行所有测试
npm run test -- --watch         # 监听模式
npm run test -- path/to/file    # 运行特定文件
```

测试文件命名: `*.test.ts` 或 `*.test.tsx`

### E2E 测试 (Playwright)

```bash
npm run test:e2e            # 运行所有 E2E 测试
npm run test:e2e:ui         # UI 模式运行
npm run test:e2e:report     # 查看测试报告
```

E2E 测试覆盖:
- 首页加载
- 认证流程
- 帖子功能
- 小组功能
- 搜索功能
- 交易员详情
- 排行榜筛选

## 数据抓取系统

### 抓取脚本说明

每个导入脚本都遵循统一的结构:

```javascript
// scripts/import/import_xxx.mjs

// 1. 环境配置
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// 2. 常量定义
const SOURCE = 'xxx'        // 平台标识
const TARGET_COUNT = 100    // 目标抓取数量

// 3. Arena Score 计算
function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  // 根据周期调整参数
  // 计算收益分、回撤分、稳定分
  // 返回综合得分
}

// 4. 数据抓取
async function fetchLeaderboardData(period) {
  // 调用交易所 API
  // 解析返回数据
  // 标准化字段
}

// 5. 数据保存
async function saveTraders(traders, period) {
  // 保存到 trader_sources
  // 保存到 trader_snapshots
}

// 6. 主函数
async function main() {
  for (const period of ['7D', '30D', '90D']) {
    const traders = await fetchLeaderboardData(period)
    await saveTraders(traders, period)
  }
}
```

### Arena Score 计算算法

```javascript
// 参数配置 (按周期调整)
const PARAMS = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}

// 计算公式
收益分 = 85 * tanh(coeff * intensity)^exponent
回撤分 = 8 * (1 - |maxDrawdown| / threshold)
稳定分 = 7 * (winRate - 45) / (cap - 45)

Arena Score = 收益分 + 回撤分 + 稳定分
```

### 手动抓取

```bash
# CEX 交易所
node scripts/import/import_binance_futures_api.mjs 90D
node scripts/import/import_bybit.mjs 90D
node scripts/import/import_okx_futures.mjs ALL
node scripts/import/import_htx.mjs 90D
node scripts/import/import_weex.mjs 90D

# DeFi / 链上
node scripts/import/import_gmx.mjs 30D
node scripts/import/import_hyperliquid.mjs 90D
node scripts/import/import_dydx.mjs 90D
```

### Worker 服务

独立的爬虫服务，可部署到 Railway 或其他平台:

```bash
cd worker
npm install
npm run dev                     # 开发模式
npm run scrape:all             # 抓取所有交易所
npm run scrape:binance         # 只抓取 Binance
```

### Cloudflare Worker 代理

用于绕过交易所 IP 限制的代理服务:

```bash
cd cloudflare-worker
npm install
npx wrangler dev               # 本地开发
npx wrangler deploy            # 部署到 Cloudflare
```

## Cron 定时任务

### 任务配置 (vercel.json)

| 任务路径 | 调度规则 | 说明 |
|----------|----------|------|
| /api/cron/fetch-traders/binance_futures | 0 */4 * * * | Binance 期货，每4小时 |
| /api/cron/fetch-traders/bybit | 5 */4 * * * | Bybit，每4小时 |
| /api/cron/fetch-traders/bitget_futures | 10 */4 * * * | Bitget 期货，每4小时 |
| /api/cron/fetch-traders/okx_futures | 0 */4 * * * | OKX 期货，每4小时 |
| /api/cron/fetch-traders/mexc | 30 */4 * * * | MEXC，每4小时 |
| /api/cron/fetch-traders/htx | 55 */4 * * * | HTX，每4小时 |
| /api/cron/fetch-traders/weex | 5 */4 * * * | Weex，每4小时 |
| /api/cron/fetch-traders/kucoin | 45 */4 * * * | KuCoin，每4小时 |
| /api/cron/fetch-traders/coinex | 35 */4 * * * | CoinEx，每4小时 |
| /api/cron/fetch-traders/gmx | 50 */4 * * * | GMX，每4小时 |
| /api/cron/fetch-details | 30 */2 * * * | 交易员详情，每2小时 |
| /api/cron/discover-rankings | 0 */4 * * * | 发现新排行榜，每4小时 |
| /api/cron/check-data-freshness | 0 */3 * * * | 数据新鲜度检查，每3小时 |
| /api/cron/refresh-hot-scores | */5 * * * * | 热度评分刷新，每5分钟 |
| /api/cron/run-jobs | */2 * * * * | 任务队列处理，每2分钟 |

### PLATFORM_SCRIPTS 配置

在 `lib/cron/utils.ts` 中定义:

```typescript
export const PLATFORM_SCRIPTS: Record<string, Array<{ name: string; script: string; args: string[] }>> = {
  binance_futures: [
    { name: 'binance_futures_7d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['7D'] },
    { name: 'binance_futures_30d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['30D'] },
    { name: 'binance_futures_90d', script: 'scripts/import/import_binance_futures_api.mjs', args: ['90D'] },
  ],
  okx_futures: [
    { name: 'okx_futures_7d', script: 'scripts/import/import_okx_futures.mjs', args: ['7D'] },
    { name: 'okx_futures_30d', script: 'scripts/import/import_okx_futures.mjs', args: ['30D'] },
    { name: 'okx_futures_90d', script: 'scripts/import/import_okx_futures.mjs', args: ['90D'] },
  ],
  weex: [
    { name: 'weex_7d', script: 'scripts/import/import_weex.mjs', args: ['7D'] },
    { name: 'weex_30d', script: 'scripts/import/import_weex.mjs', args: ['30D'] },
    { name: 'weex_90d', script: 'scripts/import/import_weex.mjs', args: ['90D'] },
  ],
  // ... 其他平台配置
}
```

### 熔断器机制

Cron 任务集成了熔断器保护:

- 失败阈值: 3次连续失败后熔断
- 恢复阈值: 1次成功后恢复
- 超时时间: 5分钟后尝试恢复
- 状态: CLOSED -> OPEN -> HALF_OPEN -> CLOSED

## 部署

### Vercel 部署

1. Fork 仓库到 GitHub
2. 在 Vercel 导入项目
3. 配置环境变量
4. 部署完成

自动部署:
- Push 到 `main` 分支 -> 生产环境
- Pull Request -> 预览环境

### 环境配置

```bash
# vercel.json 包含:
# - Cron 定时任务配置 (17个定时任务)
# - 缓存头配置 (各 API 端点)
# - 安全头配置 (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
```

## API 文档

API 遵循 RESTful 设计，主要端点:

### 排行榜 API

```
GET /api/rankings

查询参数:
- window: 时间窗口 (必需) - '7d' | '30d' | '90d'
- platform: 平台筛选 (可选) - 'binance_futures' | 'okx_futures' | 'weex' | ...
- category: 分类筛选 (可选) - 'futures' | 'spot' | 'onchain'
- sort_by: 排序字段 (可选) - 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
- sort_dir: 排序方向 (可选) - 'asc' | 'desc'
- limit: 返回数量 (可选) - 默认 100，最大 500
- offset: 偏移量 (可选) - 默认 0
- min_pnl: 最小盈亏 (可选)
- min_trades: 最小交易数 (可选)

响应:
{
  "traders": [...],
  "window": "90D",
  "total_count": 425,
  "as_of": "2026-01-26T10:00:00Z",
  "is_stale": false
}
```

### 交易员 API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /api/traders | 获取交易员列表 |
| GET | /api/traders/[handle] | 获取交易员详情 |
| GET | /api/traders/[handle]/positions | 获取持仓信息 |
| GET | /api/traders/[handle]/equity | 获取权益曲线 |
| POST | /api/traders/claim | 认领交易员账户 |

### 帖子 API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /api/posts | 获取帖子列表 |
| POST | /api/posts | 创建帖子 |
| GET | /api/posts/[id] | 获取帖子详情 |
| POST | /api/posts/[id]/like | 点赞/取消点赞 |
| POST | /api/posts/[id]/comments | 发表评论 |

### 健康检查

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /api/health | 基础健康检查 |
| GET | /api/health/detailed | 详细健康状态 |

## 性能优化

### 缓存策略

| 数据类型 | 缓存位置 | TTL | 配置 |
|----------|----------|-----|------|
| 交易员列表 | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| 帖子列表 | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=120 |
| 市场数据 | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=60 |
| 排行榜 | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| 用户资料 | Redis | 5m | - |
| 静态资源 | CDN | 1年 | - |

### 前端优化

- 图片懒加载 (LazyImage 组件)
- 虚拟滚动列表 (VirtualList 组件)
- 页面过渡动画
- Service Worker 离线缓存
- 包体积优化 (optimizePackageImports)
- Skeleton 骨架屏加载

### 数据库优化

- 关键字段索引 (source, source_trader_id, season_id)
- 分页查询 (limit/offset)
- 批量操作 (upsert)
- RLS 策略优化

### 预期性能指标

| 指标 | 目标值 |
|------|--------|
| 首页 LCP | < 1.5s |
| 首次交互 (FID) | < 50ms |
| 累积布局偏移 (CLS) | < 0.1 |
| API 响应时间 (P95) | < 200ms |

## 安全特性

| 措施 | 实现 | 说明 |
|------|------|------|
| XSS 防护 | DOMPurify | 内容消毒 |
| CSRF 防护 | 双重提交 Cookie | 防止跨站请求伪造 |
| 限流 | Upstash Ratelimit | 防止 API 滥用 |
| CSP | Content Security Policy | 内容安全策略 |
| 敏感数据加密 | AES-256-GCM | API 密钥等加密存储 |
| RLS | 行级安全 | 数据库访问控制 |
| 输入验证 | Zod | Schema 验证 |

### API 限流配置

| API 类型 | 限制 |
|----------|------|
| 公开 API | 150/min |
| 认证 API | 300/min |
| 写操作 | 50/min |
| 读取 API | 500/min |
| 搜索 API | 60/min |

## 移动端支持

项目使用 Capacitor 支持原生移动应用:

### 配置

```json
{
  "appId": "com.arenafi.app",
  "appName": "Arena",
  "webDir": "public"
}
```

### 构建

```bash
# Android
npx cap add android
npx cap sync android
npx cap open android

# iOS
npx cap add ios
npx cap sync ios
npx cap open ios
```

## 相关文档

- [系统架构](docs/ARCHITECTURE.md) - 详细架构说明
- [Arena Score 算法](docs/ARENA_SCORE_METHODOLOGY.md) - 评分算法详解
- [Supabase 配置](docs/SUPABASE_SETUP.md) - 数据库配置指南
- [性能优化](docs/OPTIMIZATION_SUMMARY.md) - 优化措施汇总
- [CLAUDE.md](CLAUDE.md) - AI 助手开发指南

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

MIT License

---

如有问题或建议，请联系 Adelinewen1107@outlook.com
