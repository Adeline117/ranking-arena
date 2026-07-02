# PM-202606：ingest worker EDBHANDLEREXITED 反复崩溃

| 字段     | 值                                                         |
| -------- | ---------------------------------------------------------- |
| 日期     | 2026-06 下旬；间歇性崩溃反复多日                           |
| 严重度   | SEV2（数据管道中断，排行榜数据新鲜度受损，用户可感知延迟） |
| 用户影响 | 排行榜/交易员数据更新延迟                                  |
| 检测方式 | worker 崩溃告警 + 心跳哨兵                                 |

## 时间线

- worker 间歇性以 EDBHANDLEREXITED 崩溃，首次修复（d548744ff）用正则匹配错误
  文本做 band-aid，无效，继续崩
- 复现测试 `scripts/test-edbhandler-repro.mts` 定位真因
- 根治修复 5926fc9ce 部署两节点（Mac Mini + SG VPS）后稳定

## 根因

直接原因：postgres checked-out client 断连时 emit 'error' 无监听器 →
Node uncaughtException → 进程崩溃。
共 6 个 `pool.connect()` 调用点均未挂 `client.on('error')`。
系统性根因：**第一次修复凭错误信息猜测原因（正则匹配 band-aid），没有先建
复现**——修复未经验证就宣告完成，浪费一轮部署并延长事故。

## 修复

- 止血：PM2/容器自动重启兜底
- 根治：`ingestClientConnect()` helper 统一挂 error 监听（5926fc9ce），
  复现测试证明 band-aid 无效、helper 有效；两节点部署

## 防再犯

- [x] 复现测试入库（scripts/test-edbhandler-repro.mts）
- [x] ingestClientConnect() 作为唯一 connect 入口
- [x] worker-heartbeat-check cron（≥2 live SHA 或心跳 stale 告警）
- [ ] eslint/pre-push guard：裸 `pool.connect()` 禁令（可加入棘轮）

## 教训

"修前先核实"同样适用于修复本身：没有复现的修复只是猜测。凭错误文本
pattern-match 到"已知问题"是最常见的误诊路径。
