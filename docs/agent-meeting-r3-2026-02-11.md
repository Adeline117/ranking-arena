# Agent Team Meeting R3 — 2026-02-11 07:56 PST

## 当前状态
- Build: ✅ 成功 (b0118e30 + 663e78a2)
- 首页: ✅ 零console错误, TTFB 614ms
- 交易员详情: ✅ 零console错误
- Sources: ✅ 30个平台全部显示 (刚修复)
- Rankings API: ✅ 15,647 traders

## 问题清单 (按优先级)

### Batch 1 — 性能优化 + 数据完整性
1. **[PERF] Rankings API sources查询太重** — 每次请求遍历全表来收集distinct sources，应该缓存或用物化视图
2. **[PERF] Bundle size优化** — 检查是否有大包未tree-shake
3. **[DATA] 6个DiceBear头像清理** — DB trigger阻止update，需要临时禁用trigger

### Batch 2 — UI/UX 问题
4. **[UI] 交易员详情"V3 45"显示** — Score Breakdown旁边的"V3 45"看起来奇怪
5. **[UI] "ROI: MIXED"标签** — 交易员header显示"ROI: MIXED"不够清晰
6. **[UI] 底部Sources显示还是旧的** — ISR缓存，需要等revalidate或手动触发
7. **[UI] Equity curve区域空白** — 有数据但图表未显示
8. **[UI] "Trader Not Registered"** — 建议换成中文

### Batch 3 — API + 后端
9. **[API] /api/market/overview 间歇500** — Supabase连接问题
10. **[API] Flash news API返回格式不一致** — 有时是{news:[]}有时是[]
11. **[API] library_items查询间歇500** — 已加容错但应查根因
12. **[CRON] Aevo无scraper** — 需要写import脚本

### Batch 4 — 代码质量
13. **[CODE] 46个as any类型断言** — 渐进清理
14. **[CODE] 10个lint warnings** — 未使用变量
15. **[CODE] 未实现的TODO占位fetcher** — btse/whitebit/cryptocom

## Agent分配计划 (最多2-3个并发)

### Wave 1 (立即)
- **Agent A: perf-optimize** — Rankings API缓存sources + bundle分析
- **Agent B: ui-polish-r3** — V3标签/ROI:MIXED/i18n统一中文

### Wave 2 (Wave 1完成后)
- **Agent C: data-fix** — DiceBear清理(禁用trigger) + Aevo scraper
- **Agent D: api-stability** — market overview + flash news格式统一

### Wave 3 (Wave 2完成后)
- **Agent E: code-quality** — as any清理 + lint fix + 移除dead code
