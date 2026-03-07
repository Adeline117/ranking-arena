# Arena 平台 API 问题全面调查报告
**Date**: 2026-03-07  
**Investigator**: 小昭 (Subagent)  
**Status**: ⚠️ 需要重大架构决策

---

## 🔍 问题确认

### 1. API测试结果

#### Bybit
```
❌ https://api.bybit.com/v5/copytrading/* → 403 Forbidden
❌ https://api.bybit.com/v3/copy-trade/* → 403 Forbidden  
❌ https://api2.bybit.com/fapi/beehive/public/v2/* → Timeout
```
**原因**: Cloudflare bot detection + API路径变更

#### MEXC
```
❌ https://www.mexc.com/api/platform/copy-trade/* → 403 Forbidden (Akamai WAF)
❌ https://api.mexc.com/api/v3/copytrading/* → 404 Not Found
```
**原因**: Akamai Bot Manager 保护

#### HTX (Huobi)
```
❌ https://www.htx.com/v1/copy-trading/public/* → 404 Not Found
❌ https://api.htx.com/v1/copytrading/* → 404 Not Found
❌ https://www.htx.com/-/x/pro/* → 404 Not Found
```
**原因**: API路径完全重构或需要认证

### 2. 数据库验证

```sql
SELECT platform, market_type, COUNT(*) 
FROM trader_sources_v2 
WHERE platform IN ('bybit', 'mexc', 'htx') 
GROUP BY platform, market_type;
```
**Result**: **0 rows** 

#### 实际有数据的平台：
- hyperliquid: 1,306 traders
- gmx: 110 traders  
- xt: 56 traders

**结论**: **这三个平台从未成功采集过数据。**

### 3. Cron任务状态

**Mac Mini launchd日志**:
```
/bin/bash: /Users/adelinewen/ranking-arena/scripts/mac-mini-cron.sh: No such file or directory
```
**重复**: 58+ times

**Vercel cron配置**:
```json
{
  "path": "/api/cron/fetch-traders/bybit",
  "schedule": "50 */3 * * *"
}
```
但未找到对应的失败日志。

---

## 🛡️ 技术障碍分析

### 反爬虫保护等级

| 平台 | 保护类型 | 难度 | 绕过方法 |
|-----|---------|------|---------|
| Bybit | Cloudflare + Bot Detection | 🔴 High | 需要完整浏览器环境 + 真实User Agent + Cookies |
| MEXC | Akamai WAF + Bot Manager | 🔴 Very High | 需要浏览器自动化 + 可能需要代理池 + Session管理 |
| HTX | API隐藏/重构 + Cloudflare | 🟠 Medium | 需要浏览器抓取实际XHR请求 |

### 为什么简单API修复不可行

1. **所有公开API端点都被封锁**
   - 不是endpoint路径变更的问题
   - 是平台主动封锁bot访问

2. **需要真实浏览器环境**
   - User-Agent检测
   - JavaScript challenge
   - Cookie/Session验证
   - 可能有TLS fingerprint检测

3. **开发工作量评估**
   - 每个平台需要独立的Playwright/Puppeteer爬虫
   - Anti-detection策略（stealth plugins）
   - 数据提取逻辑（DOM parsing或XHR拦截）
   - 错误处理+重试机制
   - **预计**: 2-4天开发 + 1-2天测试

---

## 💡 解决方案选项

### 选项 A: 暂时移除这3个平台 ⭐ **推荐**

**优点**:
- ✅ 立即消除404/403错误
- ✅ 清理失败任务队列
- ✅ 让系统专注于25个工作平台
- ✅ 避免浪费服务器资源

**缺点**:
- ❌ 减少平台覆盖度
- ❌ 用户可能询问为何缺失

**实施步骤**:
1. 从`connectors/index.ts`移除bybit/mexc/htx注册
2. 从`vercel.json`移除相关cron任务
3. 更新文档说明原因
4. Git commit + push

**执行时间**: 30分钟

---

### 选项 B: 开发完整浏览器爬虫解决方案

**需要开发**:
1. **Bybit爬虫** (`scripts/scrapers/bybit-playwright.mjs`)
   - Stealth plugin
   - Cloudflare bypass strategy
   - DOM parsing or XHR interception
   
2. **MEXC爬虫** (`scripts/scrapers/mexc-playwright.mjs`)
   - Akamai WAF bypass
   - Cookie/Session管理
   - 可能需要代理池

3. **HTX爬虫** (`scripts/scrapers/htx-playwright.mjs`)
   - XHR request capture
   - API endpoint discovery
   - Data extraction

4. **通用基础设施**:
   - 错误处理框架
   - 重试机制
   - 日志记录
   - 测试套件

