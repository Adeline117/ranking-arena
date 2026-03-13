# Arena 运营审计文档总览

**审计日期：** 2026-03-13  
**审计人：** 小昭 (OpenClaw Subagent)

---

## 📚 文档结构

这次全面审计创建了以下6个关键文档：

### 1. 📋 OPERATIONAL_AUDIT_2026-03-13.md
**完整的运营风险审计报告**

涵盖7大风险领域：
- 数据库备份（🟡 中风险）
- 域名和DNS（🟢 低风险）
- 密钥轮换（🔴 高风险）
- 成本监控（🟡 中风险）
- 灾难恢复（🟡 中风险）
- 法律合规（🔴 高风险）
- 上线前检查（🟡 中风险）

**快速访问：**
```bash
cat docs/OPERATIONAL_AUDIT_2026-03-13.md
```

---

### 2. 🚨 DISASTER_RECOVERY.md
**灾难恢复计划**

包含5大灾难场景的恢复流程：
- Vercel宕机 → Railway备份部署
- Supabase宕机 → 本地PostgreSQL恢复
- GitHub锁定 → GitLab镜像切换
- Cloudflare DNS劫持 → 备用DNS
- Mac Mini故障 → 备份系统迁移

**RTO/RPO目标：**
- 生产网站：4小时 / 0数据丢失
- 数据库：2小时 / 24小时数据丢失

**测试计划：** 每月恢复演练

---

### 3. ⚖️ LEGAL_COMPLIANCE.md
**法律合规检查表**

识别的关键法律风险：
- ❌ 缺少隐私政策（GDPR/CCPA违规）
- ❌ 缺少服务条款
- ❌ 无GDPR数据删除流程
- 🟡 API ToS合规性待审查
- ❌ 缺少Cookie声明

**优先行动项：**
1. 2026-03-15前：创建Privacy Policy + Terms of Service
2. 2026-03-20前：实现GDPR删除请求API
3. 2026-03-20前：审查Binance/Bybit API ToS

---

### 4. 💰 COST_MONITORING.md
**成本监控报告**

服务用量估算：
- Vercel：43个cron任务，~52k调用/月（接近免费额度50%）
- Supabase：trader_snapshots 2.8M行，可能已超Free限额
- Upstash Redis：用量待确认
- Cloudflare R2：每月备份~10GB（接近Free限额）

**告警阈值：**
- 所有服务设置80%用量告警
- 需升级到付费计划的总成本：$51-77/月

**优化建议：**
- 合并cron任务（节省30-40%调用）
- 归档老数据到R2（节省40-50%存储）
- 增加缓存（减少50%数据库调用）

---

### 5. 🔐 scripts/security/rotate-secrets.sh
**密钥轮换脚本**

支持轮换的密钥：
- Telegram Bot Token
- Supabase Service Role Key
- Upstash Redis Token
- CRON_SECRET
- Sentry Auth Token
- VPS_PROXY_KEY

**使用方法：**
```bash
# 预览所有操作（不执行）
./scripts/security/rotate-secrets.sh --dry-run

# 轮换所有密钥
./scripts/security/rotate-secrets.sh

# 只轮换Telegram密钥
./scripts/security/rotate-secrets.sh --service telegram

# 只轮换自动生成的密钥（CRON_SECRET）
./scripts/security/rotate-secrets.sh --service cron
```

**自动化：**
- 自动更新Vercel环境变量
- 自动更新本地.env
- 记录审计日志到 `scripts/security/rotation-history.log`

---

### 6. 🗄️ scripts/backup/supabase-backup.sh
**数据库备份脚本（应急版）**

快速手动备份脚本，用于：
- 紧急备份（在轮换密钥前）
- 测试恢复流程
- 本地开发环境备份

**使用方法：**
```bash
# 完整数据库备份
./scripts/backup/supabase-backup.sh

# 只备份trader表（更快）
./scripts/backup/supabase-backup.sh --tables-only

# 指定输出目录
./scripts/backup/supabase-backup.sh --output-dir /path/to/backups
```

**注意：** 生产环境请使用 `npm run backup:r2`（自动上传到R2）

---

## 🔴 紧急行动项（P0 - 24小时内）

1. **起草法律文档**
   - [ ] Privacy Policy (`app/privacy/page.tsx`)
   - [ ] Terms of Service (`app/terms/page.tsx`)

2. **轮换暴露的密钥**
   - [ ] VPS_PROXY_KEY（如已暴露）
   - [ ] 其他需要轮换的密钥

3. **测试数据库恢复**
   - [ ] 从R2下载最新备份
   - [ ] 恢复到临时数据库
   - [ ] 验证数据完整性

---

## 🟡 短期行动项（P1 - 1周内）

1. **成本监控**
   - [ ] 检查Vercel Dashboard（Serverless调用量）
   - [ ] 检查Supabase Dashboard（数据库大小）
   - [ ] 检查Upstash Dashboard（Redis请求量）
   - [ ] 检查R2 Dashboard（存储用量）
   - [ ] 设置80%用量告警

2. **密钥管理**
   - [ ] 建立季度轮换计划
   - [ ] 记录最后轮换时间

3. **上线前检查**
   - [ ] 添加Vercel Analytics或Google Analytics
   - [ ] 验证Google Search Console
   - [ ] 测试Sentry错误追踪

---

## 🟢 中期行动项（P2 - 1个月内）

1. **灾难恢复准备**
   - [ ] 创建Railway备份部署
   - [ ] 设置GitLab镜像
   - [ ] 测试完整恢复流程

2. **成本优化**
   - [ ] 归档>90天的数据到R2
   - [ ] 优化高频cron任务
   - [ ] 实施自动化成本报告

3. **法律合规**
   - [ ] 实现GDPR删除请求API
   - [ ] 审查所有API ToS
   - [ ] 添加Cookie横幅

---

## 📊 审计结果总结

| 风险领域 | 风险等级 | 关键问题 | 优先级 |
|---------|---------|---------|--------|
| 法律合规 | 🔴 高 | 缺少Privacy/Terms | P0 |
| 密钥轮换 | 🔴 高 | 无轮换机制 | P0 |
| 数据库备份 | 🟡 中 | 未测试恢复 | P0 |
| 成本监控 | 🟡 中 | 接近免费额度 | P1 |
| 灾难恢复 | 🟡 中 | 无备份部署 | P1 |
| 上线前检查 | 🟡 中 | 缺少Analytics | P1 |
| 域名DNS | 🟢 低 | 配置正常 | P2 |

---

## 🔗 相关资源

**Service Dashboards:**
- [Vercel Usage](https://vercel.com/dashboard/usage)
- [Supabase Database](https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/settings/database)
- [Upstash Redis](https://console.upstash.com/redis)
- [Cloudflare R2](https://dash.cloudflare.com/r2/overview)
- [Sentry](https://arca-h9.sentry.io/)

**Documentation:**
- [API Routes](./API_ROUTES.md)
- [Environment Variables](./ENV_VARS.md)
- [Monitoring](./MONITORING.md)
- [Deployment](./DEPLOYMENT.md)

---

## 📝 维护说明

**审核周期：**
- 每月：测试数据库恢复 + 检查成本用量
- 每季度：轮换密钥 + 审查API ToS
- 每半年：完整灾难恢复演练 + 更新法律文档

**下次审核日期：** 2026-06-13

---

**创建时间：** 2026-03-13 13:55 PDT  
**审计工具：** OpenClaw Subagent  
**审计耗时：** 18分钟
