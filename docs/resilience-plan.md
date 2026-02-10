# 系统加固与灾备方案

## 当前单点故障风险

### 1. VPS (45.76.152.169)
- **风险**: Vultr限CPU、机器宕机、网络中断
- **影响**: scraper停止、数据不更新
- **备选方案**:
  - Mac Mini M4作为备用scraper（已配置好环境）
  - Supabase Edge Functions作为轻量API scraper备选
  - 多VPS部署（不同地域）

### 2. Supabase 数据库
- **风险**: Supabase服务中断、配额耗尽
- **影响**: 全站无法访问数据
- **备选方案**:
  - 启用Supabase自动备份（已开启）
  - 定期pg_dump到本地/S3
  - 读写分离：Upstash Redis缓存热数据

### 3. Vercel 部署
- **风险**: 部署失败、服务中断
- **影响**: 网站不可访问
- **备选方案**:
  - 保持上一个成功部署版本可回滚
  - 备选部署到Cloudflare Pages
  - 静态资源CDN缓存

### 4. API数据源（交易所）
- **风险**: 交易所API变更、封禁IP、限流
- **影响**: 单个交易所数据停更
- **备选方案**:
  - 每个交易所至少2种抓取方式（API + 浏览器scrape）
  - 多IP轮换（VPS + Mac Mini + 代理）
  - 数据缓存保留最后成功数据，不清空

### 5. Chrome/Puppeteer 进程
- **风险**: 内存泄漏、进程僵死、CPU飙高（已发生过）
- **影响**: VPS过载、被Vultr限制（已发生）
- **备选方案**:
  - flock锁防止并发（已实施）
  - 进程数监控+自动清理（已实施）
  - 超时自动kill（timeout命令已用）
  - OOM killer配置

## 已实施的加固措施

1. ✅ flock锁防cron重叠
2. ✅ Chrome进程数监控
3. ✅ PM2自动重启
4. ✅ VPS健康检查cron（每2小时）
5. ✅ Upstash Redis缓存热数据
6. ✅ 错误处理+Toast提示
7. ✅ Error Boundary全站覆盖

## 待实施

1. [ ] pg_dump每日备份到Mac Mini
2. [ ] 多交易所数据源冗余
3. [ ] Mac Mini作为备用scraper
4. [ ] API监控告警（数据超过2小时未更新则通知）
5. [ ] Vercel部署失败自动回滚
6. [ ] 关键表定期VACUUM
