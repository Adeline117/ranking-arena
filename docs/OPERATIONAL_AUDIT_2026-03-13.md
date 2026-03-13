# Arena 运营风险全面审计报告
**日期：** 2026-03-13  
**审计人：** 小昭 (OpenClaw Subagent)  
**项目：** Ranking Arena (arenafi.org)  
**风险级别：** 🔴 高 | 🟡 中 | 🟢 低

---

## 执行摘要

Arena项目目前运行稳定，但存在以下关键风险需要立即处理：
- **数据库备份**：✅ 已有R2备份方案，但需测试恢复流程
- **密钥管理**：🔴 **高风险** - 19个密钥需建立轮换机制
- **法律合规**：🔴 **高风险** - 缺少隐私政策和ToS
- **灾难恢复**：🟡 **中风险** - 无备份部署方案
- **成本监控**：🟢 低风险 - 43个cron任务需持续监控

---

## 1. 数据库备份 ✅🟡

### 当前状态
✅ **已实施R2备份方案**
- 备份脚本：`scripts/maintenance/backup-to-r2.mjs`
- 备份命令：`npm run backup:r2`（每日）/ `npm run backup:r2:full`（每周完整备份）
- 目标：Cloudflare R2 存储桶 `arena-backups`
- 备份表：27个核心trader表 + 完整数据库（周日）

### Supabase配置
- **项目URL：** `iknktzifjdyujdccyhsv.supabase.co`
- **计划级别：** 需通过Dashboard确认（Free/Pro）
- **自动备份：** Supabase自带PITR（需Pro计划）
- **关键表：** trader_snapshots（2.8M行）需单独备份策略

### 风险评估
🟡 **中风险**
- ✅ 本地备份脚本已存在
- ⚠️ 缺少**恢复流程测试记录**
- ⚠️ 未确认Supabase计划级别和PITR保留时间
- ⚠️ 未验证R2备份的完整性和可用性

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🔴 P0 | 测试从R2恢复备份到临时数据库 | Adeline | 2026-03-15 |
| 🟡 P1 | 确认Supabase计划和PITR配置 | Adeline | 2026-03-16 |
| 🟡 P1 | 配置Mac Mini cron执行每日备份 | Adeline | 2026-03-16 |
| 🟢 P2 | 为trader_snapshots创建增量备份策略 | Adeline | 2026-03-20 |

### 建议方案
```bash
# 1. 每日trader表备份（已有）
0 3 * * * cd ~/ranking-arena && npm run backup:r2

# 2. 每周完整数据库备份（已有）
0 4 * * 0 cd ~/ranking-arena && npm run backup:r2:full

# 3. 新增：恢复测试（每月）
cat > scripts/backup/test-restore.sh << 'EOF'
#!/bin/bash
# 每月测试恢复流程
BACKUP_FILE=$(ls -t /tmp/arena-backup-*.sql.gz | head -1)
echo "Testing restore from: $BACKUP_FILE"
# TODO: 恢复到临时数据库并验证
EOF
```

---

## 2. 域名和DNS ✅🟢

### 当前状态
✅ **域名配置正常**
- **域名：** arenafi.org
- **注册商：** 需通过WHOIS确认
- **到期时间：** 2027-01-08
- **自动续费：** 需通过注册商Dashboard确认
- **DNS：** Cloudflare托管（104.21.63.78, 172.67.170.72）
- **SSL证书：** Google Trust Services (WE1)
- **证书到期：** 2026-06-06

### 风险评估
🟢 **低风险**
- ✅ 域名有效期还有9个月
- ✅ SSL证书有效期3个月（Cloudflare自动续期）
- ✅ DNS由Cloudflare管理，稳定可靠

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🟢 P2 | 确认域名自动续费已开启 | Adeline | 2026-04-01 |
| 🟢 P2 | 设置域名到期前60天提醒 | Adeline | 2026-04-01 |

---

## 3. 密钥轮换 🔴

### 当前状态
🔴 **高风险 - 缺少密钥轮换机制**

