# Binance 交易员详情数据设置指南

## 问题说明

交易员主页的以下功能需要额外的数据库表和数据：
- **资产偏好（Asset Breakdown）**：显示交易员的币种分布
- **收益率曲线（Equity Curve）**：显示历史 ROI 和 PnL 图表
- **仓位历史（Position History）**：显示详细的交易记录
- **项目表现详情**：显示夏普比率、跟单者盈亏等

## 设置步骤

### 步骤 1：创建数据库表

在 **Supabase Dashboard** 的 SQL Editor 中运行以下文件的内容：

```
supabase/migrations/00002_binance_trader_details.sql
```

或者直接复制粘贴以下 SQL：

```sql
-- 创建资产偏好表
CREATE TABLE IF NOT EXISTS trader_asset_breakdown (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  weight_pct DECIMAL(10, 4) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE trader_asset_breakdown ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON trader_asset_breakdown FOR SELECT USING (true);
CREATE POLICY "service_insert" ON trader_asset_breakdown FOR INSERT WITH CHECK (true);

-- 创建收益率曲线表
CREATE TABLE IF NOT EXISTS trader_equity_curve (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10) NOT NULL,
  data_date DATE NOT NULL,
  roi_pct DECIMAL(20, 8),
  pnl_usd DECIMAL(20, 8),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE trader_equity_curve ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON trader_equity_curve FOR SELECT USING (true);
CREATE POLICY "service_insert" ON trader_equity_curve FOR INSERT WITH CHECK (true);

-- 创建详细统计表
CREATE TABLE IF NOT EXISTS trader_stats_detail (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  period VARCHAR(10),
  roi DECIMAL(20, 8),
  total_trades INTEGER,
  profitable_trades_pct DECIMAL(10, 4),
  avg_holding_time_hours DECIMAL(10, 2),
  avg_profit DECIMAL(20, 8),
  avg_loss DECIMAL(20, 8),
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4),
  copiers_count INTEGER,
  copiers_pnl DECIMAL(20, 8),
  winning_positions INTEGER,
  total_positions INTEGER,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE trader_stats_detail ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON trader_stats_detail FOR SELECT USING (true);
CREATE POLICY "service_insert" ON trader_stats_detail FOR INSERT WITH CHECK (true);

-- 创建当前持仓表
CREATE TABLE IF NOT EXISTS trader_portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_trader_id VARCHAR(255) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  invested_pct DECIMAL(10, 4),
  entry_price DECIMAL(20, 8),
  pnl DECIMAL(20, 8),
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE trader_portfolio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON trader_portfolio FOR SELECT USING (true);
CREATE POLICY "service_insert" ON trader_portfolio FOR INSERT WITH CHECK (true);
```

### 步骤 2：抓取数据

创建表后，运行数据抓取脚本：

```bash
# 抓取前 10 名交易员的详细数据
node scripts/fetch_binance_trader_details.mjs
```

或使用简化的一键脚本：

```bash
node scripts/setup_and_fetch_details.mjs
```

### 步骤 3：验证

刷新交易员主页，应该可以看到：
- ✅ 资产偏好横条图（可切换 7D/30D/90D）
- ✅ 收益率曲线（可切换 ROI/PnL 和时间段）
- ✅ 仓位历史记录
- ✅ 项目表现详情（夏普比率等）

## 快速测试（可选）

如果你想快速测试 UI，可以插入一些测试数据：

```sql
-- 为指定交易员插入测试资产偏好数据
INSERT INTO trader_asset_breakdown (source, source_trader_id, period, symbol, weight_pct, captured_at) VALUES
('binance', '4772204755407540480', '90D', 'BTCUSDT', 45.5, NOW()),
('binance', '4772204755407540480', '90D', 'ETHUSDT', 28.3, NOW()),
('binance', '4772204755407540480', '90D', 'SOLUSDT', 15.2, NOW()),
('binance', '4772204755407540480', '90D', 'DOGEUSDT', 11.0, NOW());

-- 为指定交易员插入测试收益率曲线数据
INSERT INTO trader_equity_curve (source, source_trader_id, period, data_date, roi_pct, pnl_usd, captured_at) VALUES
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '7 days', 1850.5, 9250.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '6 days', 1920.3, 9600.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '5 days', 2010.8, 10050.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '4 days', 2150.2, 10750.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '3 days', 2280.5, 11400.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '2 days', 2320.1, 11600.0, NOW()),
('binance', '4772204755407540480', '90D', CURRENT_DATE - INTERVAL '1 day', 2370.5, 11850.0, NOW());

-- 为指定交易员插入测试详细统计数据
INSERT INTO trader_stats_detail (source, source_trader_id, period, sharpe_ratio, copiers_count, copiers_pnl, winning_positions, total_positions, captured_at) VALUES
('binance', '4772204755407540480', '90D', 2.85, 1250, 85000.0, 142, 150, NOW());
```

## 注意事项

- 数据抓取脚本使用 Puppeteer，需要安装 Chrome/Chromium
- 首次抓取可能需要几分钟时间
- 建议定期运行抓取脚本以更新数据
