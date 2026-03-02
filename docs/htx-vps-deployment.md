# HTX Futures VPS Cron Deployment

## ✅ 部署完成 (2026-03-02)

### 概述
HTX Futures 数据抓取已成功部署到 Singapore VPS，使用cron自动化每6小时抓取一次。

### 部署信息

**VPS详情:**
- 主机: 45.76.152.169
- 位置: Singapore
- OS: Ubuntu 24.04 LTS (x86_64)
- 用户: root

**Cron调度:**
- 频率: 每6小时
- 时间: 00:00, 06:00, 12:00, 18:00 UTC
- 对应北京时间: 08:00, 14:00, 20:00, 02:00 CST

**文件位置:**
- Cron脚本: `/root/ranking-arena/vps-cron-htx.sh`
- 日志目录: `/var/log/ranking-arena/`
- 日志文件: `/var/log/ranking-arena/htx-futures-YYYYMMDD.log`
- Cron日志: `/var/log/ranking-arena/cron.log`

### 数据验证结果

**数据质量 (90D Period):**
- Total traders: 552
- Win Rate coverage: 100% (0 NULL)
- Max Drawdown coverage: 93.1% (38 NULL, 6.9%)

**最近执行 (2026-03-02 21:20 UTC):**
```
✅ 抓取成功
耗时: 23.8秒
数据保存: 7D=146, 30D=447, 90D=214
```

### 运维命令

**查看cron配置:**
```bash
ssh root@45.76.152.169 'crontab -l'
```

**手动触发执行:**
```bash
ssh root@45.76.152.169 '/root/ranking-arena/vps-cron-htx.sh'
```

**查看实时日志:**
```bash
ssh root@45.76.152.169 'tail -f /var/log/ranking-arena/htx-futures-*.log'
```

**查看cron执行日志:**
```bash
ssh root@45.76.152.169 'tail -f /var/log/ranking-arena/cron.log'
```

**查看所有日志文件:**
```bash
ssh root@45.76.152.169 'ls -lh /var/log/ranking-arena/'
```

### 环境变量

在VPS的 `~/.bashrc` 中已配置：
```bash
export CRON_SECRET='arena-cron-secret-2025'
export API_ENDPOINT='https://ranking-arena.vercel.app'
```

### 日志管理

- **保留期**: 30天
- **自动清理**: 每周日 03:00 UTC 清理30天前的日志
- **日志格式**: `htx-futures-YYYYMMDD.log`

### 监控和告警

当前监控指标：
1. HTTP状态码（200 = 成功）
2. 抓取耗时
3. 保存的记录数 (7D/30D/90D)
4. 任何错误信息都会记录到日志

建议添加：
- 失败时发送Telegram告警
- 监控每日执行次数（应为4次）
- 监控数据新鲜度

### 下一步优化

1. **Enrichment部署**: 将HTX enrichment也部署到VPS cron
2. **告警集成**: 失败时自动通知Telegram
3. **性能监控**: 记录历史执行时间趋势
4. **备份策略**: VPS脚本和配置的git备份

### 相关文件

本地项目文件：
- `vps-cron-htx.sh` - VPS cron脚本
- `vps-crontab-htx.txt` - Crontab配置
- `deploy-vps-cron.sh` - 部署脚本
- `verify-htx-data.js` - 数据验证脚本

### 重新部署

如需重新部署或更新配置：
```bash
cd ~/ranking-arena
./deploy-vps-cron.sh
```

---

**部署人员**: 小昭 (Subagent)  
**部署时间**: 2026-03-02 21:20 UTC  
**验证状态**: ✅ 通过  
**下次检查**: 2026-03-03 00:00 UTC (自动执行)
