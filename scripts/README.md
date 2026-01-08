# 数据导入脚本说明

## 🚀 主要使用的脚本（由 Cron Job 自动运行）

### 数据导入脚本
以下脚本由 `app/api/cron/fetch-traders/route.ts` 自动调用：

1. **`import_binance_copy_trading_90d.mjs`** - Binance 90天 ROI 数据导入
2. **`fetch_binance_web3_all_pages.mjs`** - Binance Web3 数据导入
3. **`import_bybit_90d_roi.mjs`** - Bybit 90天 ROI 数据导入
4. **`import_bitget_90d_roi.mjs`** - Bitget 90天 ROI 数据导入
5. **`import_mexc_90d_roi.mjs`** - MEXC 90天 ROI 数据导入
6. **`import_coinex_90d_roi.mjs`** - CoinEx 90天 ROI 数据导入

### 工具脚本
- **`setup_supabase_tables.sql`** - 数据库表结构和 RLS 策略配置
- **`test_auth_and_posts.mjs`** - 测试认证和发帖功能
- **`verify_supabase_setup.mjs`** - 验证 Supabase 配置是否正确

## 📝 使用说明

### 手动运行数据导入脚本
```bash
# Binance 90天数据
node scripts/import_binance_copy_trading_90d.mjs

# Binance Web3 数据
node scripts/fetch_binance_web3_all_pages.mjs

# Bybit 90天数据
node scripts/import_bybit_90d_roi.mjs

# Bitget 90天数据
node scripts/import_bitget_90d_roi.mjs

# MEXC 90天数据
node scripts/import_mexc_90d_roi.mjs

# CoinEx 90天数据
node scripts/import_coinex_90d_roi.mjs
```

### 测试和验证
```bash
# 测试认证和发帖功能
node scripts/test_auth_and_posts.mjs

# 验证 Supabase 配置
node scripts/verify_supabase_setup.mjs
```

## 🗑️ 已删除的废弃脚本

以下脚本已被删除（功能已合并或不再需要）：
- `import_binance_copy_trading.mjs` - 功能已合并到 `import_binance_copy_trading_90d.mjs`
- `import_binance_from_json.mjs` - 不再使用
- `import_binance_leaderboard.mjs` - 不再使用
- `import_binance_web3_leaderboard.mjs` - 功能已合并到 `fetch_binance_web3_all_pages.mjs`
- `import_bybit_leaderboard.mjs` - 功能已合并到 `import_bybit_90d_roi.mjs`
- `import_from_json.mjs` - 不再使用
- `scrape_binance_copy_trading_v2.mjs` - 不再使用
- `scrape_binance_web3.mjs` - 不再使用
- `find_binance_copy_trading_api.mjs` - 不再使用
- `find_binance_web3_api.mjs` - 不再使用
- `cleanup_old_traders.mjs` - 不再使用
- `keep_only_top100.mjs` - 不再使用
- `update_traders_weekly.ts` - 不再使用

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



