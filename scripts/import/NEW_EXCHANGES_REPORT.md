# 新交易所研究报告
> 生成时间: 2026-02-10

## 总结

| 交易所 | 类型 | 可行性 | 状态 | 说明 |
|--------|------|--------|------|------|
| **BTCC** | CEX | ✅ 可用 | 已写脚本并测试通过 | API返回20个交易员，数据质量好 |
| Bitfinex | CEX | ❌ 不可用 | 脚本存在但API 404 | 竞赛API已下线 |
| Crypto.com | CEX | ❌ 不可用 | 脚本存在但API不公开 | 页面需登录，无公开API |
| Pionex | CEX | ❌ 不可用 | 脚本存在但API 404 | CF防护+API变更 |
| BitMart | CEX | ❌ 不可用 | — | CF防护，V1已废弃，V2 API 404 |
| AscendEX | CEX | ❌ 不可用 | — | 无公开排行榜/跟单功能 |
| Margex | CEX | ❌ 不可用 | — | Copy trading页面需登录，无公开API |
| PrimeXBT | CEX | ❌ 不可用 | — | API返回403/Unauthorized |
| Kwenta | DEX | ⚠️ 需API Key | 脚本存在 | 需要 The Graph API Key |
| Vertex | DEX | ❌ 不可用 | — | 无公开leaderboard API |
| Drift | DEX | ⚠️ 理论可行 | — | 链上数据，仅钱包地址无handle |
| Perpetual Protocol | DEX | ❌ 不可用 | — | 无排行榜功能 |
| Mux Protocol | DEX | ⚠️ 需API Key | 脚本存在 | 需要 The Graph API Key |

## 详细分析

### ✅ BTCC — 已成功添加
- **API**: `POST https://www.btcc.com/documentary/trader/page`
- **数据**: traderId, nickName, avatarPic, totalNetProfit(PnL), rateProfit(ROI%), winRate, maxBackRate(MDD), followNum
- **限制**: API只返回固定20个交易员，不支持真正的分页
- **脚本**: `import_btcc.mjs` — 已测试通过，成功保存20条数据到DB
- **数据质量**: 优秀，包含头像、昵称、ROI、PnL、胜率、最大回撤、粉丝数

### ❌ Bitfinex
- 现有脚本尝试访问 `https://api-pub.bitfinex.com/v2/competitions/leaderboards`
- 所有竞赛API端点返回 HTTP 404
- Bitfinex似乎已取消/暂停公开排行榜功能

### ❌ Crypto.com
- 有copy trading页面 (`https://crypto.com/exchange/copy-trading`)
- 但API端点被Gatsby静态页面替代，不返回JSON
- 需要登录才能看到完整trader列表
- 无公开可用的REST API

### ❌ Pionex
- 有copy trading功能
- Cloudflare防护严格（403）
- API端点返回404，可能已变更路径
- 现有V2脚本使用Playwright也无法绕过

### ❌ BitMart
- 公开API存在但copy trading相关的：
  - V1 API已废弃
  - V2 API `contract/v2/copy-trading/traders` 返回404
- 网页有CF防护

### ❌ AscendEX
- 无copy trading或排行榜功能
- 返回的是单页应用壳，无有用API

### ❌ Margex
- 有copy trading功能，但公开页面显示"Page Not Found"
- Copy trading trader列表需要登录
- 无公开API端点

### ❌ PrimeXBT (Covesting)
- 有Covesting copy trading功能
- API `api.primexbt.com` 返回 403 Forbidden / Unauthorized
- 需要认证访问

### ⚠️ Kwenta (需要The Graph API Key)
- 使用The Graph subgraph获取链上交易数据
- Subgraph ID: `5sbJJTTJQQ4kYuVYNBVw9sX8C5juRpVJNLHg7uFugw2e`
- 需要设置 `THEGRAPH_API_KEY` 环境变量
- 免费额度100k queries/month
- 脚本已存在: `import_kwenta.mjs`

### ❌ Vertex
- 有indexer API但无leaderboard端点
- `prod.vertexprotocol-backend.com/indexer` 不支持leaderboard查询
- 无公开排行榜

### ⚠️ Drift
- 有公开leaderboard页面 (`app.drift.trade/leaderboard`)
- 显示Taker/Maker排名、P&L、Volume
- 但仅显示钱包地址（如 `BxTE…TDvv`），无human-readable names
- 数据来自Solana链上，需要RPC查询
- 技术上可行但数据不适合（无用户名/头像）

### ❌ Perpetual Protocol
- 无排行榜页面或API
- 项目活跃度较低

### ⚠️ Mux Protocol (需要The Graph API Key)
- 使用The Graph subgraph
- Subgraph ID: `7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR`
- 需要设置 `THEGRAPH_API_KEY`
- 脚本已存在: `import_mux.mjs`

## 新增脚本

| 文件 | 状态 |
|------|------|
| `import_btcc.mjs` | ✅ 新写，测试通过 |

## 建议下一步
1. **BTCC已上线** — 虽然只有20个交易员，但数据质量很好
2. **Kwenta + Mux** — 如果申请The Graph API Key（免费），可以立即启用
3. **Drift** — 如果接受仅用钱包地址作为handle，技术上可以实现
4. **其他CEX** — 大部分都关闭了公开API或需要登录，短期内无法添加
