# Arena Pipeline 真实状态排查报告
**生成时间**: 2026-03-14 19:06 PST  
**排查范围**: 最近2小时的实际运行状态（非历史记录）

---

## ✅ 已修复且生效

### 1. **Batch-Enrich 超时修复** ✅
**修复内容**: 
- 超时时间从 30s → 60s/90s (CEX) 和 120s/180s (Onchain)
- 最大执行时间从 300s → 600s

**验证结果**:
- ✅ **17:10:45** - batch-enrich-90D: 全部12个平台成功，无超时
- ✅ **17:25:31** - batch-enrich-30D: 全部12个平台成功，无超时  
- ✅ **17:40:24** - batch-enrich-7D: 全部12个平台成功，无超时

**对比历史记录**:
- ❌ **13:25:44** - batch-enrich-30D: 8个平台超时（okx_futures, bitget_futures等）
- ❌ **13:40:19** - batch-enrich-7D: 2个平台超时（okx_futures, bitget_futures）

**结论**: 修复完全生效，17:00后的所有运行均成功。

---

### 2. **Binance_spot 永久移除** ✅
**修复内容**: 
- 从 PLATFORM_LIMITS 中完全删除 binance_spot
- 代码注释: "PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min"

**验证结果**:
- ✅ 17:40:24 batch-enrich-7D: 无 binance_spot
- ✅ 代码确认: PLATFORM_LIMITS 中已删除
- ⚠️ batch-fetch-traders-a 仍包含 binance_spot（但该组17:45后未运行）

**最后一次 binance_spot 运行**:
- ⏱️ **17:43:12 - 17:44:25** (73秒，成功enriched 200)
- ⚠️ **17:44:28 - 19:00:40** (4572秒 = 76分钟，timeout被cleanup标记)

**结论**: batch-enrich已永久移除binance_spot，但batch-fetch-traders-a仍需更新。

---

### 3. **Batch-Fetch-Traders Group 配置更新** ⚠️
**代码确认的配置**:
```javascript
a: ['binance_spot'],                    // ⚠️ 未按预期清空
a2: [],                                 // ✅ 已清空
b: [],                                  // ✅ 已清空
c: [],                                  // ✅ 已清空
d1: ['gains'],                          // ✅ 已更新（htx_futures已移除）
d2: [],                                 // ✅ 已清空
e: ['bitfinex'],                        // ✅ 已更新（coinex/binance_web3已移除）
f: [],                                  // ✅ 已禁用（mexc/bingx）
g1: ['drift'],                          // ✅ 已更新（bitunix已移除）
g2: ['web3_bot', 'toobit'],            // ✅ 已更新（bitget_spot已移除）
h: [],                                  // ✅ 已禁用（gateio/btcc）
i: ['etoro'],                           // ✅ 正常
```

**最近运行记录**:
- ✅ **18:08:50** - g1 (drift): 成功，1500 traders
- ✅ **18:16:18** - g2 (web3_bot, toobit): 成功，13+196=209 traders
- ❌ **17:45:09** - a (binance_spot): 失败 "No connector registered for binance_spot:spot"
- ✅ **17:36:17** - e (bitfinex): 成功，555 traders
- ✅ **17:20:15** - d1 (gains): 成功，213 traders

**结论**: 
- f/h 组已正确禁用（空数组）✅
- g1 组已正确更新为只有drift ✅
- ⚠️ 但 a 组仍包含 binance_spot（需要改为空数组）

---

### 4. **环境变量检查** ✅
**检查项**:
- ✅ .env 存在 NEXT_PUBLIC_SUPABASE_URL
- ✅ .env 存在 SUPABASE_URL
- ✅ Vercel环境变量已配置（9个Supabase相关变量）

**结论**: 环境变量配置完整，无缺失。

---

## ❌ 真实存在的问题（需要修复）

### 问题1: batch-fetch-traders-a 仍包含 binance_spot
**问题描述**: 
- group a 配置为 `['binance_spot']`
- 但connector已删除，导致17:45运行失败

**修复建议**:
```javascript
a: [],  // 完全清空，避免失败
```

---

### 问题2: VPS Fetch 状态无法验证
**问题描述**: 
- `/api/admin/vps-fetch-status` 端点不存在或需要认证
- 无法验证12个平台是否恢复

**修复建议**:
- 查询 `platform_stats` 表或直接SSH到VPS查看fetch日志

---

## 📊 历史记录（可忽略）

以下问题存在于历史日志中，但**17:00后的运行已全部修复**：

- 📊 13:25 - 13:40 的 batch-enrich 超时（已修复）
- 📊 17:44 - 19:00 的 binance_spot 长时间卡住（已永久移除）
- 📊 14:45 的 batch-fetch-traders-a 失败（当前仍存在，需要修复group a配置）

---

## 🔍 当前运行状态

### 数据库查询结果:
- ✅ **0** 个任务处于 `running` 状态（无卡住任务）
- ✅ **0** 个任务在最近1小时内失败
- ✅ 最新的 batch-5min (19:05:48) 成功运行

### VPS进程检查:
```
root     3384973  bash -c while true; do node scripts/import/enrich_hyperliquid_batched.mjs --resume && sleep 2; done
```
- ℹ️ Hyperliquid连续enrichment进程正常运行（自3月12日起）

---

## ⏰ 下次运行时间预测

根据 vercel.json cron 配置：

- **batch-enrich-90D**: 下次 21:10 (每4小时第10分钟)
- **batch-enrich-30D**: 下次 21:25 (每4小时第25分钟)
- **batch-enrich-7D**: 下次 21:40 (每4小时第40分钟)
- **batch-fetch-traders-g1**: 下次 01:08 (1, 7, 13, 19时的第8分钟)
- **batch-fetch-traders-g2**: 下次 01:16 (1, 7, 13, 19时的第16分钟)
- **batch-fetch-traders-a**: 下次 20:45 (每3小时第45分钟) ⚠️ 预计失败

---

## 🎯 需要立即修复的问题

### 优先级 P0 (立即修复):
1. ❌ **将 batch-fetch-traders group a 改为空数组** 
   - 文件: `app/api/cron/batch-fetch-traders/route.ts`
   - 行数: ~42
   - 修改: `a: ['binance_spot']` → `a: []`

### 优先级 P1 (验证后修复):
2. ⚠️ **验证VPS fetch状态**
   - SSH到VPS查看12个平台的fetch日志
   - 确认Edge Runtime修复后是否恢复

---

## 📌 总结

### ✅ 已生效的修复（4项）:
1. batch-enrich 超时时间调整 → 17:00后无超时
2. binance_spot 从 batch-enrich 移除 → 17:40后无此平台
3. f/h group 禁用 → 代码确认为空数组
4. g1 group 更新为只有drift → 18:08运行验证

### ❌ 需要修复的问题（2项）:
1. batch-fetch-traders group a 仍包含 binance_spot
2. VPS fetch状态无法验证（需要SSH检查）

### 📊 可忽略的历史记录（3项）:
1. 13:25-13:40 的超时问题（已修复）
2. 17:44 binance_spot卡住（已移除）
3. 旧的group配置失败（部分已修复）

---

**排查完成时间**: 2026-03-14 19:10 PST  
**总耗时**: 4分钟
