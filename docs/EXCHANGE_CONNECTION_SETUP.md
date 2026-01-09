# 用户绑定交易所账号功能使用指南

## 功能概述

用户可以通过绑定自己的交易所账号（API Key），获取详细的交易统计数据，包括：
- Total Trades (12M)
- Avg Profit/Loss
- Profitable Trades Pct
- Trades Per Week
- Active Since
- 等等

## 安装步骤

### 1. 创建数据库表

在 Supabase Dashboard 的 SQL Editor 中运行：

```sql
-- 运行 scripts/setup_user_exchange_tables.sql
```

这个脚本会创建以下表：
- `user_exchange_connections` - 存储用户连接的交易所
- `user_trading_data` - 存储用户交易统计数据
- `user_frequently_traded` - 存储常用交易币种
- `user_portfolio_breakdown` - 存储投资组合分解
- `user_trading_history` - 存储交易历史（可选）

### 2. 配置环境变量

在 `.env.local` 或 Vercel 环境变量中添加：

```bash
# 加密密钥（用于加密存储API Key和Secret）
ENCRYPTION_KEY=your-secret-encryption-key-change-this

# Supabase配置（应该已经存在）
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**重要**：`ENCRYPTION_KEY` 应该是一个强随机字符串，用于加密用户的API Key和Secret。

### 3. 部署代码

```bash
git add .
git commit -m "添加用户绑定交易所账号功能"
git push origin main
```

Vercel 会自动部署。

## 使用流程

### 用户端

1. **登录账号**
   - 访问 `/login` 登录

2. **进入设置页面**
   - 访问 `/settings`
   - 找到"绑定交易所账号"部分

3. **绑定Binance账号**
   - 点击"连接"按钮
   - 输入API Key和Secret
   - 点击"确认连接"
   - 系统会自动验证凭证并同步数据

4. **查看数据**
   - 绑定成功后，数据会自动同步
   - 可以在个人主页查看详细统计数据

### 管理员端

#### 手动触发同步

如果需要手动触发数据同步，可以调用API：

```bash
POST /api/exchange/sync
Authorization: Bearer <user-token>
Content-Type: application/json

{
  "exchange": "binance"
}
```

#### 后台自动同步（推荐）

创建 Vercel Cron Job 定期同步所有用户数据：

在 `vercel.json` 中添加：

```json
{
  "crons": [
    {
      "path": "/api/cron/sync-user-data",
      "schedule": "0 2 * * *"
    }
  ]
}
```

然后创建 `app/api/cron/sync-user-data/route.ts`（见下一步）。

## 技术实现

### API路由

- `POST /api/exchange/connect` - 连接交易所
- `POST /api/exchange/sync` - 同步数据
- `DELETE /api/exchange/disconnect` - 断开连接

### 组件

- `app/components/ExchangeConnection.tsx` - 交易所连接管理组件
- `app/settings/page.tsx` - 设置页面（已集成）

### 工具函数

- `lib/exchange/binance.ts` - Binance API客户端
- `lib/exchange/encryption.ts` - 加密工具
- `lib/data/user-trading.ts` - 用户交易数据获取

## 安全注意事项

1. **加密存储**
   - API Key和Secret使用Base64编码存储（生产环境应使用AES-256）
   - 加密密钥存储在环境变量中

2. **权限控制**
   - 使用RLS（Row Level Security）确保用户只能访问自己的数据
   - API路由需要用户认证

3. **API权限**
   - 建议用户在创建API Key时，仅授予"读取"权限
   - 不要授予"交易"或"提现"权限

## 支持的交易所

目前支持：
- ✅ Binance

计划支持：
- ⏳ Bybit
- ⏳ Bitget
- ⏳ MEXC
- ⏳ CoinEx

## 故障排查

### 问题1：连接失败

**错误**：`API Key或Secret无效`

**解决方案**：
1. 检查API Key和Secret是否正确
2. 确认API Key在Binance中已启用
3. 确认API Key有"读取账户信息"权限

### 问题2：同步失败

**错误**：`同步失败`

**解决方案**：
1. 检查API Key是否过期
2. 检查网络连接
3. 查看 `user_exchange_connections.last_sync_error` 字段获取详细错误信息

### 问题3：数据不显示

**可能原因**：
1. 数据尚未同步（等待同步完成）
2. 用户未绑定交易所账号
3. 数据库表未创建

**解决方案**：
1. 手动触发同步：点击"刷新数据"按钮
2. 检查数据库表是否存在
3. 检查RLS策略是否正确配置

## 下一步开发

1. **实现后台同步任务**
   - 创建 `app/api/cron/sync-user-data/route.ts`
   - 定期同步所有已连接用户的数据

2. **扩展数据展示**
   - 在 `StatsPage` 组件中显示绑定后的详细数据
   - 显示"绑定账号以查看详细统计"提示（如果未绑定）

3. **支持更多交易所**
   - 实现 Bybit API客户端
   - 实现 Bitget API客户端
   - 等等

4. **改进加密**
   - 使用AES-256加密替代Base64编码
   - 使用Supabase Vault存储敏感数据

## 相关文档

- [数据绑定前后对比](./DATA_BINDING_COMPARISON.md)
- [用户绑定交易所账号技术方案](./USER_EXCHANGE_CONNECTION_TECH.md)
- [数据可用性评估](./DATA_AVAILABILITY_ASSESSMENT.md)

