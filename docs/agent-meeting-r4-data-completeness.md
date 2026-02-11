# Agent Team Meeting R4 — 全面数据补全
Date: 2026-02-11 13:15 PST

## 目标
所有交易员概览页三个时间段数据完整：ROI、PnL、胜率、最大回撤、交易次数、持仓数据

## 当前缺口（90D为例）
| 指标 | 有数据 | 总计 | 覆盖率 |
|------|--------|------|--------|
| ROI | 13,298 | 15,150 | 87.8% |
| PnL | 12,347 | 15,150 | 81.5% |
| Win Rate | 8,806 | 15,150 | 58.1% |
| Max Drawdown | 7,551 | 15,150 | 49.8% |
| Trades Count | 1,999 | 15,150 | 13.2% |

## 严重缺数据的平台
- bitfinex: 265人，ROI=0（只有排名序号）
- gains: 636人，只77人有ROI（12%）
- bitget_futures: 309人，只162人有ROI
- kucoin: 256人，只98人有ROI
- web3_bot: 48人，只3人有ROI
- binance_web3: 0 drawdown, 0 trades
- aevo: 0 win_rate, 0 drawdown
- phemex: 0 win_rate, 0 drawdown

## Agent分配（5波×2并发）

### Wave 1: CEX Detail API补全
- **Agent A**: Binance系 — binance_futures补trades_count, binance_web3补drawdown, binance_spot补win_rate
- **Agent B**: Bybit/Bitget系 — bitget_futures补ROI+WR+DD, bybit补DD

### Wave 2: CEX Detail API补全（续）
- **Agent C**: OKX/HTX/Gate — okx_web3补WR+DD, gateio补DD
- **Agent D**: Phemex/BTCC/CoinEx/LBank — 补win_rate+drawdown

### Wave 3: DEX补全
- **Agent E**: Hyperliquid — 补trades缺失的1670人
- **Agent F**: GMX/Jupiter/dYdX/Aevo — 补WR+DD

### Wave 4: 问题平台重写
- **Agent G**: Bitfinex重写 — 需要从排名API获取真实ROI/PnL数据
- **Agent H**: Gains重写 — 从合约/API获取完整ROI数据

### Wave 5: 统计补全
- **Agent I**: 全平台trades_count补全 — 从detail API批量获取
- **Agent J**: Position data扩展 — OKX/Bybit/Bitget持仓数据

## 规则
- 最多2-3个agent同时跑
- 每个agent必须列出DO NOT TOUCH清单
- 数据只能UPDATE补充，不能DELETE
- 跑完必须报告补全前后对比数据
