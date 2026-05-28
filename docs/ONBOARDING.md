# 新人入门指南

欢迎加入 Arena。这篇文档帮你从零开始到能干活。

---

## 1. 环境搭建

### 前置要求（必须装好）

- **Node.js 20+** — 运行项目的基础
- **npm 10+** — 随 Node 自带
- **Git** — 代码版本管理
- **VS Code**（推荐）— 项目有 `.vscode/` 配置，装了会自动生效

### 搭建步骤

```bash
# 1. 拉代码
git clone git@github.com:Adeline117/ranking-arena.git
cd ranking-arena

# 2. 装依赖
npm install

# 3. 配环境变量（找 Adeline 拿真实值）
cp .env.example .env.local
# 然后编辑 .env.local，填入真实的 key

# 4. 启动开发服务器
npm run dev
# 浏览器打开 http://localhost:3000
```

### 环境变量：哪些必须填，哪些可以不管

`.env.example` 里有 190+ 个变量。**你不需要全部填**。按下面的优先级来：

#### 必须填（没有这些 app 起不来）

```bash
NEXT_PUBLIC_SUPABASE_URL=...         # Supabase 项目地址
NEXT_PUBLIC_SUPABASE_ANON_KEY=...    # Supabase 公开 key（前端用）
SUPABASE_SERVICE_ROLE_KEY=...        # Supabase 管理 key（后端用，绕过 RLS）
UPSTASH_REDIS_REST_URL=...           # Redis 缓存地址
UPSTASH_REDIS_REST_TOKEN=...         # Redis 认证 token
CRON_SECRET=...                      # 定时任务验证密钥
```

#### 测支付功能时才需要

```bash
STRIPE_SECRET_KEY=sk_test_...                  # Stripe 测试密钥
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_... # Stripe 前端 key
STRIPE_WEBHOOK_SECRET=whsec_...                # Stripe webhook 签名
```

#### 可选（不填也能跑，但少些功能）

```bash
SENTRY_DSN=...              # 错误监控，不填则不上报
TELEGRAM_BOT_TOKEN=...      # 管道告警，不填则不发 Telegram
OPENAI_API_KEY=...          # 翻译功能，不填则翻译不可用
VPS_PROXY_KEY=...           # VPS 爬虫代理，不填则部分交易所数据拿不到
```

#### 不用管的

`.env.example` 里的 Web3 相关（RPC URLs、合约地址、Block Explorer keys）、HSM、QStash、Smart Scheduler 等，目前日常开发不需要。

> **找 Adeline 要一份填好的 `.env.local`，直接拿来用。永远不要把 `.env.local` 提交到 Git。**

### 开发服务器注意事项

- 用的是 Turbopack（比 Webpack 快），`npm run dev` 已经配好了
- 开发服务器需要约 3.5GB 内存（npm scripts 里已经设了 `--max-old-space-size=3584`）
- 第一次启动比较慢，后续热更新很快

---

## 2. 需要的账号权限

找 Adeline 开通以下权限：

| 服务         | 需要的权限                              | 用途                       | 必须？         |
| ------------ | --------------------------------------- | -------------------------- | -------------- |
| **GitHub**   | `Adeline117/ranking-arena` Collaborator | 推代码、开 PR              | 必须           |
| **Vercel**   | Team member                             | 看部署状态、日志、环境变量 | 必须           |
| **Supabase** | Project member                          | 查数据库、跑 SQL、看日志   | 必须           |
| **Sentry**   | Project member                          | 查线上错误和性能           | 建议           |
| **Upstash**  | Read access                             | 查 Redis 缓存和限流状态    | 可选           |
| **Stripe**   | Test mode access                        | 测试支付流程               | 碰支付时才需要 |

---

## 3. 文档阅读顺序

### 第一天：必读（约 1 小时）

按这个顺序读，不要跳：

| 顺序 | 文件                   | 时间    | 读完你会知道什么                                                              |
| ---- | ---------------------- | ------- | ----------------------------------------------------------------------------- |
| 1    | `CLAUDE.md`            | 30 分钟 | **最重要的一个文件。** 架构、目录、数据库、代码约定、强制规则、常用命令全在这 |
| 2    | `CONTRIBUTING.md`      | 5 分钟  | 代码风格、commit 格式、PR 流程                                                |
| 3    | `docs/GIT_WORKFLOW.md` | 5 分钟  | 分支策略、两人协作方式                                                        |
| 4    | `PROGRESS.md`          | 10 分钟 | 最近在做什么、遇到了什么问题                                                  |
| 5    | `TASKS.md`             | 10 分钟 | 待办任务和优先级，看看接下来该做什么                                          |

### 第一周：碰到相关工作时再读

| 文件                              | 什么时候读                                     |
| --------------------------------- | ---------------------------------------------- |
| `DECISIONS.md`                    | 想知道「为什么这么设计」的时候                 |
| `docs/RUNBOOK.md`                 | 要碰生产环境之前（应急手册，有真实 IP 和命令） |
| `docs/SCRAPER.md`                 | 要碰数据管道或交易所连接器之前                 |
| `docs/API_BEST_PRACTICES.md`      | 要写新 API 路由之前                            |
| `docs/RLS_POLICIES.md`            | 要碰数据库表之前                               |
| `docs/SECURITY_BEST_PRACTICES.md` | 要碰认证、支付、用户数据之前                   |
| `docs/system-principles.md`       | 要写有状态管理的前端组件之前                   |
| `docs/EXCHANGE_FIELD_MAPPING.md`  | 要处理交易所数据字段映射之前                   |

