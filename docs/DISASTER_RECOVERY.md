# Arena 灾难恢复计划 (Disaster Recovery Plan)
**版本：** 1.0  
**日期：** 2026-03-13  
**负责人：** Adeline Wen  
**审核周期：** 每季度

---

## 目录
1. [灾难场景定义](#灾难场景定义)
2. [恢复目标 (RTO/RPO)](#恢复目标)
3. [服务依赖地图](#服务依赖地图)
4. [备份策略](#备份策略)
5. [恢复流程](#恢复流程)
6. [应急联系人](#应急联系人)
7. [测试计划](#测试计划)

---

## 灾难场景定义

### 场景1：Vercel完全宕机 🔴
**影响：** 网站完全不可用  
**概率：** 低  
**RTO：** 4小时  
**RPO：** 0（代码无损）

### 场景2：Supabase数据库宕机 🔴
**影响：** 数据读写失败，网站部分功能不可用  
**概率：** 低  
**RTO：** 2小时  
**RPO：** 24小时（最后一次R2备份）

### 场景3：GitHub仓库锁定/删除 🟡
**影响：** 无法部署新代码，CI/CD中断  
**概率：** 极低  
**RTO：** 1小时  
**RPO：** 0（本地副本 + GitLab镜像）

### 场景4：Cloudflare DNS劫持/宕机 🟡
**影响：** 域名解析失败  
**概率：** 极低  
**RTO：** 30分钟（切换DNS提供商）  
**RPO：** N/A

### 场景5：本地Mac Mini故障 🟢
**影响：** 备份脚本、cron任务失败  
**概率：** 中  
**RTO：** 24小时  
**RPO：** 24小时

---

## 恢复目标

| 服务 | RTO（恢复时间） | RPO（数据丢失容忍） | 优先级 |
|------|----------------|---------------------|--------|
| 生产网站 | 4小时 | 0 | P0 |
| 数据库 | 2小时 | 24小时 | P0 |
| Cron任务 | 24小时 | 24小时 | P1 |
| 备份系统 | 48小时 | 48小时 | P2 |

---

## 服务依赖地图

```
Arena Production Stack
├── Frontend (Next.js)
│   ├── Vercel (主) ✅
│   └── Railway (备) ❌ 待配置
├── Database
│   ├── Supabase PostgreSQL (主) ✅
│   ├── R2 Backups (备) ✅
│   └── Local PostgreSQL (应急) ❌ 待配置
├── Cache
│   ├── Upstash Redis (主) ✅
│   └── 无备份 ❌
├── DNS
│   ├── Cloudflare (主) ✅
│   └── 无备份DNS ❌
├── 代码仓库
│   ├── GitHub (主) ✅
│   └── GitLab镜像 (备) ❌ 待配置
└── 密钥管理
    ├── Vercel环境变量 ✅
    └── .env本地备份 ✅
```

---

## 备份策略

### 1. 数据库备份 (Automated)
**脚本：** `scripts/maintenance/backup-to-r2.mjs`

**每日备份（Trader表）：**
```bash
# Mac Mini cron: 每天凌晨3点
0 3 * * * cd ~/ranking-arena && npm run backup:r2 >> /tmp/arena-backup.log 2>&1
```

**每周完整备份（全库）：**
```bash
# Mac Mini cron: 每周日凌晨4点
0 4 * * 0 cd ~/ranking-arena && npm run backup:r2:full >> /tmp/arena-backup-full.log 2>&1
```

**备份保留策略：**
- 每日备份：保留30天
- 每周完整备份：保留90天
- 月度归档：永久保留（每月第一个周日）

**备份位置：** Cloudflare R2 `arena-backups/db-backups/YYYY/MM/`

### 2. 代码备份
- **主仓库：** GitHub (Adeline117/ranking-arena)
- **自动镜像：** ❌ 待配置 GitLab
- **本地副本：** Mac Mini `/Users/adelinewen/ranking-arena`

### 3. 环境变量备份
- **Vercel：** 所有环境变量已配置
- **本地：** `.env` 文件（Git忽略）
- **备份：** 加密后存储在1Password或安全位置

---

## 恢复流程

### 流程1：Vercel宕机 → 切换到Railway

#### 前置准备（现在完成）
1. 创建Railway项目并配置环境变量
```bash
# 1. 安装Railway CLI
brew install railway

# 2. 登录Railway
railway login

# 3. 初始化项目
cd ~/ranking-arena
railway init

# 4. 配置环境变量
railway variables set NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
railway variables set NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
# ... 复制所有.env变量
```

2. 测试Railway部署
```bash
railway up
```

#### 应急切换步骤（灾难发生时）
**预计时间：30分钟**

```bash
# 1. 确认Vercel确实宕机
curl -I https://www.arenafi.org

# 2. 立即部署到Railway
cd ~/ranking-arena
git pull origin main
railway up --detach

# 3. 获取Railway部署URL
railway status
# 输出示例：https://ranking-arena-production-xxxx.up.railway.app

# 4. 更新DNS CNAME（Cloudflare）
# 登录Cloudflare → DNS → 编辑www记录
# 原: www CNAME cname.vercel-dns.com
# 新: www CNAME ranking-arena-production-xxxx.up.railway.app

# 5. 等待DNS传播（通常<5分钟）
dig www.arenafi.org +short

# 6. 验证网站可访问
curl -I https://www.arenafi.org
```

---

### 流程2：Supabase数据库宕机 → 恢复到本地PostgreSQL

#### 前置准备（现在完成）
1. 安装PostgreSQL 17
```bash
brew install postgresql@17
brew services start postgresql@17
```

2. 创建应急数据库
```bash
createdb arena_emergency
```

#### 应急恢复步骤（灾难发生时）
**预计时间：1-2小时**

```bash
# 1. 从R2下载最新备份
aws s3 cp s3://arena-backups/db-backups/$(date +%Y/%m/arena-backup-$(date +%Y-%m-%d).sql.gz) /tmp/ \
  --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com

# 2. 解压并恢复
gunzip /tmp/arena-backup-*.sql.gz
psql arena_emergency < /tmp/arena-backup-*.sql

# 3. 更新应用连接字符串
# 临时修改.env（不提交）
DATABASE_URL="postgresql://localhost/arena_emergency"

# 4. 重启应用（Vercel需手动触发redeploy）
vercel --prod

# 5. 验证数据完整性
psql arena_emergency -c "SELECT COUNT(*) FROM traders;"
psql arena_emergency -c "SELECT COUNT(*) FROM trader_snapshots;"

# 6. Supabase恢复后切回
# 恢复原DATABASE_URL
# 重新部署Vercel
```

---

### 流程3：GitHub锁定 → 切换到GitLab镜像

#### 前置准备（现在完成）
1. 创建GitLab镜像
```bash
# 1. 在GitLab创建私有仓库
# gitlab.com/adeline117/ranking-arena

# 2. 添加GitLab remote
cd ~/ranking-arena
git remote add gitlab git@gitlab.com:adeline117/ranking-arena.git

# 3. 推送所有分支
git push gitlab --all
git push gitlab --tags

# 4. 设置自动镜像（GitHub Action）
# .github/workflows/mirror-to-gitlab.yml
```

#### 应急切换步骤（灾难发生时）
**预计时间：15分钟**

```bash
# 1. 确认GitHub不可用
git fetch origin  # 失败

# 2. 切换到GitLab
git remote set-url origin git@gitlab.com:adeline117/ranking-arena.git

# 3. 拉取最新代码
git pull origin main

# 4. 更新Vercel部署源
# Vercel Dashboard → Settings → Git Repository
# 连接到GitLab仓库

# 5. 触发部署
vercel --prod
```

---

### 流程4：Cloudflare DNS劫持 → 切换DNS提供商

#### 前置准备（建议）
- 在Route53或其他DNS提供商创建Zone（但不激活）
- 保存所有DNS记录的备份

#### 应急切换步骤
**预计时间：30分钟（DNS传播可能需要24-48小时）**

```bash
# 1. 登录域名注册商（需确认是哪家）
# 2. 更改Name Servers
# 从: Cloudflare NS
# 到: Route53 / Cloudflare Registrar自带DNS

# 3. 在新DNS提供商添加记录
# A记录: @ → Vercel IP
# CNAME: www → cname.vercel-dns.com
# MX记录（如有邮箱）
# TXT记录（SPF, DKIM, etc.）

# 4. 等待DNS传播
dig arenafi.org @8.8.8.8
```

---

## 应急联系人

| 服务 | 联系方式 | SLA |
|------|----------|-----|
| Vercel Support | support@vercel.com | Pro计划：4h响应 |
| Supabase Support | support@supabase.io | Pro计划：1h响应 |
| Cloudflare Support | 24/7 chat | Pro计划：2h响应 |
| GitHub Support | support@github.com | Premium：1h响应 |

**关键人员：**
- **项目负责人：** Adeline Wen
- **备份负责人：** （待指定）

---

## 测试计划

### 每月测试（第一个周日）
- [ ] 从R2恢复最新备份到本地数据库
- [ ] 验证数据完整性
- [ ] 测试Railway备份部署
- [ ] 检查DNS备份配置

### 每季度测试（Q1/Q2/Q3/Q4第一周）
- [ ] 完整灾难恢复演练（包括DNS切换）
- [ ] 测试GitLab镜像拉取
- [ ] 审查和更新本文档
- [ ] 验证应急联系人信息

### 测试记录
| 日期 | 测试场景 | 结果 | RTO实际 | 问题 | 改进措施 |
|------|----------|------|---------|------|----------|
| 2026-03-XX | 待进行 | - | - | - | - |

---

## 附录：备份部署配置

### Railway配置文件（待创建）
`railway.toml`
```toml
[build]
builder = "nixpacks"
buildCommand = "npm run build"

[deploy]
startCommand = "npm start"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
restartPolicyType = "on-failure"
restartPolicyMaxRetries = 3

[[services]]
name = "web"
```

### Docker配置（可选）
`Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

---

**文档版本历史：**
- v1.0 (2026-03-13): 初始版本
- v1.1 (待定): 添加Railway实际部署测试结果

**下次审核日期：** 2026-06-13
