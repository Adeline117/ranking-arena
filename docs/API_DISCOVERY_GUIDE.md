# API Discovery Guide

## 🎯 目标
为21个交易所找到真实的 trader detail API endpoint，解决数据空缺问题。

## 📋 优先级

### P0 (严重缺失 >50%)
- [ ] bingx_spot (78.9% gap)
- [ ] bitget_futures (67.6% gap)
- [ ] htx_futures (59.2% gap)
- [ ] binance_web3 (54.4% gap)

### P1 (需要补充 20-50%)
- [ ] bybit_spot (43.9% gap)
- [ ] bybit (43.6% gap)
- [ ] gateio (43.0% gap)
- [ ] hyperliquid (40.0% gap)
- [ ] dydx (39.2% gap)
- [ ] bingx (38.9% gap)

## 🛠️ 操作流程

### 步骤1: 打开交易所排行榜页面

**示例 (Binance Futures)**:
```
https://www.binance.com/en/futures-activity/leaderboard
```

### 步骤2: 打开 Chrome DevTools

1. 按 `F12` 或 `Cmd+Option+I`
2. 切换到 **Network** tab
3. 筛选 **Fetch/XHR**

### 步骤3: 点击一个 trader profile

在排行榜上点击任意一个交易员，打开他的详情页。

### 步骤4: 在 Network tab 中找到 API 请求

寻找包含以下关键词的请求：
- `detail`
- `performance`
- `stats`
- `profile`
- `trader`
- `leaderboard`

### 步骤5: 复制请求信息

右键点击请求 → **Copy** → **Copy as cURL**

### 步骤6: 记录到文档

使用模板 `docs/exchange-apis/{exchange}.md`

---

## 📝 发现的API清单

| Exchange | API Endpoint | Status |
|----------|-------------|--------|
| binance_futures | `/bapi/futures/v1/public/future/leaderboard/getOtherUserPerformance` | ✅ |
| binance_spot | `/bapi/margin/v1/public/margin/leaderboard/getOtherUserDetail` | ✅ |
| okx_futures | `/api/v5/copytrading/public-current-lead-traders` | ✅ |
| bybit | `/v5/copy-trading/trade-detail/get-others-trade-performance` | ⚠️ (partial) |
| bingx_spot | ❓ | 🔍 |
| bitget_futures | ❓ | 🔍 |
| htx_futures | ❓ | 🔍 |
| binance_web3 | ❓ | 🔍 |
| bybit_spot | ❓ | 🔍 |
| gateio | ❓ | 🔍 |
| hyperliquid | `https://api.hyperliquid.xyz/info` | ✅ (already using) |
| dydx | `https://indexer.dydx.trade/v4/...` | ✅ (already using) |

---

## 💡 提示

### 常见API模式

**Binance系列**:
```
/bapi/{product}/v1/public/{product}/leaderboard/*
```

**OKX系列**:
```
/api/v5/copytrading/public-*
```

**Bybit系列**:
```
/v5/copy-trading/*
```

**Gate.io系列**:
```
/api/v4/futures/contract_traders/*
```

### 难点交易所

**BingX**: 
- 可能需要Puppeteer截获请求
- API可能有签名验证

**Bitget**:
- 可能有WAF保护
- 需要正确的headers

**HTX (Huobi)**:
- API可能已改名
- 检查新域名: `www.htx.com`

---

## 📂 文档模板

见 `docs/exchange-apis/_TEMPLATE.md`

创建新文档时：
```bash
cp docs/exchange-apis/_TEMPLATE.md docs/exchange-apis/bingx-spot.md
```

---

## 🤝 需要协作

Adeline，我会和你一起完成P0的4个交易所：
1. 你打开网页，我指导操作
2. 你复制API请求，我记录文档
3. 我写connector代码，你验证数据

预计时间：
- 每个交易所 15-30分钟
- P0 (4个) = 1-2小时
- P1 (6个) = 2-3小时

开始吧！🚀