完整文档索引：`docs/README.md`

---

## 4. 常用命令

### 每天都会用

```bash
npm run dev              # 启动开发服务器
npm run type-check       # TypeScript 类型检查（推代码前必须跑）
npm run lint             # ESLint 代码检查
npm run test             # Jest 单元测试
```

### 偶尔用

```bash
npm run build            # 生产构建（验证构建是否通过）
npm run test:e2e         # Playwright E2E 测试
npm run diagnose         # 检查各交易所数据新鲜度
npm run check:platforms  # 平台状态概览
```

### 管道诊断（数据不对的时候用）

```bash
node scripts/pipeline-health-check.mjs          # 完整健康检查
node scripts/pipeline-health-check.mjs --quick   # 快速检查数据新鲜度
node scripts/pipeline-health-check.mjs --fix     # 生成修复脚本
```

---

## 5. 项目结构速查

```
app/                    # Next.js 页面和 API 路由
  api/                  #   100+ 个 API 端点
    cron/               #   定时任务（62 个 Vercel Cron）
  components/           #   所有 React 组件
  rankings/             #   排行榜页面
  trader/[id]/          #   交易员详情页

lib/                    # 核心逻辑（代码里用 @/lib/... 引入）
  connectors/           #   交易所 API 连接器
  data/                 #   服务端数据函数
  hooks/                #   React hooks（客户端）
  utils/                #   工具函数
  supabase/             #   Supabase 客户端封装

docs/                   # 文档（你正在看的）
scripts/                # CLI 工具、导入脚本、维护脚本
supabase/migrations/    # 数据库迁移文件（SQL）
```

更完整的目录说明在 `CLAUDE.md` > Directory Structure。

---

## 6. 核心概念

### 数据流（一句话版）

```
32+ 交易所 → 定时任务抓取 → 存入 Supabase → 计算 Arena Score → 生成排行榜 → 前端展示
```

### Arena Score（排名算法）

统一的排名指标。公式：`收益分 (0-60) + PnL 分 (0-40)`，乘以置信度和信任权重。

- 不同时间段（7D/30D/90D）用不同系数
- 总分 = 90D _ 0.70 + 30D _ 0.25 + 7D \* 0.05
- 代码在 `lib/utils/arena-score.ts`

### 交易员身份

每个交易员用 `(source, source_trader_id)` 做唯一标识。同一个人在 Binance 和 Bybit 上是两条不同的记录。

### 交易所连接器

`lib/connectors/` 下每个连接器实现两个方法：

- `fetchLeaderboard(period)` — 拿排行榜数据
- `fetchTraderDetails(traderId)` — 拿交易员详情

内置了限流和熔断器，不用手动处理。

---

## 7. 你的第一个任务

建议：挑一个小的、低风险的问题，走一遍完整流程。

```bash
# 1. 拉最新代码
git checkout main && git pull

# 2. 建分支
git checkout -b fix/my-first-fix

# 3. 改代码（参照 CLAUDE.md 里的规范）

# 4. 本地验证
npm run type-check && npm run test

# 5. 推代码、开 PR
git push -u origin fix/my-first-fix
gh pr create --title "fix: 描述你改了什么" --body "## Summary\n- ..."

# 6. 等 Adeline review → 改 feedback → merge

# 7. merge 后等 Vercel 部署（5-8 分钟），然后检查线上
```

从 `TASKS.md` 里找一个 P2/P3 的任务，或者问 Adeline 哪个适合新手。

---

## 8. 协作约定

| 场景                                    | 约定                                   |
| --------------------------------------- | -------------------------------------- |
| **每天**                                | 简短说一下今天在做什么                 |
| **PR review**                           | 尽量几小时内回复                       |
| **卡住了**                              | 卡了 30 分钟就问，不要自己闷头搞几小时 |
| **碰敏感区域**（DB schema、认证、支付） | 先讨论再动手                           |
| **commit**                              | 一个修改一个 commit，不要攒一堆一起提  |

---

## 9. 常见坑

| 问题                        | 怎么办                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 开发服务器内存不够          | 已处理，npm scripts 设了 `--max-old-space-size=3584`                                                                                      |
| Binance/OKX API 返回 403    | 被地理封锁了。用 VPS 代理或 Cloudflare Worker（见 `docs/SCRAPER.md`）                                                                     |
| 推代码被 pre-push hook 拦住 | hook 会跑 lint + type-check，报错的话先修好再推                                                                                           |
| 数据库迁移文件命名          | **必须**用 `scripts/new-migration.sh <描述>` 生成，不要手动命名（防止时间戳冲突）                                                         |
| Modal 滚动穿透              | **禁止**手写 `document.body.style.overflow = 'hidden'`。用 `<ModalOverlay>` 或 `useModalA11y`。pre-push hook 会拦截这个模式               |
| API 路由里发通知            | **禁止**直接 `supabase.from('notifications').insert()`。用 `sendNotification()`（from `lib/data/notifications.ts`）。pre-push hook 会拦截 |
| 第一次 `npm run build` 很慢 | 正常，完整构建需要较长时间。日常开发用 `npm run dev` 就行                                                                                 |

---

## 10. 有用的链接

| 资源            | 地址                                        |
| --------------- | ------------------------------------------- |
| 线上站点        | https://www.arenafi.org                     |
| GitHub 仓库     | https://github.com/Adeline117/ranking-arena |
| Vercel 控制台   | 找 Adeline 邀请加入                         |
| Supabase 控制台 | 找 Adeline 邀请加入                         |
| Sentry 错误监控 | 找 Adeline 邀请加入                         |
