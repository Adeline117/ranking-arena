# Arena

加密货币交易员排行榜与社区平台。聚合 Binance、Bybit、Bitget、MEXC、OKX、KuCoin、CoinEx、GMX 等交易所的跟单数据，提供透明的交易员排名和社区讨论功能。

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [数据库设置](#数据库设置)
- [开发指南](#开发指南)
- [测试](#测试)
- [数据抓取](#数据抓取)
- [部署](#部署)
- [API 文档](#api-文档)
- [性能优化](#性能优化)
- [安全特性](#安全特性)
- [移动端支持](#移动端支持)
- [许可证](#许可证)

## 功能特性

### 核心功能

- **多交易所排行榜** - 聚合主流交易所 Copy Trading 数据
  - Binance (期货/现货/Web3)
  - Bybit
  - Bitget (期货/现货)
  - MEXC
  - OKX Web3
  - KuCoin
  - CoinEx
  - GMX (去中心化)

- **Arena Score 评分系统** - 综合评估交易员的收益能力和风险控制
  - 收益分 (85%): 基于年化收益强度
  - 回撤分 (8%): 基于最大回撤风险
  - 稳定分 (7%): 基于胜率稳定性

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

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端框架 | Next.js 16 | App Router, Server Components |
| UI 库 | React 19 | 最新的 React 特性 |
| 类型系统 | TypeScript 5 | 严格类型检查 |
| 样式 | Tailwind CSS 4 | 原子化 CSS |
| 状态管理 | Zustand 5 | 轻量级状态管理 |
| 数据获取 | SWR | 数据缓存和重新验证 |
| 表单验证 | Zod | Schema 验证 |
| 图表 | Lightweight Charts | 轻量级金融图表 |
| 数据库 | Supabase (PostgreSQL) | 托管数据库 + Auth + Realtime |
| 缓存 | Upstash Redis | 分布式缓存 + 限流 |
| 支付 | Stripe | 订阅和打赏 |
| 部署 | Vercel | 边缘部署 + Serverless |
| 监控 | Sentry | 错误追踪 + 性能监控 |
| 爬虫 | Puppeteer | 无头浏览器数据抓取 |

## 系统架构

```
                         客户端 (Browser / Mobile)
                                    |
                                    v
                         Next.js Middleware
                  (认证 / CORS / CSP / CSRF / 限流)
                                    |
                                    v
                              API 路由层
                    (withApiMiddleware 统一包装)
                                    |
            +-----------+-----------+-----------+
            |           |           |           |
            v           v           v           v
        Supabase    Upstash     外部API     Stripe
      (PostgreSQL)  (Redis)    (交易所)    (支付)
```

### 数据流

1. **交易员数据同步**: Vercel Cron 每4小时触发 -> 抓取各交易所 API -> 清洗标准化 -> 存入数据库
2. **用户请求流程**: 请求 -> Middleware (认证/限流) -> API Handler -> 数据层 (Supabase + Redis) -> 响应
3. **实时更新**: Supabase Realtime WebSocket 推送帖子/评论/通知更新

## 项目结构

```
ranking-arena/
├── app/                          # Next.js App Router
│   ├── api/                      # API 路由 (110+ endpoints)
│   │   ├── traders/              # 交易员相关
│   │   ├── posts/                # 帖子相关
│   │   ├── groups/               # 小组相关
│   │   ├── exchange/             # 交易所绑定
│   │   ├── cron/                 # 定时任务
│   │   ├── admin/                # 管理后台
│   │   └── stripe/               # 支付相关
│   ├── components/               # React 组件
│   │   ├── Base/                 # 基础组件 (Button, Text, Box)
│   │   ├── UI/                   # UI 组件 (Card, Modal, Toast)
│   │   ├── Trader/               # 交易员组件
│   │   ├── Features/             # 功能组件
│   │   ├── Charts/               # 图表组件
│   │   └── Layout/               # 布局组件
│   ├── trader/[handle]/          # 交易员详情页
│   ├── groups/                   # 小组功能
│   ├── admin/                    # 管理后台
│   └── [其他路由]/
│
├── lib/                          # 共享库
│   ├── api/                      # API 工具 (中间件/错误处理/验证)
│   ├── data/                     # 数据获取层
│   ├── exchange/                 # 交易所 API 封装
│   ├── hooks/                    # React Hooks
│   ├── stores/                   # Zustand Stores
│   ├── supabase/                 # Supabase 客户端
│   ├── utils/                    # 工具函数
│   ├── types/                    # TypeScript 类型
│   ├── analytics/                # 埋点分析
│   ├── cache/                    # 缓存策略
│   ├── compliance/               # 合规 (GDPR)
│   └── security/                 # 安全工具
│
├── scripts/                      # 数据脚本
│   ├── import_*.mjs              # 数据导入脚本
│   ├── fetch_*_details.mjs       # 详情抓取脚本
│   └── setup_*.sql               # 数据库设置脚本
│
├── worker/                       # 独立爬虫服务
│   └── src/scrapers/             # 各交易所爬虫
│
├── supabase/                     # 数据库迁移
│   └── migrations/               # SQL 迁移文件
│
├── e2e/                          # E2E 测试 (Playwright)
├── stories/                      # Storybook 组件文档
├── android/                      # Android 原生项目
├── ios/                          # iOS 原生项目
├── public/                       # 静态资源
└── docs/                         # 项目文档
```

## 快速开始

### 环境要求

- Node.js >= 20
- npm >= 10
- PostgreSQL (通过 Supabase)

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

### 数据库迁移

项目使用 Supabase Migrations 管理数据库版本:

```bash
# 查看迁移文件
ls supabase/migrations/

# 迁移文件按顺序执行
00001_initial_schema.sql
00002_binance_trader_details.sql
00003_add_season_id_constraint.sql
00004_performance_optimizations.sql
...
```

## 开发指南

### 常用命令

```bash
# 开发
npm run dev              # 启动开发服务器
npm run build            # 构建生产版本
npm run start            # 启动生产服务器

# 代码质量
npm run lint             # ESLint 检查
npm run lint:fix         # ESLint 自动修复
npm run format           # Prettier 格式化
npm run type-check       # TypeScript 类型检查

# 测试
npm run test             # 运行单元测试
npm run test:watch       # 监听模式测试
npm run test:coverage    # 测试覆盖率
npm run test:e2e         # 运行 E2E 测试

# 组件文档
npm run storybook        # 启动 Storybook
npm run build-storybook  # 构建 Storybook

# 分析
npm run analyze          # 包大小分析
```

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 ESLint + Prettier 规则
- 组件使用函数式组件 + Hooks
- API 使用 `withApiMiddleware` 包装器
- 数据获取使用 SWR 或 Server Components

### 添加新 API

```typescript
// app/api/example/route.ts
import { NextRequest } from 'next/server'
import { withApiMiddleware } from '@/lib/api/middleware'
import { successResponse, errorResponse } from '@/lib/api/response'
import { z } from 'zod'

const schema = z.object({
  name: z.string().min(1),
})

export const GET = withApiMiddleware(async (request: NextRequest) => {
  // 你的逻辑
  return successResponse({ data: 'example' })
})

export const POST = withApiMiddleware(
  async (request: NextRequest) => {
    const body = await request.json()
    const data = schema.parse(body)
    // 你的逻辑
    return successResponse({ data })
  },
  { requireAuth: true }
)
```

### 添加新组件

组件放置在 `app/components/` 下对应目录:

- `Base/` - 基础原子组件
- `UI/` - 通用 UI 组件
- `Features/` - 业务功能组件
- `Trader/` - 交易员相关组件
- `Charts/` - 图表组件

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

## 数据抓取

### 定时任务 (Vercel Cron)

| 任务 | 频率 | 说明 |
|------|------|------|
| 热门交易员 | 每15分钟 | 抓取热门交易员数据 |
| 关注交易员 | 每小时 | 更新关注交易员数据 |
| 数据新鲜度检查 | 每3小时 | 检测数据是否过期 |
| 各交易所数据 | 每4小时 | 抓取各交易所排行榜 |
| 交易员详情 | 每2小时 | 抓取交易员详细信息 |

### 手动抓取

```bash
# 抓取交易员详情
npm run scrape:details
npm run scrape:details:force   # 强制更新所有

# 使用独立脚本
node scripts/fetch_binance_trader_details.mjs
node scripts/fetch_bybit_trader_details.mjs
node scripts/fetch_bitget_trader_details.mjs
```

### Worker 服务

独立的爬虫服务，可部署到 Railway:

```bash
cd worker
npm install
npm run dev                     # 开发模式
npm run scrape:all             # 抓取所有交易所
npm run scrape:binance         # 只抓取 Binance
```

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
# - Cron 定时任务配置
# - 缓存头配置
# - 安全头配置
```

## API 文档

API 遵循 RESTful 设计，主要端点:

### 交易员 API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/traders` | 获取交易员列表 |
| GET | `/api/trader/[handle]` | 获取交易员详情 |
| GET | `/api/trader/[handle]/positions` | 获取持仓信息 |
| GET | `/api/trader/[handle]/equity` | 获取权益曲线 |
| POST | `/api/trader/claim` | 认领交易员账户 |

### 帖子 API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/posts` | 获取帖子列表 |
| POST | `/api/posts` | 创建帖子 |
| GET | `/api/posts/[id]` | 获取帖子详情 |
| POST | `/api/posts/[id]/like` | 点赞/取消点赞 |
| POST | `/api/posts/[id]/comments` | 发表评论 |

### 用户 API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/users/[handle]/full` | 获取用户完整信息 |
| POST | `/api/users/follow` | 关注用户 |
| GET | `/api/following` | 获取关注列表 |
| GET | `/api/notifications` | 获取通知 |

### 健康检查

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/health` | 基础健康检查 |
| GET | `/api/health/detailed` | 详细健康状态 |

## 性能优化

### 缓存策略

| 数据类型 | 缓存位置 | TTL |
|----------|----------|-----|
| 交易员列表 | Redis + CDN | 60s |
| 帖子列表 | CDN | 30s |
| 市场数据 | CDN | 30s |
| 用户资料 | Redis | 5m |
| 静态资源 | CDN | 1年 |

### 前端优化

- 图片懒加载 (`LazyImage` 组件)
- 虚拟滚动列表 (`VirtualList` 组件)
- 页面过渡动画
- Service Worker 离线缓存
- 包体积优化 (`optimizePackageImports`)

### 数据库优化

- 关键字段索引
- 分页查询
- 批量操作
- RLS 策略优化

### 预期性能指标

| 指标 | 目标值 |
|------|--------|
| 首页 LCP | < 1.5s |
| 首次交互 (FID) | < 50ms |
| 最大并发用户 | 2000+ |

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

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

MIT License

---

如有问题或建议，请联系 support@arenafi.org
