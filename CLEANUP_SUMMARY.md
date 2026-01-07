# 项目清理总结

## 已删除的重复/废弃文件

### 脚本文件（scripts/）
1. ✅ `scrape_binance_copy_trading.mjs` - 旧版本，已被 `scrape_binance_copy_trading_v2.mjs` 替代
2. ✅ `fetch_binance_90d_leaderboard.mjs` - 功能已合并到 `import_binance_copy_trading_90d.mjs`
3. ✅ `fetch_binance_copy_trading_full.mjs` - 功能重复
4. ✅ `fetch_binance_copy_trading_leaderboard.mjs` - 功能重复
5. ✅ `capture_api_url.mjs` - 功能已合并到 `find_binance_web3_api.mjs`
6. ✅ `capture_binance_copy_trading_api.mjs` - 功能已合并到 `find_binance_copy_trading_api.mjs`
7. ✅ `find_binance_90d_roi_api.mjs` - 功能已合并到 `import_binance_copy_trading_90d.mjs`

### 文档文件
8. ✅ `TEST_SUMMARY.md` - 临时测试文档

### 临时数据文件
9. ✅ 所有根目录下的 `binance_*.json` 文件已移动到 `data/backup/` 目录

## 保留的重要脚本

### Binance Web3
- `fetch_binance_web3_all_pages.mjs` - 获取所有页面数据
- `import_binance_web3_leaderboard.mjs` - 导入排行榜数据
- `scrape_binance_web3.mjs` - Puppeteer 抓取
- `find_binance_web3_api.mjs` - API 端点发现

### Binance Copy Trading
- `import_binance_copy_trading_90d.mjs` - **主要使用** - 导入 90 天 ROI 数据
- `import_binance_copy_trading.mjs` - 通用导入
- `scrape_binance_copy_trading_v2.mjs` - Puppeteer 抓取（v2）
- `find_binance_copy_trading_api.mjs` - API 端点发现

### 通用工具
- `import_from_json.mjs` - 通用 JSON 导入
- `import_binance_from_json.mjs` - Binance JSON 导入
- `cleanup_old_traders.mjs` - 清理旧数据
- `keep_only_top100.mjs` - 保留前 100 名

## 路由结构

### 当前使用的路由
- `/trader/[handle]` - 交易员主页（主要路由，从排行榜链接）
- `/u/[handle]` - 用户主页（已注册用户）
- `/user/[id]` - 用户页面（可能仍在使用）

### 可能废弃的路由
- `/trader/[handle]/[id]` - 旧版本路由，使用旧的 `traders` 表

## 优化建议

1. **脚本组织**：已创建 `scripts/README.md` 说明各脚本用途
2. **数据文件**：临时 JSON 文件已移动到 `data/backup/` 目录
3. **路由优化**：考虑统一路由结构，但需要确认所有链接都已更新

## 下一步

如需进一步优化：
1. 检查并统一路由结构（`/trader/[handle]` vs `/u/[handle]`）
2. 确认 `/trader/[handle]/[id]` 和 `/user/[id]` 是否仍在使用
3. 考虑将 `import_from_json.mjs` 和 `import_binance_from_json.mjs` 合并



