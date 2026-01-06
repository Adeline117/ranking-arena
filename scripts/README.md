# 数据导入脚本说明

## 主要使用的脚本

### Binance Web3 数据导入
- **`fetch_binance_web3_all_pages.mjs`** - 获取所有页面的 Binance Web3 数据并导入
- **`import_binance_web3_leaderboard.mjs`** - 导入 Binance Web3 排行榜数据
- **`scrape_binance_web3.mjs`** - 使用 Puppeteer 抓取 Binance Web3 数据
- **`find_binance_web3_api.mjs`** - 查找 Binance Web3 API 端点

### Binance Copy Trading 数据导入
- **`import_binance_copy_trading_90d.mjs`** - 导入 Binance Copy Trading 90天 ROI 数据（主要使用）
- **`import_binance_copy_trading.mjs`** - 导入 Binance Copy Trading 数据
- **`scrape_binance_copy_trading_v2.mjs`** - 使用 Puppeteer 抓取 Binance Copy Trading 数据（v2版本）
- **`find_binance_copy_trading_api.mjs`** - 查找 Binance Copy Trading API 端点

### 通用导入脚本
- **`import_from_json.mjs`** - 通用 JSON 数据导入脚本
- **`import_binance_from_json.mjs`** - 从 JSON 文件导入 Binance 数据

### 数据维护脚本
- **`cleanup_old_traders.mjs`** - 清理旧交易员数据
- **`keep_only_top100.mjs`** - 只保留 ROI 前 100 的交易员

### 其他数据源
- **`import_binance_leaderboard.mjs`** - 导入 Binance 排行榜数据
- **`import_bybit_leaderboard.mjs`** - 导入 Bybit 排行榜数据
- **`update_traders_weekly.ts`** - 每周更新交易员数据

## 已删除的重复/废弃脚本

以下脚本已被删除（功能已合并到其他脚本中）：
- `scrape_binance_copy_trading.mjs` - 旧版本，已被 v2 替代
- `fetch_binance_90d_leaderboard.mjs` - 功能已合并到 `import_binance_copy_trading_90d.mjs`
- `fetch_binance_copy_trading_full.mjs` - 功能重复
- `fetch_binance_copy_trading_leaderboard.mjs` - 功能重复
- `capture_api_url.mjs` - 功能已合并到 `find_binance_web3_api.mjs`
- `capture_binance_copy_trading_api.mjs` - 功能已合并到 `find_binance_copy_trading_api.mjs`
- `find_binance_90d_roi_api.mjs` - 功能已合并到 `import_binance_copy_trading_90d.mjs`

## 使用说明

### 导入 Binance Web3 数据
```bash
node scripts/fetch_binance_web3_all_pages.mjs
```

### 导入 Binance Copy Trading 90天 ROI 数据
```bash
node scripts/import_binance_copy_trading_90d.mjs
```

### 从 JSON 文件导入数据
```bash
node scripts/import_binance_from_json.mjs path/to/data.json
```

### 清理旧数据
```bash
node scripts/cleanup_old_traders.mjs
```

