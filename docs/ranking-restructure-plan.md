# 排名页重构方案

## 一、整体架构变更

### 主导航栏（TopNav）
**变更前**: 排名 | 书库 | 小组 | 市场 | 热门
**变更后**: 排名 | 小组 | 市场 | 热门

- **删除「书库」** — 内容并入排名页「资料」子分类

### 排名页副导航栏（SubNav）
```
[交易员]  [资料]  [机构]  [工具]
```

每个分类下有子类别，除「交易员」外全部使用豆瓣式评分排名。

---

## 二、四大分类详细设计

### 1. 交易员 `/rankings?tab=traders` (现有)
保持现有排行榜系统不变：
- Arena Score 排名
- 90D / 30D / 7D 时间筛选
- 平台筛选
- 交易员详情页

### 2. 资料 `/rankings?tab=resources`
原「书库」升级，增加更多类型：

| 子类别 | 说明 | 数据来源 |
|--------|------|----------|
| 论文 (Papers) | 学术论文、研究报告 | 现有 24,949 条 |
| 金融书籍 (Books) | 交易/投资/区块链书籍 | 现有 29,696 条 |
| 白皮书 (Whitepapers) | 项目白皮书 | 现有 169 条 |
| 研报 (Research) | 机构研报、行业报告 | **新增**，抓取来源：Messari、Delphi Digital、The Block Research |
| 财报 (Financials) | 上市公司/交易所财报 | **新增**，抓取来源：SEC EDGAR、交易所官网 |

**豆瓣式评分系统**：
- 5星评分（1-5分，可半星）
- 用户短评 + 长评
- 评分分布柱状图（1-5星各多少人）
- 标签系统（用户自定义标签）
- 状态按钮：想读 / 在读 / 读过
- 综合评分 = 加权平均（过滤极端值）
- 排序：评分最高 / 最新 / 最热 / 评价最多

### 3. 机构 `/rankings?tab=institutions`
全新板块：

| 子类别 | 说明 | 示例 |
|--------|------|------|
| 机构 (Institutions) | 投资机构/基金 | a16z, Paradigm, Multicoin, 三箭 |
| 项目方 (Projects) | 区块链项目团队 | Ethereum Foundation, Solana Labs, Uniswap |
| 金融交易所 (Exchanges) | CEX/DEX平台 | Binance, Coinbase, Uniswap, Hyperliquid |

**豆瓣式评分**：
- 5星评分（安全性、服务质量、透明度等维度）
- 用户评价（交易体验、客服、出入金等）
- 标签：合规、创新、安全事件、暴雷等
- 状态：关注 / 使用中 / 已弃用
- 数据指标：TVL、交易量、用户数（客观数据辅助）

**DB Schema**:
```sql
CREATE TABLE institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  name_zh TEXT,
  category TEXT NOT NULL,        -- 'fund' | 'project' | 'exchange'
  subcategory TEXT,              -- 'vc' | 'hedge_fund' | 'dex' | 'cex' | 'l1' | 'l2' | 'defi'
  logo_url TEXT,
  website TEXT,
  twitter TEXT,
  description TEXT,
  description_zh TEXT,
  founded_date DATE,
  headquarters TEXT,
  chain TEXT,                     -- 主链（项目方/DEX）
  token_symbol TEXT,
  -- 客观数据
  tvl NUMERIC,
  daily_volume NUMERIC,
  total_users INTEGER,
  -- 评分（由用户评价聚合）
  avg_rating NUMERIC(3,2),
  rating_count INTEGER DEFAULT 0,
  -- 状态
  is_active BOOLEAN DEFAULT true,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE institution_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id),
  user_id UUID REFERENCES auth.users(id),
  rating NUMERIC(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title TEXT,
  content TEXT,
  -- 多维度评分
  security_rating NUMERIC(2,1),
  service_rating NUMERIC(2,1),
  transparency_rating NUMERIC(2,1),
  innovation_rating NUMERIC(2,1),
  -- 互动
  helpful_count INTEGER DEFAULT 0,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(institution_id, user_id)
);
```

### 4. 工具 `/rankings?tab=tools`
全新板块：

| 子类别 | 说明 | 示例 |
|--------|------|------|
| 交易工具 (Trading Tools) | 行情/分析/交易辅助 | TradingView, Coinglass, DEXTools, Birdeye |
| 量化策略 (Quant Strategies) | 量化交易框架/平台 | 3Commas, Hummingbot, Jesse, Freqtrade |
| 策略 (Strategies) | 交易策略/方法论 | 网格交易、马丁格尔、DCA、均值回归 |
| 脚本 (Scripts) | 开源交易脚本/Bot | GitHub开源Bot、Pine Script策略 |

**豆瓣式评分**：
- 5星评分
- 用户评价（使用体验、盈利情况）
- 标签：免费/付费、开源、API支持、新手友好等
- 状态：想用 / 在用 / 已弃用
- 分享实盘回测数据（可选）

**DB Schema**:
```sql
CREATE TABLE tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  name_zh TEXT,
  category TEXT NOT NULL,        -- 'trading_tool' | 'quant_platform' | 'strategy' | 'script'
  subcategory TEXT,
  logo_url TEXT,
  website TEXT,
  github_url TEXT,
  description TEXT,
  description_zh TEXT,
  pricing TEXT,                   -- 'free' | 'freemium' | 'paid' | 'open_source'
  pricing_detail TEXT,
  supported_exchanges TEXT[],
  supported_chains TEXT[],
  languages TEXT[],               -- 支持的编程语言
  -- 评分
  avg_rating NUMERIC(3,2),
  rating_count INTEGER DEFAULT 0,
  -- 状态
  is_active BOOLEAN DEFAULT true,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tool_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id UUID REFERENCES tools(id),
  user_id UUID REFERENCES auth.users(id),
  rating NUMERIC(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title TEXT,
  content TEXT,
  -- 多维度
  ease_of_use_rating NUMERIC(2,1),
  reliability_rating NUMERIC(2,1),
  value_rating NUMERIC(2,1),
  -- 互动
  helpful_count INTEGER DEFAULT 0,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tool_id, user_id)
);
```

