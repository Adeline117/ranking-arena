# Arena VPS Cron Management

VPS 数据抓取 cron 管理经验。

## 基础设施

| 服务器 | IP | 用途 |
|--------|-----|------|
| Singapore | 45.76.152.169 | Arena crons, news |
| Japan | 149.28.27.242 | Polymarket 订单 |
| Mac Mini | localhost | Puppeteer tasks, enrichment |

## VPS 文件结构

```
/opt/arena/
├── cron_refresh.sh          # 主 cron 入口
├── scripts/import/          # 导入脚本
├── scripts/lib/shared.mjs   # 共享工具
├── node_modules/            # 依赖
└── .env                     # 环境变量
```

**⚠ VPS 有两个路径**: `/opt/arena/` (cron) + `/opt/ranking-arena/` (git clone)
push 后必须同步两边！

## Crontab

```bash
# 每小时主刷新
0 * * * * flock -n /tmp/arena_major.lock /opt/arena/cron_refresh.sh major >> /opt/arena/logs/cron.log 2>&1

# 每3小时次要刷新
0 */3 * * * flock -n /tmp/arena_minor.lock /opt/arena/cron_refresh.sh minor >> /opt/arena/logs/cron.log 2>&1
```

**关键**: 用 `flock` 防止重叠执行！

## 常用运维命令

```bash
# SSH 进入
ssh root@45.76.152.169

# 查看 cron 日志
tail -50 /opt/arena/logs/cron.log

# 手动跑一次
bash /opt/arena/cron_refresh.sh major

# 同步代码
cd /opt/ranking-arena && git pull && cp -r scripts/ /opt/arena/scripts/

# 检查进程
ps aux | grep node
```

## Mac Mini Cron (LaunchAgent)

```bash
# 位置
~/Library/LaunchAgents/com.arena.daily-checkpoint.plist

# 查看状态
launchctl list | grep arena

# 重启
launchctl unload ~/Library/LaunchAgents/com.arena.daily-checkpoint.plist
launchctl load ~/Library/LaunchAgents/com.arena.daily-checkpoint.plist
```

## Enrichment Master Loop

```bash
# 脚本
~/ranking-arena/scripts/import/enrich_master_loop.mjs

# 日志
tail -f /tmp/enrich_master.log

# 坑: 30分钟 backoff sleep
# 如果3轮无进展会睡30分钟，需要手动重启
```

## 踩坑

- VPS Puppeteer 已损坏 — bybit_spot/bitget_spot 移到 Mac Mini
- VPS node 版本需要和本地一致
- `DATABASE_URL` 在 .env 里，不要硬编码
- cron 输出必须 redirect 到日志，否则 crontab 邮件爆炸
