# 交易所现货跟单交易员发现报告

**日期**: 2026-02-14
**调查范围**: 10个交易所
**现有现货平台**: binance_spot, bybit_spot, bitget_spot

---

## 调查结果总览

| 交易所 | 现货跟单 | 状态 | 导入交易员数 | 备注 |
|--------|----------|------|-------------|------|
| OKX | ❌ 无 | N/A | 0 | API返回 `instType=SPOT` 参数错误，只支持 SWAP |
| MEXC | ❌ 无 | N/A | 0 | 跟单页面为 `/futures/copyTrade/home`，纯合约 |
| KuCoin | ❌ 无 | N/A | 0 | 跟单页面只有合约交易员，无Spot标签 |
| **BingX** | ✅ 有 | **已导入** | **68** | `?type=spot` 切换到现货，6页共68个交易员 |
| Gate.io | ⚠️ 名义上有 | 已废弃 | 0 | API存在但41个交易员全部暂停(pause)，零数据 |
| LBank | ❌ 无 | N/A | 0 | 跟单页面描述均为合约术语（保证金、杠杆） |
| Phemex | ❌ 无 | N/A | 0 | 跟单页面为合约交易员 |
| CoinEx | ❌ 无 | N/A | 0 | API `/res/copy-trading/public/traders` 为合约 |
| Weex | ❌ 无 | N/A | 0 | 跟单页面为合约交易员 |
| Toobit | ❌ 无 | N/A | 0 | 跟单页面为合约交易员 |

---

## 详细调查记录

### 1. OKX
- **结论**: 无现货跟单
- **验证方法**: 
  - OKX公开API `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT` 返回 `{"code":"51000","msg":"Parameter instType error"}`
  - 页面 `/copy-trading` 在美国IP下显示 "This product isn't currently available"
  - 现有 `okx_futures` 使用 `instType=SWAP`，SPOT不被支持

### 2. MEXC
- **结论**: 无现货跟单
- **验证方法**: 跟单入口 `mexc.com/futures/copyTrade/home`，页面标题包含"合约"，所有交易员显示合约偏好

### 3. KuCoin
- **结论**: 无现货跟单
- **验证方法**: `kucoin.com/copytrading` 页面只显示合约交易员（57页），无Spot/Futures切换标签

### 4. BingX ✅
- **结论**: **有现货跟单，已成功导入**
- **URL**: `https://bingx.com/en/CopyTrading?type=spot`
- **API**: BingX API受CF保护+签名验证，使用Playwright DOM抓取
- **导入脚本**: `scripts/import/import_bingx_spot.mjs`
- **数据源**: `bingx_spot`
- **导入结果**:
  - 7D: 68 个交易员
  - 30D: 68 个交易员  
  - 90D: 68 个交易员
- **TOP 5 (by ROI)**:
  1. OCD-CAFA: +49.09%, Win Rate 90.07%
  2. The Machine: +41.26%, Win Rate 58.13%
  3. Meta Trader: +34.62%, Win Rate 66.19%
  4. Yoruu: +32.14%, Win Rate 75.00%
  5. MaYSS: +30.71%, Win Rate 100.00%
- **注意**: BingX现货跟单页面不像合约那样有7D/30D/90D时间段切换，显示的是累计数据

### 5. Gate.io
- **结论**: API存在但功能已废弃
- **API**: `/api/copytrade/spot-copy-trading/trader/profit?page=1&page_size=50&order_by=profit_rate&sort_by=desc&cycle=month`
- **数据**: 返回41个交易员，全部状态为`pause`，ROI/PnL/交易数均为0
- **页面**: 跟单页面只有"合约"和"机器人"两个标签，无现货标签

### 6. LBank
- **结论**: 无现货跟单
- **验证方法**: 页面FAQ讨论的全是合约概念（保证金、杠杆、开仓平仓）

### 7. Phemex
- **结论**: 无现货跟单
- **验证方法**: API `api10.phemex.com/phemex-lb/public/data/v3/user/recommend` 为合约交易员

### 8. CoinEx
- **结论**: 无现货跟单
- **验证方法**: API `/res/copy-trading/public/traders` 正常返回但全为合约交易员

### 9. Weex
- **结论**: 无现货跟单
- **验证方法**: 跟单页面显示合约交易员

### 10. Toobit
- **结论**: 无现货跟单
- **验证方法**: 跟单页面为合约交易员

---

## 新增文件

| 文件 | 说明 |
|------|------|
| `scripts/import/import_bingx_spot.mjs` | BingX现货跟单导入脚本 (Playwright DOM抓取) |

## 更新后的现货平台列表

| # | Source | 交易所 | 状态 |
|---|--------|--------|------|
| 1 | binance_spot | Binance | 已有 |
| 2 | bybit_spot | Bybit | 已有 |
| 3 | bitget_spot | Bitget | 已有 |
| 4 | **bingx_spot** | **BingX** | **新增** |

## 结论

在调查的10个交易所中，只有 **BingX** 拥有活跃的现货跟单功能，已成功导入68个交易员。

现货跟单在行业中仍然比较少见，绝大多数交易所的跟单功能仅限于合约/期货交易。Gate.io曾有现货跟单API但该功能已实质性停用。