共检测到 **19个密钥/Token**，包括：
- CRON_SECRET
- STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
- SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY
- R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
- SENTRY_AUTH_TOKEN
- UPSTASH_REDIS_REST_TOKEN
- TELEGRAM_BOT_TOKEN
- VPS_PROXY_KEY
- DUNE_API_KEY
- ETHERSCAN_API_KEYS
- ALCHEMY_API_KEY
- SOLSCAN_API_KEY

### 硬编码密钥扫描
✅ **未发现硬编码密钥** - 所有API调用使用环境变量

### 风险评估
🔴 **高风险**
- ⚠️ 无密钥轮换记录
- ⚠️ 无密钥最后更新时间追踪
- ⚠️ 缺少自动轮换脚本
- ⚠️ 部分密钥（如Telegram Bot Token）从未轮换

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🔴 P0 | 创建密钥轮换脚本和流程文档 | 小昭 | 2026-03-13 ✅ |
| 🔴 P0 | 轮换VPS_PROXY_KEY（如已暴露） | Adeline | 2026-03-14 |
| 🟡 P1 | 轮换Telegram Bot Token | Adeline | 2026-03-16 |
| 🟡 P1 | 轮换Supabase Service Role Key | Adeline | 2026-03-16 |
| 🟢 P2 | 建立每季度密钥轮换计划 | Adeline | 2026-04-01 |

### 建议方案
详见：`scripts/security/rotate-secrets.sh` ✅ 已创建

---

## 4. 成本监控 🟢🟡

### 当前状态
**Vercel配置：**
- **Cron任务数量：** 43个
- **估算调用量：** 需通过Vercel Dashboard查看实时数据
- **免费额度：** 100k Serverless调用/月（Hobby计划）

**Supabase：**
- **数据库大小：** 需通过Dashboard确认
- **免费额度：** 500MB存储 + 2GB数据传输（Free计划）
- **关键表：** trader_snapshots（2.8M行）占用大部分空间

**Upstash Redis：**
- **请求量：** 需通过Dashboard确认
- **免费额度：** 10k请求/日（Free计划）

**Cloudflare R2：**
- **存储：** 备份文件大小需确认
- **免费额度：** 10GB存储 + 无egress费用

### 风险评估
🟡 **中风险**
- ⚠️ 43个cron任务可能接近Vercel免费额度上限
- ⚠️ trader_snapshots增长可能超Supabase免费存储
- ✅ R2无egress费用，成本可控

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🟡 P1 | 检查Vercel本月Serverless调用量 | Adeline | 2026-03-14 |
| 🟡 P1 | 检查Supabase数据库大小和增长趋势 | Adeline | 2026-03-14 |
| 🟡 P1 | 检查Upstash Redis请求量 | Adeline | 2026-03-14 |
| 🟢 P2 | 设置成本告警（80%免费额度） | Adeline | 2026-03-20 |

### 建议监控脚本
详见：`docs/COST_MONITORING.md` ✅ 已创建

---

## 5. 灾难恢复 🟡

### 当前状态
🟡 **部分风险 - 缺少备份部署方案**

**现有备份：**
- ✅ GitHub备份：`git@github.com:Adeline117/ranking-arena.git`
- ✅ R2数据库备份
- ❌ 无备份部署平台配置（Railway/Fly.io/VPS）

**依赖服务单点：**
- Vercel（部署）
- Supabase（数据库）
- Upstash（Redis）
- Cloudflare（DNS）

### 风险评估
🟡 **中风险**
- ⚠️ Vercel宕机 → 网站完全不可用
- ⚠️ Supabase宕机 → 数据库不可用（但有R2备份）
- ⚠️ GitHub锁定 → 代码仓库不可访问
- ✅ Cloudflare DNS高可用

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🟡 P1 | 创建Railway备份部署配置 | Adeline | 2026-03-20 |
| 🟡 P1 | 测试从R2恢复到本地PostgreSQL | Adeline | 2026-03-20 |
| 🟢 P2 | 设置GitHub到GitLab自动镜像 | Adeline | 2026-04-01 |
| 🟢 P2 | 创建Docker部署配置 | Adeline | 2026-04-01 |

### 建议方案
详见：`docs/DISASTER_RECOVERY.md` ✅ 已创建

---

