# Arena 法律合规检查表
**版本：** 1.0  
**日期：** 2026-03-13  
**适用地区：** 全球（重点：美国、欧盟）  
**审核周期：** 每半年

---

## 🔴 紧急：当前缺失的法律文档

### 1. 隐私政策 (Privacy Policy) - **必须**
**状态：** ❌ **缺失**  
**风险：** 🔴 高 - 违反GDPR/CCPA  
**截止时间：** 2026-03-15

**必须包含的内容：**
- 收集哪些数据（Telegram ID、钱包地址、交易记录）
- 数据如何使用（排行榜展示、性能分析）
- 第三方服务（Binance/Bybit/OKX API、Supabase、Vercel）
- Cookie使用声明
- 用户权利（访问、删除、导出数据）
- 数据保留期限
- 联系方式

**模板起点：**
```markdown
# Privacy Policy for Arena

Last Updated: 2026-03-13

## 1. Data We Collect
- Telegram User ID (for authentication)
- Exchange API Keys (encrypted, never stored in plaintext)
- Trading performance data (PnL, ROI, positions)
- IP addresses (via Vercel logs)

## 2. How We Use Your Data
- Display your trading performance on leaderboards
- Calculate rankings and statistics
- Send notifications via Telegram bot

## 3. Third-Party Services
- Supabase (database hosting, US region)
- Vercel (web hosting, edge network)
- Upstash (Redis caching, global)
- Binance/Bybit/OKX (API data fetching)

## 4. Your Rights (GDPR)
- Right to access your data
- Right to delete your data (email: privacy@arenafi.org)
- Right to export your data
- Right to opt-out of leaderboards

## 5. Data Retention
- Active accounts: Indefinite
- Deleted accounts: 30 days grace period, then permanent deletion

## 6. Contact
Email: privacy@arenafi.org
Telegram: @ArenaFiBot
```

**实施步骤：**
1. 创建 `app/privacy/page.tsx`
2. 添加到footer链接
3. 在注册流程添加"同意隐私政策"checkbox
4. 记录用户同意时间戳

---

### 2. 服务条款 (Terms of Service) - **必须**
**状态：** ❌ **缺失**  
**风险：** 🔴 高 - 法律纠纷无保护  
**截止时间：** 2026-03-15

**必须包含的内容：**
- 服务描述（交易员排行榜，非投资建议）
- 用户责任（自行验证数据准确性）
- 免责声明（不对交易损失负责）
- 账户规则（禁止刷榜、虚假数据）
- 服务变更权利
- 终止条款
- 争议解决（仲裁/法院管辖）

**关键免责声明：**
```markdown
## DISCLAIMER

Arena is a data aggregation platform. We do NOT:
- Provide investment advice
- Guarantee accuracy of trading data
- Endorse any trader or strategy
- Handle user funds

All trading involves risk. Past performance ≠ future results.
Use this platform at your own risk.
```

**实施步骤：**
1. 创建 `app/terms/page.tsx`
2. 添加到footer和注册流程
3. 标注"最后更新时间"并存档历史版本

---

### 3. Cookie声明 - **建议**
**状态：** ❌ **缺失**  
**风险：** 🟡 中 - 欧盟Cookie法  
**截止时间：** 2026-03-20

**当前Cookie使用（需确认）：**
- Vercel Analytics cookies（如果启用）
- Supabase auth cookies
- Telegram Web App cookies

**实施方案：**
1. 添加Cookie横幅（首次访问弹出）
2. 用户可选择Accept/Reject非必要cookies
3. 记录用户选择

**推荐库：**
```bash
npm install react-cookie-consent
```

---

## 🟡 API使用合规性

### Binance API
**ToS链接：** https://www.binance.com/en/terms  
**检查项：**
- [ ] 仅用于个人非商业用途 ❌ Arena是公开平台
- [ ] 需要明确标注"数据来源Binance"
- [ ] 不得用于交易信号服务 ⚠️ 需审查排行榜是否算"信号"
- [ ] 遵守API速率限制（1200 requests/min）

**当前状态：** 🟡 需审查商业使用条款  
**风险：** API被封禁  
**行动项：** 联系Binance确认排行榜用途是否合规

---

### Bybit API
**ToS链接：** https://www.bybit.com/en/terms-service/terms-of-use  
**检查项：**
- [ ] 允许公开展示数据（需确认）
- [ ] 不得用于高频交易或套利
- [ ] 标注数据来源

**当前状态：** 🟡 待确认  
**行动项：** 审查ToS第X条关于数据使用

---

