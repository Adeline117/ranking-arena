# Ranking Arena 🏆

加密货币交易员排行榜与社区平台 - 聚合多家交易所的跟单/Copy Trading数据，提供透明的交易员排名、实时市场数据和社区讨论功能。

## ✨ 功能特性

- 📊 **多交易所聚合排行榜** - 支持 Binance、Bybit、Bitget、MEXC、CoinEx 等主流交易所
- 📈 **多时间维度 ROI** - 7天、30天、90天收益率对比
- 👤 **交易员详情页** - 绩效数据、历史记录、持仓分布
- 🔗 **交易所账户绑定** - 绑定后解锁更多详细数据
- 💬 **社区功能** - 帖子、评论、投票、小组讨论
- 🔔 **通知系统** - 实时通知用户互动
- 🌏 **国际化** - 支持中文/英文切换
- 🌙 **深色模式** - 舒适的夜间浏览体验

## 🛠️ 技术栈

- **前端框架**: Next.js 16 (App Router)
- **UI**: React 19 + Tailwind CSS 4
- **后端/数据库**: Supabase (PostgreSQL + Auth + Storage)
- **部署**: Vercel
- **语言**: TypeScript

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/your-username/ranking-arena.git
cd ranking-arena
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env.local
```

编辑 `.env.local`，填写以下必需的环境变量：

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ENCRYPTION_KEY=your-32-character-key
```

### 4. 设置 Supabase 数据库

在 Supabase SQL Editor 中执行以下脚本（按顺序）：

```bash
scripts/setup_supabase_tables.sql      # 基础表结构
scripts/setup_community_tables.sql     # 社区功能表
scripts/setup_user_exchange_tables.sql # 用户交易所绑定表
```

### 5. 启动开发服务器

```bash
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000)

## 📁 项目结构

```
ranking-arena/
├── app/                    # Next.js App Router
│   ├── api/               # API 路由
│   ├── components/        # React 组件
│   ├── trader/[handle]/   # 交易员详情页
│   ├── u/[handle]/        # 用户主页
│   ├── groups/            # 小组功能
│   └── ...
├── lib/                   # 库文件
│   ├── api/              # API 工具 (响应/验证)
│   ├── data/             # 数据获取函数
│   ├── exchange/         # 交易所 API 客户端
│   ├── supabase/         # Supabase 客户端
│   ├── types/            # TypeScript 类型定义
│   └── utils/            # 工具函数
├── scripts/              # 数据导入脚本
└── docs/                 # 文档
```

## 📝 主要路由

| 路由 | 说明 |
|------|------|
| `/` | 首页 (排行榜 + 市场 + 帖子流) |
| `/trader/[handle]` | 交易员详情页 |
| `/u/[handle]` | 用户个人主页 |
| `/groups` | 小组列表 |
| `/groups/[id]` | 小组详情 |
| `/hot` | 热榜 |
| `/search` | 搜索 |
| `/settings` | 用户设置 |
| `/notifications` | 通知中心 |

## 🔧 可用脚本

```bash
npm run dev          # 启动开发服务器
npm run build        # 构建生产版本
npm run start        # 启动生产服务器
npm run lint         # 运行 ESLint
npm run lint:fix     # 自动修复 ESLint 问题
npm run type-check   # TypeScript 类型检查
npm run clean        # 清理构建缓存
```

## 📊 数据同步

项目使用 Vercel Cron Jobs 定时同步交易员数据：

- **频率**: 每6小时
- **端点**: `/api/cron/fetch-traders`
- **数据源**: 各交易所公开 Copy Trading API

## 🔒 安全说明

- 用户 API Key 使用 AES-256-GCM 加密存储
- Supabase RLS (Row Level Security) 保护数据访问
- Admin 页面需要管理员权限

## 📖 更多文档

详细文档位于 `docs/` 目录：

- [项目结构说明](docs/PROJECT_STRUCTURE.md)
- [Supabase 配置指南](docs/SUPABASE_SETUP.md)
- [交易员关注功能](docs/SETUP_TRADER_FOLLOWS.md)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT License