## 6. 法律合规 🔴

### 当前状态
🔴 **高风险 - 缺少关键法律文档**

**缺失文档：**
- ❌ 隐私政策（Privacy Policy）
- ❌ 服务条款（Terms of Service）
- ❌ Cookie声明
- ❌ robots.txt
- ❌ GDPR数据删除流程

**API使用：**
- Binance API
- Bybit API
- OKX API（需确认）
- Dune Analytics API
- Etherscan API
- Alchemy API
- Solscan API

### 风险评估
🔴 **高风险**
- ⚠️ 收集用户数据但无隐私政策（违反GDPR/CCPA）
- ⚠️ 使用第三方API但未明确ToS
- ⚠️ 无GDPR数据删除请求处理流程
- ⚠️ 缺少robots.txt和sitemap（SEO次要问题）

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🔴 P0 | 起草隐私政策（Privacy Policy） | Adeline | 2026-03-15 |
| 🔴 P0 | 起草服务条款（Terms of Service） | Adeline | 2026-03-15 |
| 🟡 P1 | 审查各交易所API ToS合规性 | Adeline | 2026-03-18 |
| 🟡 P1 | 实现GDPR数据删除请求流程 | Adeline | 2026-03-20 |
| 🟢 P2 | 创建robots.txt | Adeline | 2026-03-16 |

### 建议方案
详见：`docs/LEGAL_COMPLIANCE.md` ✅ 已创建

---

## 7. 上线前检查 🟡

### 当前状态

**SEO和可见性：**
- ✅ Sitemap已配置：https://www.arenafi.org/sitemap.xml
- ❓ Google Search Console未确认
- ❌ 无Analytics（未检测到gtag或Vercel Analytics）

**错误监控：**
- ✅ Sentry已配置
  - DSN: `o4510747817279489.ingest.us.sentry.io`
  - Project: `javascript-nextjs`
  - Org: `arca-h9`
- ❓ 告警邮件未确认
- ❓ 错误追踪Dashboard访问未确认

### 风险评估
🟡 **中风险**
- ⚠️ 无Analytics数据 → 无法追踪用户行为和流量
- ⚠️ Sentry配置已有但未确认告警工作
- ⚠️ Google Search Console未验证 → SEO优化受限

### 行动项
| 优先级 | 任务 | 负责人 | 截止时间 |
|--------|------|--------|----------|
| 🟡 P1 | 添加Vercel Analytics或Google Analytics | Adeline | 2026-03-16 |
| 🟡 P1 | 验证Google Search Console所有权 | Adeline | 2026-03-16 |
| 🟡 P1 | 测试Sentry错误捕获和告警 | Adeline | 2026-03-16 |
| 🟢 P2 | 设置Sentry告警邮件 | Adeline | 2026-03-18 |
| 🟢 P2 | 创建运营监控Dashboard | Adeline | 2026-03-20 |

---

## 总结和优先级

### 🔴 立即处理（P0 - 24小时内）
1. ✅ 创建密钥轮换脚本 - **已完成**
2. 起草隐私政策和服务条款
3. 测试数据库备份恢复流程

### 🟡 短期处理（P1 - 1周内）
1. 轮换暴露的密钥（VPS_PROXY_KEY, Telegram Bot Token）
2. 检查各服务成本使用情况
3. 添加Analytics和确认Sentry配置
4. 审查交易所API ToS合规性

### 🟢 中期处理（P2 - 1个月内）
1. 建立季度密钥轮换计划
2. 创建Railway/Docker备份部署方案
3. 设置GitHub镜像到GitLab
4. 为trader_snapshots创建增量备份策略

---

## 附件
1. `docs/DISASTER_RECOVERY.md` - 灾难恢复计划 ✅
2. `docs/LEGAL_COMPLIANCE.md` - 法律合规检查表 ✅
3. `docs/COST_MONITORING.md` - 成本监控报告 ✅
4. `scripts/security/rotate-secrets.sh` - 密钥轮换脚本 ✅
5. `scripts/backup/supabase-backup.sh` - 数据库备份脚本（参考现有R2备份）

**审计完成时间：** 2026-03-13 14:10 PDT