### OKX API
**ToS链接：** https://www.okx.com/terms-of-service  
**检查项：**
- [ ] 数据展示需标注来源
- [ ] 不得用于交易服务（Arena不提供跟单，应合规）

**当前状态：** 🟡 待确认

---

### Dune Analytics API
**ToS链接：** https://dune.com/docs/api/terms  
**检查项：**
- [ ] 免费计划允许公开展示（需确认quota）
- [ ] 需标注"Powered by Dune Analytics"

**当前状态：** ✅ 应该合规（公开数据）

---

### Etherscan / Alchemy / Solscan
**状态：** ✅ 公开区块链数据，无限制

---

## 🟢 GDPR合规性

### 数据删除请求流程
**当前状态：** ❌ **未实现**  
**法律要求：** GDPR第17条"被遗忘权"  
**截止时间：** 2026-03-20

**实施步骤：**
1. 创建删除请求表单
```typescript
// app/api/gdpr/delete-request/route.ts
export async function POST(req: Request) {
  const { email, telegram_id, reason } = await req.json()
  
  // 1. 记录删除请求
  await supabase.from('gdpr_delete_requests').insert({
    telegram_id,
    email,
    reason,
    status: 'pending',
    requested_at: new Date(),
  })
  
  // 2. 发送确认邮件
  await sendConfirmationEmail(email)
  
  // 3. 30天后执行删除
  // (通过cron job检查并执行)
}
```

2. 创建cron任务处理删除
```typescript
// app/api/cron/process-gdpr-deletions/route.ts
export async function GET(req: Request) {
  const { data: requests } = await supabase
    .from('gdpr_delete_requests')
    .select('*')
    .eq('status', 'pending')
    .lt('requested_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
  
  for (const req of requests) {
    // 删除所有关联数据
    await deleteUserData(req.telegram_id)
    await supabase.from('gdpr_delete_requests').update({
      status: 'completed',
      deleted_at: new Date(),
    }).eq('id', req.id)
  }
}
```

3. 数据删除范围
```sql
-- 需要删除的表
DELETE FROM trader_authorizations WHERE telegram_id = ?;
DELETE FROM trader_alerts WHERE telegram_id = ?;
DELETE FROM trader_follows WHERE follower_id = ? OR following_id = ?;
-- ... 所有包含用户数据的表
```

---

### 数据导出请求
**法律要求：** GDPR第20条"数据可携带权"

**实施API：**
```typescript
// app/api/gdpr/export/route.ts
export async function POST(req: Request) {
  const { telegram_id } = await req.json()
  
  // 导出所有用户数据为JSON
  const userData = await exportUserData(telegram_id)
  
  return new Response(JSON.stringify(userData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="arena-data-${telegram_id}.json"`,
    },
  })
}
```

---

## 📋 合规检查清单

### 上线前必须完成
- [ ] 隐私政策页面 (`/privacy`)
- [ ] 服务条款页面 (`/terms`)
- [ ] Footer添加Privacy & Terms链接
- [ ] 注册流程添加"同意条款"checkbox
- [ ] 实现GDPR数据删除API
- [ ] 实现GDPR数据导出API
- [ ] 添加"Contact Us"邮箱（privacy@arenafi.org）

### 上线后30天内完成
- [ ] Cookie横幅和管理
- [ ] 审查所有API ToS
- [ ] 与Binance/Bybit确认商业使用
- [ ] 设置GDPR删除请求cron任务
- [ ] 测试完整GDPR流程

### 持续监控
- [ ] 每季度审查API ToS更新
- [ ] 每半年审查隐私政策
- [ ] 记录所有数据删除请求并归档

---

## 📧 联系方式

**GDPR数据请求邮箱：** privacy@arenafi.org  
**法律问题联系：** legal@arenafi.org  
**Telegram支持：** @ArenaFiBot

---

## 风险评估总结

| 合规项 | 状态 | 风险 | 优先级 | 截止时间 |
|--------|------|------|--------|----------|
| 隐私政策 | ❌ | 🔴 高 | P0 | 2026-03-15 |
| 服务条款 | ❌ | 🔴 高 | P0 | 2026-03-15 |
| GDPR删除流程 | ❌ | 🔴 高 | P0 | 2026-03-20 |
| API ToS审查 | 🟡 | 🟡 中 | P1 | 2026-03-20 |
| Cookie声明 | ❌ | 🟡 中 | P1 | 2026-03-25 |
| GDPR导出功能 | ❌ | 🟢 低 | P2 | 2026-04-01 |

---

**文档版本历史：**
- v1.0 (2026-03-13): 初始版本
- v1.1 (待定): 添加隐私政策和ToS最终版本

**下次审核日期：** 2026-09-13
