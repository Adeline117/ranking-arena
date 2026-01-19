# Arena

加密货币交易员排行榜与社区平台。聚合 Binance、Bybit、Bitget、MEXC 等交易所的跟单数据，提供透明的交易员排名和社区讨论功能。

## 功能

- **多交易所排行榜** - 聚合主流交易所 Copy Trading 数据
- **多时间维度** - 支持 7天/30天/90天 ROI 对比
- **交易员详情** - 绩效统计、历史记录、持仓分布
- **社区功能** - 帖子、评论、小组讨论
- **账户绑定** - 绑定交易所账户解锁更多数据
- **中英文切换** - 国际化支持

## 技术栈

- Next.js 16 (App Router)
- React 19 + TypeScript
- Supabase (PostgreSQL + Auth)
- Vercel 部署

## 快速开始

```bash
# 克隆项目
git clone https://github.com/your-username/ranking-arena.git
cd ranking-arena

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
```

编辑 `.env.local`：

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Upstash Redis 缓存（可选，不配置则使用内存缓存）
UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token

# Sentry 错误监控（可选）
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn
SENTRY_ORG=your-sentry-org
SENTRY_PROJECT=your-sentry-project
SENTRY_AUTH_TOKEN=your-sentry-auth-token
```

在 Supabase SQL Editor 执行数据库脚本：

```bash
scripts/setup_all.sql
```

启动开发服务器：

```bash
npm run dev
```

访问 http://localhost:3000

## 项目结构

```
app/
├── api/                # API 路由
├── components/         # React 组件
├── trader/[handle]/    # 交易员详情页
├── groups/             # 小组功能
└── ...

lib/
├── data/              # 数据获取
├── exchange/          # 交易所 API
├── supabase/          # 数据库客户端
└── utils/             # 工具函数

scripts/               # 数据导入脚本
```

## 常用命令

```bash
npm run dev        # 开发服务器
npm run build      # 构建
npm run lint       # 代码检查
```

## 数据同步

使用 Vercel Cron Jobs 每6小时同步交易员数据，数据来源为各交易所公开 API。

## License

MIT
