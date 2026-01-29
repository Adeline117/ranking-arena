# Ranking Arena 优化计划

**创建时间：** 2026-01-29
**状态：** 执行中

---

## Phase 0：代码卫生（1-2天）

- [ ] 合并冗余脚本：bitget v1→v2，check_sources 1/2 合并
- [ ] 归档废弃文件到 scripts/archive/
- [ ] 清理 docs/ 重复文档
- [ ] vercel.json 去重（rankings 和 trader 重复 header）
- [ ] TypeScript strict 扫描，清除残余 any

## Phase 1：核心体验打磨（1-2周）

- [ ] 筛选状态 URL 同步（query params）
- [ ] Arena Score 解释 tooltip
- [ ] 首屏 LCP 优化 <1.5s
- [ ] 排行榜移动端卡片布局
- [ ] 交易员详情页 Tab 分组
- [ ] 搜索体验优化（实时建议+键盘导航+历史）

## Phase 2：数据稳定性（1周）

- [ ] Cron 失败告警（Sentry/Telegram）
- [ ] Puppeteer 任务迁移到独立 Worker
- [ ] 数据校验层
- [ ] 增量更新
- [ ] Cloudflare Worker 代理健康检查

## Phase 3：留存功能（2周）

- [ ] 关注列表 Dashboard
- [ ] 异动通知（Push）
- [ ] 对比功能完善
- [ ] Portfolio 建议

## Phase 4：社区 MVP（2-3周）

- [ ] 交易员评论/评分
- [ ] 交易员 Claim
- [ ] 小组讨论（官方组）
- [ ] 翻译功能

## Phase 5：变现 + 增长（持续）

- [ ] Premium 功能差异化
- [ ] SEO 优化
- [ ] 移动端 App 打包
- [ ] 链上数据增强
