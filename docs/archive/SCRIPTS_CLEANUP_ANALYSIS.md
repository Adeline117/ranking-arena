# Scripts 目录清理分析

审计日期: 2026-01-21

## 目录结构

```
scripts/
├── import/           # 交易所数据导入脚本 (14 files)
├── lib/             # 共享库
├── maintenance/     # 维护脚本 (6 files)
├── shell/           # Shell 脚本
├── sql/             # SQL 脚本
└── test/            # 测试脚本
```

---

## 潜在冗余脚本分析

### 1. Import 目录 - 版本重复

| 旧版本 | 新版本 (v2) | 文件大小对比 | 建议 |
|--------|-------------|-------------|------|
| `import_bitget_futures.mjs` (10KB) | `import_bitget_futures_v2.mjs` (17KB) | v2 更大 | 保留 v2，归档旧版 |
| `import_bitget_spot.mjs` (9KB) | `import_bitget_spot_v2.mjs` (16KB) | v2 更大 | 保留 v2，归档旧版 |

**分析**: v2 版本文件更大，可能包含更完整的功能。建议：

1. 确认 v2 版本功能完整且稳定
2. 将旧版本移动到 `scripts/archive/` 目录
3. 更新任何引用旧版本的配置

---

### 2. Import 目录 - API vs Scrape 版本

| 文件 | 类型 | 建议 |
|------|------|------|
| `import_binance_futures.mjs` (22KB) | Scraping | 保留（主要数据源） |
| `import_binance_futures_api.mjs` (11KB) | API | 保留（API 备选） |

**分析**: API 版本可能是用于直接 API 调用，Scraping 版本用于网页抓取。两者服务不同场景，建议都保留。

---

### 3. 其他 Import 脚本

以下脚本各有独立功能，无冗余：

- `import_binance_spot.mjs` - Binance 现货
- `import_binance_web3.mjs` - Binance Web3
- `import_bybit.mjs` - Bybit 交易所
- `import_coinex.mjs` - CoinEx 交易所
- `import_gmx.mjs` - GMX DEX
- `import_kucoin.mjs` - KuCoin 交易所
- `import_mexc.mjs` - MEXC 交易所
- `import_okx_web3.mjs` - OKX Web3

---

### 4. Maintenance 脚本分析

| 脚本 | 功能 | 使用频率 | 建议 |
|------|------|----------|------|
| `calculate_arena_scores.mjs` | 计算 Arena 评分 | 定期 | 保留 |
| `check_data.mjs` | 数据检查 | 按需 | 保留 |
| `cleanup_data.mjs` | 数据清理 | 按需 | 保留 |
| `cleanup_old_snapshots.mjs` | 清理旧快照 | 定期 | 保留 |
| `parallel_scrape.mjs` | 并行抓取 | 定期 | 保留 |
| `run_migration.mjs` | 运行迁移 | 部署时 | 保留 |

**分析**: 所有 maintenance 脚本功能独立，无冗余。

---

## 建议操作

### 短期（可立即执行）

1. **创建归档目录**
   ```bash
   mkdir -p scripts/archive
   ```

2. **移动旧版 Bitget 脚本**
   ```bash
   mv scripts/import/import_bitget_futures.mjs scripts/archive/
   mv scripts/import/import_bitget_spot.mjs scripts/archive/
   ```

3. **重命名 v2 版本**（移除 _v2 后缀）
   ```bash
   mv scripts/import/import_bitget_futures_v2.mjs scripts/import/import_bitget_futures.mjs
   mv scripts/import/import_bitget_spot_v2.mjs scripts/import/import_bitget_spot.mjs
   ```

### 长期

1. **统一脚本参数**
   - 所有 import 脚本应接受统一的命令行参数
   - 例如: `--limit`, `--offset`, `--dry-run`, `--verbose`

2. **添加脚本入口**
   - 创建 `scripts/import/index.mjs` 作为统一入口
   - 支持: `node scripts/import/index.mjs --exchange=binance --type=futures`

3. **文档化脚本用法**
   - 每个脚本添加 `--help` 选项
   - 创建 `scripts/README.md` 文档

---

## 清理风险评估

| 操作 | 风险等级 | 回滚方案 |
|------|----------|----------|
| 移动旧版脚本到 archive | 低 | 直接移回 |
| 重命名 v2 脚本 | 中 | 检查 cron/vercel.json 引用 |
| 删除脚本 | 高 | 从 git 恢复 |

**建议**: 先移动到 archive 目录观察一周，确认无问题后再考虑删除。

---

## 不建议清理的文件

以下文件虽然名称相似但功能不同，不应清理：

- `import_binance_futures.mjs` vs `import_binance_futures_api.mjs` - 不同数据获取方式
- `check_data.mjs` vs `cleanup_data.mjs` - 检查 vs 清理，功能互补

---

最后更新: 2026-01-21