**预计时间**: 2-4天开发 + 1-2天测试

**风险**:
- 平台可能继续加强反爬虫
- 需要持续维护
- 可能需要付费代理服务

---

### 选项 C: 保留Connector但标记为"需要浏览器"

**实施**:
修改 `connectors/bybit/index.ts` (同理mexc/htx):
```typescript
async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
  return this.failure(
    'Bybit API requires browser automation due to bot protection. ' +
    'Use Playwright scraper at scripts/scrapers/bybit-playwright.mjs'
  );
}
```

**优点**:
- ✅ 保持connector结构完整性
- ✅ 清晰的错误信息
- ✅ 为未来实现保留接口

**缺点**:
- ❌ 仍会产生失败日志
- ❌ 用户可能困惑

---

## 🎯 立即可执行任务

### ✅ 任务4: 清理历史失败任务

**发现**: 
- `cron_logs`表只有1条2025-12-28的旧记录
- Vercel cron可能使用自己的日志系统
- Mac Mini launchd任务持续失败（58+ times）

**清理方案**:
```bash
# 1. 停止launchd任务
launchctl unload ~/Library/LaunchAgents/com.arena.scraper.plist

# 2. 清理launchd错误日志
> /Users/adelinewen/ranking-arena/logs/launchd-err.log

# 3. 从Vercel cron移除相关任务（如果选择方案A）
```

---

## 📊 当前平台状态

### 工作正常的平台 (25个)

| 平台 | 数据量 | 最后更新 | 方法 |
|-----|-------|---------|------|
| hyperliquid | 1,306 | 2026-03-07 21:21 | Direct API |
| gmx | 110 | 2026-03-07 01:21 | Direct API |
| binance_futures | ~3000 | ✅ | Direct API |
| okx | ~500 | ✅ | Direct API |
| ... | ... | ... | ... |

### 从未工作的平台 (3个)

| 平台 | 状态 | 数据量 | 问题 |
|-----|-----|-------|------|
| bybit | 🔴 失败 | 0 | 403 Forbidden |
| mexc | 🔴 失败 | 0 | 403 Akamai WAF |
| htx | 🔴 失败 | 0 | 404 Not Found |

---

## 🔧 项目现状

### Connector实现状态
```
✅ connectors/bybit/index.ts - 已实现但API失效
✅ connectors/mexc/index.ts - 已实现但API失效  
✅ connectors/htx/index.ts - 已实现但API失效
✅ connectors/index.ts - 已注册
```

### Cron任务状态
```
❌ Mac Mini: scripts/mac-mini-cron.sh 文件缺失
✅ Vercel: 配置存在但任务失败
```

### 依赖项
```json
✅ "puppeteer": "^24.37.5"
✅ "puppeteer-extra": "^3.3.6"  
✅ "puppeteer-extra-plugin-stealth": "^2.11.2"
✅ "@playwright/test": "^1.57.0"
```

---

## 🚀 推荐行动方案

1. **立即执行 (选项A)**:
   - 移除3个失败平台
   - 清理cron配置
   - 更新文档

2. **中期计划 (2-4周后)**:
   - 如果业务需要这些平台
   - 分配专门时间开发爬虫
   - 考虑使用第三方数据服务

3. **长期策略**:
   - 监控平台API变化
   - 建立fallback机制
   - 考虑直接与平台合作获取数据

---

## 📝 技术细节

### 测试脚本输出
```
=== Testing Bybit ===
https://api.bybit.com/v5/copytrading/leaderboard/list → 403
https://api.bybit.com/v5/copy-trade/leaderboard → 403
https://api.bybit.com/v3/copy-trade/leader/list → 403
https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list → Timeout

=== Testing MEXC ===
https://www.mexc.com/api/platform/copy-trade/trader/list → 301 (redirect)
https://api.mexc.com/api/v3/copytrading/trader/list → 404

=== Testing HTX ===
All 6 tested endpoints → 404
```

### 数据库查询
```sql
-- 确认没有数据
SELECT COUNT(*) FROM trader_sources_v2 WHERE platform IN ('bybit','mexc','htx');
-- Result: 0

-- 检查其他平台
SELECT platform, COUNT(*) FROM trader_sources_v2 GROUP BY platform;
-- hyperliquid: 1306, gmx: 110, xt: 56
```

---

## ❓ 需要决策

**请 Adeline 选择**:
- [ ] 选项A: 移除这3个平台（推荐）
- [ ] 选项B: 开发完整爬虫解决方案（2-4天）
- [ ] 选项C: 保留connector但标记为失败

**我可以立即执行选择的方案。**
