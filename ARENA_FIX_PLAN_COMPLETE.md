# Arena 全平台修复计划 - 完整实施
**日期**: 2026-03-08  
**执行人**: 子代理  
**目标**: 修复所有24个平台，实现100%健康率

---

## ✅ 已完成基础设施

1. Cloudflare Worker 已部署: `https://ranking-arena-proxy.broosbook.workers.dev`
2. VPS Scraper 运行正常: `45.76.152.169:3456` (v13, uptime 613s)
3. 环境变量已配置: `CLOUDFLARE_PROXY_URL`, `VPS_PROXY_KEY`

---

## 📊 平台分类（根据VPS Scraper测试结果）

### Category A: VPS Scraper 可用 ✅ (3个)
1. **Bitget**: 快速响应 (<5s)
2. **MEXC**: 慢响应 (~90s) 但数据完整
3. **CoinEx**: 中等响应 (~60s)

**修复策略**: 更新connector使用VPS Scraper作为primary source

---

### Category B: VPS Scraper 未测试 🔄 (5个)
根据健康检查，VPS支持但未测试：
- BingX
- LBank  
- Gate.io
- BitUnix
- Drift

**修复策略**: 测试VPS endpoints → 如果成功则更新connector

---

### Category C: VPS Scraper 失败 ❌ (3个)
1. **Bybit**: 返回 null
2. **KuCoin**: 404 "APIs not available"
3. **HTX**: 未测试但API调查报告显示完全失败

**修复策略**: 实施浏览器自动化（Playwright/Puppeteer）

---

### Category D: 其他平台 (13个)
- Binance (futures/spot/web3) - Cloudflare Worker proxy
- OKX (futures/wallet)
- Bitmart, Phemex, Weex - 待测试
- GMX, dYdX, Hyperliquid - DEX perps
- Gate.io, BloFin
- Nansen, Dune (enrichment)

**修复策略**: 根据测试结果决定（API/Proxy/Scraper/Browser）

---

## 🚀 实施步骤

### Phase 1: VPS Scraper 集成（Category A）✅ 优先级 P0

#### 1.1 Bitget Connector
```bash
# 检查现有connector
cat ~/ranking-arena/connectors/bitget/index.ts

# 添加VPS scraper fallback
# fetchViaVPS(endpoint: string, params: Record<string, any>)
```

#### 1.2 MEXC Connector  
```bash
# 更新connector使用VPS scraper
# 设置timeout=120s (因为响应慢)
```

#### 1.3 CoinEx Connector
```bash
# 添加VPS scraper支持
# timeout=90s
```

**预计时间**: 2-3小时  
**验证**: 运行 `npx tsx scripts/test-new-scrapers-simple.ts <platform>`

---

### Phase 2: 测试未验证的VPS endpoints（Category B）

```bash
# 批量测试脚本
ssh root@45.76.152.169 "
  curl -H 'X-Proxy-Key: arena-proxy-sg-2026' localhost:3456/bingx/leaderboard?pageIndex=1
  curl -H 'X-Proxy-Key: arena-proxy-sg-2026' localhost:3456/lbank/leaderboard?page=1
  curl -H 'X-Proxy-Key: arena-proxy-sg-2026' localhost:3456/gateio/leaderboard?page=1
"
```

**预计时间**: 1小时测试 + 2小时集成（如果成功）

---

### Phase 3: 浏览器自动化（Category C）⚠️ 高难度

#### 3.1 创建 Playwright 基础设施
```bash
# 安装依赖
npm install playwright playwright-extra puppeteer-extra-plugin-stealth

# 创建基类: scripts/scrapers/base-browser-scraper.ts
# 特性：
# - Stealth模式（绕过bot detection）
# - 失败重试
# - Screenshot on error
# - Cookie/Session管理
```

#### 3.2 Bybit Browser Scraper
```typescript
// scripts/scrapers/bybit-playwright.ts
// 1. 导航到 https://www.bybit.com/copyTrading/traderRanking
// 2. 等待leaderboard加载
// 3. 拦截XHR请求或解析DOM
// 4. 提取trader数据
```

#### 3.3 KuCoin Browser Scraper  
```typescript
// scripts/scrapers/kucoin-playwright.ts
// 类似Bybit
```

#### 3.4 HTX Browser Scraper
```typescript
// scripts/scrapers/htx-playwright.ts  
// HTX可能需要额外的反检测措施
```

**预计时间**: 8-12小时（2-4小时/平台）  
**风险**: 高 - 平台可能频繁更新DOM/API

---

### Phase 4: 测试验证所有平台

```bash
# 运行完整测试
npx tsx scripts/test-all-platforms.ts

# 预期结果: 24/24 platforms healthy
```

---

### Phase 5: 自动化监控

```bash
# 创建监控脚本
cat > ~/ranking-arena/scripts/platform-health-monitor.ts << 'EOF'
// 每小时检查所有平台健康状态
// 失败时发送Telegram警报
// 记录到日志
EOF

# 部署cron (Mac Mini)
crontab -l | { cat; echo "0 * * * * cd ~/ranking-arena && npx tsx scripts/platform-health-monitor.ts"; } | crontab -

# 或部署到VPS
ssh root@45.76.152.169 "echo '0 * * * * cd /opt/arena && node scripts/platform-health-monitor.js' | crontab -"
```

**预计时间**: 2-3小时

---

### Phase 6: Git提交和文档

```bash
git add .
git commit -m "feat: 全平台修复完成 - 24/24平台健康

- ✅ 集成VPS Scraper (Bitget/MEXC/CoinEx等)
- ✅ 实施浏览器自动化 (Bybit/KuCoin/HTX)
- ✅ 更新Cloudflare Worker
- ✅ 部署自动化监控
- ✅ 所有平台数据<24小时更新
"

git push origin main
```

---

## 📈 时间线估算

| Phase | 任务 | 预计时间 | 状态 |
|-------|------|---------|------|
| 0 | 基础设施 (Worker/VPS) | 7分钟 | ✅ 完成 |
| 1 | VPS Scraper集成 (Category A) | 2-3小时 | 🔄 进行中 |
| 2 | 测试Category B平台 | 3小时 | ⏸️ 待开始 |
| 3 | 浏览器自动化 (Category C) | 8-12小时 | ⏸️ 待开始 |
| 4 | 其他平台修复 (Category D) | 4-6小时 | ⏸️ 待开始 |
| 5 | 测试验证 | 2小时 | ⏸️ 待开始 |
| 6 | 监控部署 | 3小时 | ⏸️ 待开始 |
| 7 | Git提交文档 | 1小时 | ⏸️ 待开始 |
| **总计** | **全部完成** | **23-34小时** | **3-4天** |

---

## 🎯 成功标准

- ✅ 24个平台全部健康（非失败/降级）
- ✅ 所有数据<24小时更新  
- ✅ 自动监控运行
- ✅ 完整文档和Git提交
- ✅ VPS Scraper + Browser Automation混合架构稳定运行

---

## 📝 技术债务和后续工作

1. **Browser scraper维护**: 平台UI变更时需要更新
2. **VPS Scraper扩展**: 可能需要更多VPS节点（如果流量增加）
3. **数据质量监控**: 检测异常数据和API返回格式变化
4. **Cost优化**: Playwright headless vs headful，代理池成本

---

**下一步**: 立即开始 Phase 1 - VPS Scraper集成
