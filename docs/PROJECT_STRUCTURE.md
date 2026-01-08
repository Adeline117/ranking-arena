# 项目结构说明

## 📁 目录结构

```
ranking-arena/
├── app/                          # Next.js 应用目录
│   ├── api/                      # API 路由
│   │   ├── cron/                 # 定时任务
│   │   ├── market/               # 市场数据
│   │   └── tip/                  # 打赏功能
│   ├── components/               # React 组件
│   │   ├── Base/                 # 基础组件（Box, Text, Button）
│   │   ├── Features/             # 功能组件（排行榜、市场面板等）
│   │   ├── Icons/                # 图标系统
│   │   ├── Layout/               # 布局组件
│   │   ├── trader/               # 交易员相关组件
│   │   ├── UI/                   # UI 组件（Card, Skeleton 等）
│   │   └── Utils/                # 工具组件（语言、主题等）
│   ├── groups/                   # 小组功能
│   ├── login/                    # 登录页面
│   ├── settings/                 # 设置页面
│   ├── trader/                   # 交易员主页
│   └── u/                        # 用户主页
│
├── lib/                          # 库文件
│   ├── data/                     # 数据获取函数
│   ├── supabase/                 # Supabase 客户端
│   ├── utils/                    # 工具函数（头像等）
│   ├── design-tokens.ts          # 设计令牌（主要）
│   ├── design-system-helpers.tsx # 设计系统辅助函数
│   └── theme-tokens.ts           # 主题令牌
│
├── scripts/                      # 数据导入脚本
│   ├── import_binance_copy_trading_90d.mjs  # Binance 90天数据
│   ├── fetch_binance_web3_all_pages.mjs    # Binance Web3 数据
│   ├── import_bybit_90d_roi.mjs             # Bybit 90天数据
│   ├── import_bitget_90d_roi.mjs           # Bitget 90天数据
│   ├── import_mexc_90d_roi.mjs              # MEXC 90天数据
│   ├── import_coinex_90d_roi.mjs           # CoinEx 90天数据
│   ├── setup_supabase_tables.sql            # 数据库配置
│   ├── test_auth_and_posts.mjs              # 测试脚本
│   └── verify_supabase_setup.mjs            # 验证脚本
│
├── docs/                         # 文档
│   ├── AVATAR_SYSTEM.md          # 头像系统说明
│   ├── SUPABASE_SETUP.md        # Supabase 配置指南
│   ├── SUPABASE_EMAIL_CONFIG.md  # 邮箱配置说明
│   └── PROJECT_STRUCTURE.md      # 本文件
│
└── data/                         # 数据文件
    └── backup/                   # 备份数据（自动清理30天前的）
```

## 🔧 主要脚本

### 数据导入脚本（由 Cron Job 自动运行）
- `import_binance_copy_trading_90d.mjs` - Binance 90天 ROI
- `fetch_binance_web3_all_pages.mjs` - Binance Web3 数据
- `import_bybit_90d_roi.mjs` - Bybit 90天 ROI
- `import_bitget_90d_roi.mjs` - Bitget 90天 ROI
- `import_mexc_90d_roi.mjs` - MEXC 90天 ROI
- `import_coinex_90d_roi.mjs` - CoinEx 90天 ROI

### 工具脚本
- `setup_supabase_tables.sql` - 数据库表结构配置
- `test_auth_and_posts.mjs` - 测试认证和发帖功能
- `verify_supabase_setup.mjs` - 验证 Supabase 配置

## 📄 主要路由

- `/` - 首页（排行榜 + 市场面板 + 帖子流）
- `/trader/[handle]` - 交易员主页（主要路由）
- `/u/[handle]` - 用户主页（已注册用户）
- `/groups` - 小组列表
- `/groups/[id]` - 小组详情
- `/login` - 登录/注册
- `/settings` - 设置页面
- `/following` - 关注列表

## 🎨 设计系统

### 主要文件
- `lib/design-tokens.ts` - 设计令牌（颜色、间距、字体等）
- `lib/design-system-helpers.tsx` - 辅助函数（格式化数字、百分比等）
- `lib/theme-tokens.ts` - 主题令牌（支持亮色/暗色）

### 基础组件
- `app/components/Base/Box.tsx` - 容器组件
- `app/components/Base/Text.tsx` - 文字组件
- `app/components/Base/Button.tsx` - 按钮组件

## 🗄️ 数据库表

### 主要表
- `trader_snapshots` - 交易员快照数据
- `trader_sources` - 交易员来源信息
- `profiles` / `user_profiles` - 用户资料
- `posts` - 帖子
- `groups` - 小组
- `follows` - 关注关系

## 📝 文档

- `docs/AVATAR_SYSTEM.md` - 头像系统实现说明
- `docs/SUPABASE_SETUP.md` - Supabase 完整配置指南
- `docs/SUPABASE_EMAIL_CONFIG.md` - 邮箱配置详细步骤
- `app/components/README.md` - 组件目录结构说明
- `scripts/README.md` - 脚本使用说明


