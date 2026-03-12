# Onchain Trader Enrichment System

## 概述

补全所有链上交易员的 `win_rate` 和 `max_drawdown` 指标。

## 脚本

### 主脚本: `enrich-onchain-all.mjs`

**用途**: 从各平台API/链上数据获取交易历史，计算缺失指标

**支持平台**:
1. ✅ **Hyperliquid** - API可用 (4069 traders, 69% 缺失 win_rate)
2. ✅ **Aevo** - API可用 (1170 traders, 100% 缺失)
3. ✅ **Gains Network** - The Graph可用 (602 traders, 21% 缺失 win_rate)
4. ✅ **GMX** - The Graph可用 (3607 traders, 78% 缺失 max_drawdown)
5. ⚠️ **dYdX** - Indexer API部分可用 (2514 traders, 98% 缺失)
6. ⚠️ **Drift** - 需SDK集成 (2158 traders, 100% 缺失)
7. ⚠️ **Jupiter Perps** - API端点未公开 (2755 traders, 55% 缺失)

**用法**:
```bash
# 运行单个平台
node scripts/enrich-onchain-all.mjs --platform=hyperliquid --batch=100

# Dry-run测试
node scripts/enrich-onchain-all.mjs --platform=aevo --batch=10 --dry-run

# 运行所有平台
node scripts/enrich-onchain-all.mjs --batch=200
```

**参数**:
- `--platform=<name>`: 只处理指定平台
- `--batch=<n>`: 每批处理数量 (默认: 100)
- `--dry-run`: 测试模式，不写数据库

### 辅助脚本

**`test-onchain-apis.mjs`**: 测试所有平台API是否可用
```bash
node scripts/test-onchain-apis.mjs
```

**`monitor-enrichment.sh`**: 监控enrichment进度
```bash
./scripts/monitor-enrichment.sh
```

**`cron/enrich-onchain.sh`**: Cron定时任务
```bash
# 每6小时运行一次
0 */6 * * * ~/arena/scripts/cron/enrich-onchain.sh
```

## 数据源

### Hyperliquid
- **API**: `https://api.hyperliquid.xyz/info`
- **方法**: POST请求获取 userFills 和 ledger updates
- **计算**: 
  - win_rate: 从fills计算盈利交易占比
  - max_drawdown: 从账户值历史计算最大回撤

### Aevo
- **API**: `https://api.aevo.xyz/statistics?account={address}`
- **方法**: GET请求获取trader统计
- **直接提供**: win_rate, max_drawdown

### Gains Network
- **数据源**: The Graph subgraph
- **端点**: `https://api.thegraph.com/subgraphs/name/gainsnetwork/gtrade-stats`
- **查询**: GraphQL查询trader数据

### GMX
- **数据源**: The Graph subgraph
- **端点**: `https://api.thegraph.com/subgraphs/name/gmx-io/gmx-stats`
- **计算**: 从历史positions计算max_drawdown

### dYdX v4
- **API**: `https://indexer.dydx.trade/v4/fills`
- **挑战**: 需要subaccount编号，PnL计算复杂
- **状态**: 部分实现

### Drift (Solana)
- **API**: `https://data.api.drift.trade`
- **挑战**: 需要SDK集成或on-chain数据分析
- **状态**: 待实现

### Jupiter Perps (Solana)
- **挑战**: 公开API端点未找到
- **状态**: 待研究

## 数据库

**表**: `leaderboard_ranks`

**关键字段**:
- `source`: 平台名称
- `source_trader_id`: 交易员地址/ID
- `win_rate`: 胜率 (0-100%)
- `max_drawdown`: 最大回撤 (0-100%)

## 当前进度

运行 `./scripts/monitor-enrichment.sh` 查看实时进度。

初始状态 (2026-03-11):
```
Source          | Total | WR Null | MDD Null | WR%  | MDD%
hyperliquid     |  4069 |    2821 |     3103 | 69.3 | 76.3
gmx             |  3607 |       3 |     2820 |  0.1 | 78.2
jupiter_perps   |  2755 |    1506 |     1935 | 54.7 | 70.2
dydx            |  2514 |    2459 |     2407 | 97.8 | 95.7
drift           |  2158 |    2158 |     2158 |100.0 |100.0
aevo            |  1170 |    1170 |     1170 |100.0 |100.0
gains           |   602 |     124 |      597 | 20.6 | 99.2
```

## 故障排查

### API访问失败
```bash
# 测试API连通性
node scripts/test-onchain-apis.mjs
```

### 数据库连接问题
```bash
# 测试数据库连接
PGPASSWORD='j0qvCCZDzOHDfBka' psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres -c "SELECT 1"
```

### Numeric overflow错误
- 已添加数据验证，将win_rate和max_drawdown限制在0-100%范围内

### Rate limiting
- 每个请求间隔200-500ms
- 平台间间隔2-30秒

## 部署到VPS

### Singapore VPS (45.76.152.169)

1. **传输脚本**:
```bash
scp ~/arena/scripts/enrich-onchain-all.mjs root@45.76.152.169:/opt/arena/scripts/
scp ~/arena/scripts/cron/enrich-onchain.sh root@45.76.152.169:/opt/arena/scripts/cron/
```

2. **添加cron**:
```bash
ssh root@45.76.152.169
crontab -e
# 添加:
0 */6 * * * /opt/arena/scripts/cron/enrich-onchain.sh
```

3. **测试运行**:
```bash
ssh root@45.76.152.169 'cd /opt/arena && node scripts/enrich-onchain-all.mjs --platform=hyperliquid --batch=10 --dry-run'
```

## 下一步

1. ✅ **立即**: 完成Hyperliquid、Aevo、Gains、GMX的enrichment
2. ⚠️ **短期**: 修复dYdX API集成
3. ⚠️ **中期**: 集成Drift SDK
4. ⚠️ **长期**: 研究Jupiter Perps数据获取方案
5. ✅ **部署**: 添加到VPS cron (每6小时)

## 维护

- 每周检查API可用性
- 监控enrichment覆盖率
- 定期清理日志文件
- 更新API端点（如有变更）

---

**创建时间**: 2026-03-11  
**负责人**: 小昭 (AI Assistant)  
**优先级**: URGENT