---

## 三、通用评分系统（豆瓣式）

### 评分组件 `<RatingSystem>`
适用于：资料、机构、工具三个分类

```
┌──────────────────────────────────┐
│  ★★★★☆  4.2                     │
│  ■■■■■■■■■■  5星  45%           │
│  ■■■■■■■    4星  32%            │
│  ■■■        3星  15%            │
│  ■          2星   5%            │
│  ■          1星   3%            │
│                                  │
│  共 1,234 人评价                  │
│  [ 写评价 ]                      │
└──────────────────────────────────┘
```

### 排序方式
1. **评分最高** — avg_rating DESC (rating_count >= 5 过滤)
2. **评价最多** — rating_count DESC
3. **最新添加** — created_at DESC
4. **最热门** — view_count + rating_count 加权

### 标签系统
- 系统预设标签 + 用户自定义标签
- 标签可筛选
- 热门标签云

---

## 四、URL路由设计

```
/                           → 排名页，默认交易员
/?tab=traders              → 交易员排名（现有）
/?tab=resources            → 资料排名
/?tab=resources&sub=papers → 资料-论文
/?tab=resources&sub=books  → 资料-书籍
/?tab=institutions         → 机构排名
/?tab=institutions&sub=exchanges → 机构-交易所
/?tab=tools                → 工具排名
/?tab=tools&sub=quant      → 工具-量化策略
```

或使用路径式：
```
/rankings/traders          → 交易员
/rankings/resources        → 资料
/rankings/resources/papers → 论文
/rankings/institutions     → 机构
/rankings/tools            → 工具
```

**推荐路径式** — 更清晰，SEO友好。

---

## 五、前端组件结构

```
app/rankings/
├── layout.tsx              ← 共享副导航栏
├── page.tsx                ← 重定向到 /rankings/traders
├── traders/
│   └── page.tsx            ← 现有交易员排名（迁移）
├── resources/
│   ├── page.tsx            ← 资料总览
│   ├── [category]/
│   │   └── page.tsx        ← 论文/书籍/白皮书/研报/财报
│   └── [id]/
│       └── page.tsx        ← 资料详情页（含评分）
├── institutions/
│   ├── page.tsx            ← 机构总览
│   ├── [category]/
│   │   └── page.tsx        ← 基金/项目方/交易所
│   └── [id]/
│       └── page.tsx        ← 机构详情页（含评分）
└── tools/
    ├── page.tsx            ← 工具总览
    ├── [category]/
    │   └── page.tsx        ← 交易工具/量化/策略/脚本
    └── [id]/
        └── page.tsx        ← 工具详情页（含评分）
```

---

## 六、数据初始化计划

### 资料（已有数据迁移）
- 论文：24,949 条 ✅
- 书籍：29,696 条 ✅  
- 白皮书：169 条 ✅
- 研报：**需新增**，来源 Messari/The Block/Galaxy Digital 公开研报
- 财报：**需新增**，来源 SEC EDGAR + 交易所季报

### 机构（需全新建库）
- 交易所：~100家主流CEX/DEX
- 投资机构：~200家知名Crypto VC/基金
- 项目方：~500个主流项目

### 工具（需全新建库）
- 交易工具：~50个（TradingView, Coinglass, DEXScreener...）
- 量化平台：~30个（3Commas, Hummingbot, Freqtrade...）
- 策略模板：~100个
- 开源脚本：~200个（从GitHub精选）

---

## 七、实施阶段

### Phase 1（1周）— 基础架构
1. DB建表：institutions, tools, reviews表
2. 通用评分组件 `<RatingSystem>`
3. 排名页副导航栏
4. 删除TopNav「书库」
5. 迁移现有书库数据到「资料」子分类

### Phase 2（1周）— 资料板块
6. 资料列表页（含子类别筛选）
7. 资料详情页（豆瓣式评分+评价）
8. 研报数据抓取脚本
9. 现有书籍评分系统迁移

### Phase 3（1周）— 机构板块
10. 机构数据初始化（交易所+VC+项目方）
11. 机构列表页
12. 机构详情页（多维度评分）
13. 客观数据对接（DeFi Llama TVL等）

### Phase 4（1周）— 工具板块
14. 工具数据初始化
15. 工具列表页
16. 工具详情页
17. GitHub Stars/活跃度集成

---

## 八、豆瓣式评分核心规则

1. **最低评价数门槛**：评价 < 5人 不显示评分，显示"评价人数不足"
2. **加权平均**：新用户权重低，活跃评价用户权重高
3. **极端值过滤**：去掉最高5%和最低5%后取均值
4. **时间衰减**：老评价权重递减，鼓励新评价
5. **防刷分**：同IP/设备检测，新注册用户冷却期
6. **评价审核**：敏感词过滤，异常评分提醒

---

## 九、与现有系统整合

- **搜索**：统一搜索覆盖四大分类
- **用户Profile**：展示用户的评价历史、关注列表
- **推荐**：基于用户评分推荐相似内容
- **SEO**：每个资料/机构/工具都有独立URL和OG标签
- **i18n**：所有新内容支持中/英双语
