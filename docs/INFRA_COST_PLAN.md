# Ranking Arena 基础设施成本计划

> 最后更新：2026-02-07

本文档对比「当前省钱模式」与「有用户后升级版」的基础设施月费。

---

## 成本对比表

| # | 服务 | 当前方案 | 当前月费 | 升级方案 | 升级月费 |
|---|------|---------|---------|---------|---------|
| 1 | **部署/Hosting** — Vercel | Pro Plan | $20 | Pro Plan (不变，按量扩容) | $20 + 按量 |
| 2 | **数据库** — Supabase | Free Tier (500MB, 50K MAU) | $0 | Pro Plan (8GB, 无限 API) | $25 |
| 3 | **VPS** — Vultr Singapore | 2GB RAM (数据抓取 cron) | $12 | 4GB RAM (更多并发抓取) | $24 |
| 4 | **缓存** — Upstash Redis | Free Tier (10K cmd/day) | $0 | Pay-as-you-go / Pro | ~$10 |
| 5 | **错误监控** — Sentry | Developer (免费, 5K events) | $0 | Team Plan (50K events) | $26 |
| 6 | **域名** — arenafi.org | .org 年费 ~$12/年 | ~$1 | 不变 | ~$1 |
| 7 | **Crypto Twitter** — LunarCrush | ❌ 待订阅 | $0 | Pro API (按年 $72/月) | $72 |
| 8 | **AML/合规** — Chainalysis | ❌ 未接入，待 API key | $0 | Reactor/KYT API | ~$500+ (按需) |
| 9 | **AI/LLM** — OpenAI API | 按量付费 (Whisper, GPT) | ~$5 | 按量付费 (用量增长) | ~$50 |
| 10 | **NFT** — Base Mainnet | 合约已部署，Gas 极低 | ~$1 | Gas 随用户 mint 增长 | ~$10 |
| 11 | **CDN/图片** — Vercel + Cloudflare | Vercel 内置 + CF Worker Proxy | $0 | Cloudflare Pro (如需) | $20 |
| 12 | **支付** — Stripe | Test 模式，0 费用 | $0 | 2.9% + $0.30/笔 (按量) | 按量 |
| 13 | **邮件** | 暂无 | $0 | Resend / SendGrid Free→Pro | $0~$20 |
| 14 | **监控/日志** | Sentry + Vercel 内置日志 | $0 | Datadog / Better Stack | $0~$30 |
| 15 | **SSL** | Vercel/Cloudflare 免费 | $0 | 不变 | $0 |
| 16 | **消息队列** — Upstash QStash | Free Tier | $0 | Pay-as-you-go | ~$5 |
| 17 | **Web3** — WalletConnect | Free Tier | $0 | Growth Plan | $0~$99 |
| 18 | **治理** — Snapshot | 免费 (arenafi.eth) | $0 | 不变 | $0 |

---

## 月费总计

| | 当前（省钱模式） | 有用户后（升级版） |
|--|-----------------|-------------------|
| **确定费用** | ~$38 | ~$233 |
| **可选/按需** | $0 | $500+ (Chainalysis) |
| **合计** | **~$38/月** | **~$733/月**（含 Chainalysis） |

### 当前确定费用明细
- Vercel Pro: $20
- Vultr VPS: $12
- OpenAI API: ~$5
- 域名均摊: ~$1
- **小计: ~$38/月**

### 升级后费用明细（不含 Chainalysis）
- Vercel Pro: $20+
- Supabase Pro: $25
- Vultr 4GB: $24
- Upstash Redis: $10
- Upstash QStash: $5
- Sentry Team: $26
- 域名: $1
- LunarCrush: $72
- OpenAI: $50
- NFT Gas: $10
- Cloudflare: $20
- 邮件: $20
- 监控: $30
- **小计: ~$233/月** (+ Stripe 按交易量扣费)

---

## 备注

1. **Supabase** — 当前使用 Free Tier（从连接串和项目规模判断），升级到 Pro 后获得 8GB 存储和更好的性能
2. **LunarCrush** — 按年付 $72/月 vs 按月付 $90/月，建议确认需求后按年订阅
3. **Chainalysis** — 企业级定价，需联系销售获取报价，$500 为估算下限
4. **Stripe** — 当前 test 模式（`sk_test_`），上线后按交易量收费，非固定月费
5. **Upstash** — 同时使用了 Redis（缓存）和 QStash（消息队列/定时任务）
6. **Base NFT** — 合约已部署 (`0x5B8f...6196`)，L2 Gas 费极低
7. **Cloudflare** — 当前已有 Worker Proxy (`ranking-arena-proxy.broosbook.workers.dev`)
8. **Capacitor (移动端)** — 已集成 iOS/Android，App Store 开发者账号费用另计（Apple $99/年, Google $25 一次性）
