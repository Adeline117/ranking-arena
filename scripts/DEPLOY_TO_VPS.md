# Deploy Onchain Enrichment to VPS

## 部署步骤

### 1. 准备VPS环境

```bash
# SSH到Singapore VPS
ssh root@45.76.152.169

# 确保arena目录存在
mkdir -p /opt/arena/scripts/cron

# 确保Node.js已安装
node --version  # 应该是 v18+

# 确保依赖已安装
cd /opt/arena
npm install pg node-fetch
```

### 2. 上传脚本

从本地Mac Mini上传：

```bash
# 从~/arena目录上传脚本
scp ~/arena/scripts/enrich-onchain-all.mjs root@45.76.152.169:/opt/arena/scripts/
scp ~/arena/scripts/test-onchain-apis.mjs root@45.76.152.169:/opt/arena/scripts/
scp ~/arena/scripts/monitor-enrichment.sh root@45.76.152.169:/opt/arena/scripts/
scp ~/arena/scripts/cron/enrich-onchain.sh root@45.76.152.169:/opt/arena/scripts/cron/

# 上传文档
scp ~/arena/scripts/ONCHAIN_ENRICHMENT_README.md root@45.76.152.169:/opt/arena/scripts/
scp ~/arena/scripts/ENRICHMENT_STATUS_REPORT.md root@45.76.152.169:/opt/arena/scripts/

# 设置执行权限
ssh root@45.76.152.169 'chmod +x /opt/arena/scripts/*.mjs /opt/arena/scripts/*.sh /opt/arena/scripts/cron/*.sh'
```

### 3. 配置环境变量

```bash
ssh root@45.76.152.169

# 创建环境配置文件
cat > /opt/arena/.env << 'EOF'
DATABASE_URL=postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres
EOF

# 保护环境文件
chmod 600 /opt/arena/.env
```

### 4. 测试运行

```bash
ssh root@45.76.152.169

# 测试API连通性
cd /opt/arena && node scripts/test-onchain-apis.mjs

# 测试单个平台 (dry-run)
cd /opt/arena && node scripts/enrich-onchain-all.mjs --platform=hyperliquid --batch=5 --dry-run

# 实际运行小批量测试
cd /opt/arena && node scripts/enrich-onchain-all.mjs --platform=hyperliquid --batch=10
```

### 5. 添加到Cron

```bash
ssh root@45.76.152.169

# 编辑crontab
crontab -e

# 添加以下行 (每6小时运行一次)
0 */6 * * * /opt/arena/scripts/cron/enrich-onchain.sh >> /var/log/arena-enrichment.log 2>&1

# 或者，如果使用.env文件：
0 */6 * * * cd /opt/arena && export $(cat .env | xargs) && /opt/arena/scripts/cron/enrich-onchain.sh >> /var/log/arena-enrichment.log 2>&1

# 保存并退出
```

### 6. 创建日志轮转

```bash
ssh root@45.76.152.169

# 创建logrotate配置
cat > /etc/logrotate.d/arena-enrichment << 'EOF'
/var/log/arena-enrichment.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
EOF
```

### 7. 监控设置

```bash
# 创建监控脚本
ssh root@45.76.152.169

cat > /opt/arena/scripts/check-enrichment-health.sh << 'EOF'
#!/bin/bash
# 健康检查脚本 - 检测enrichment是否正常工作

PGPASSWORD='j0qvCCZDzOHDfBka' psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres << 'SQL'
WITH current_status AS (
  SELECT 
    source,
    COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null,
    COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null
  FROM leaderboard_ranks
  WHERE source IN ('hyperliquid', 'aevo', 'gains', 'gmx')
  GROUP BY source
)
SELECT 
  source,
  CASE 
    WHEN wr_null > 1000 OR mdd_null > 1000 THEN '⚠️ HIGH'
    WHEN wr_null > 500 OR mdd_null > 500 THEN '⚠️ MEDIUM'
    ELSE '✅ OK'
  END as status,
  wr_null,
  mdd_null
FROM current_status
ORDER BY wr_null + mdd_null DESC;
SQL
EOF

chmod +x /opt/arena/scripts/check-enrichment-health.sh

# 添加到cron (每天检查)
echo "0 9 * * * /opt/arena/scripts/check-enrichment-health.sh | mail -s 'Arena Enrichment Health' adeline@example.com" | crontab -
```

## 验证部署

### 1. 验证脚本存在

```bash
ssh root@45.76.152.169 'ls -lh /opt/arena/scripts/enrich-onchain-all.mjs'
ssh root@45.76.152.169 'ls -lh /opt/arena/scripts/cron/enrich-onchain.sh'
```

### 2. 验证依赖

```bash
ssh root@45.76.152.169 'cd /opt/arena && node -e "import(\"pg\").then(() => console.log(\"pg OK\"))"'
ssh root@45.76.152.169 'cd /opt/arena && node -e "import(\"node-fetch\").then(() => console.log(\"fetch OK\"))"'
```

### 3. 验证数据库连接

```bash
ssh root@45.76.152.169 'PGPASSWORD="j0qvCCZDzOHDfBka" psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres -c "SELECT COUNT(*) FROM leaderboard_ranks WHERE source = '\''hyperliquid'\'';"'
```

### 4. 验证cron

```bash
ssh root@45.76.152.169 'crontab -l | grep enrich'
```

## 故障排查

### 脚本无法运行

```bash
# 检查权限
ssh root@45.76.152.169 'ls -l /opt/arena/scripts/enrich-onchain-all.mjs'

# 检查Node版本
ssh root@45.76.152.169 'node --version'

# 手动运行查看错误
ssh root@45.76.152.169 'cd /opt/arena && node scripts/enrich-onchain-all.mjs --platform=hyperliquid --batch=5 --dry-run'
```

### Cron不执行

```bash
# 检查cron服务
ssh root@45.76.152.169 'systemctl status cron'

# 查看cron日志
ssh root@45.76.152.169 'tail -50 /var/log/syslog | grep CRON'

# 查看应用日志
ssh root@45.76.152.169 'tail -100 /var/log/arena-enrichment.log'
```

### 数据库连接问题

```bash
# 测试连接
ssh root@45.76.152.169 'PGPASSWORD="j0qvCCZDzOHDfBka" psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres -c "SELECT 1"'

# 检查防火墙
ssh root@45.76.152.169 'ping -c 3 aws-0-us-west-2.pooler.supabase.com'
```

### API Rate Limiting

如果遇到rate limit：

```bash
# 修改batch size
ssh root@45.76.152.169

# 编辑cron脚本，将--batch=200改为--batch=50
nano /opt/arena/scripts/cron/enrich-onchain.sh
```

## 回滚

如果需要回滚：

```bash
ssh root@45.76.152.169

# 停止cron
crontab -e
# 注释掉enrichment行

# 停止运行中的进程
pkill -f enrich-onchain-all.mjs

# 删除脚本 (可选)
rm /opt/arena/scripts/enrich-onchain-all.mjs
```

## 下一步

部署完成后：

1. ✅ 等待第一次cron执行 (6小时后)
2. ✅ 检查日志确认成功: `tail -100 /var/log/arena-enrichment.log`
3. ✅ 验证数据更新: `ssh root@45.76.152.169 '/opt/arena/scripts/monitor-enrichment.sh'`
4. ✅ 设置告警 (如果NULL率持续>50%)

---

**部署时间**: 预计15分钟  
**维护**: 每月检查一次  
**优先级**: HIGH
