# K6 性能测试

## 测试场景

| 场景         | 文件               | 模拟行为                 | 商业意义                                |
| ------------ | ------------------ | ------------------------ | --------------------------------------- |
| 冒烟测试     | `smoke-test.js`    | 2 用户，1 分钟           | 验证基本功能在最小负载下是否正常        |
| 用户负载测试 | `load-test.js`     | 50-100 并发用户，10 分钟 | 评估完整浏览路径的体验和服务器成本      |
| API 负载测试 | `api-load-test.js` | 10-50 并发用户，1 分钟   | 隔离排名、搜索和市场 API 的延迟与错误率 |
| 压力测试     | `stress-test.js`   | 10→100 分阶段爬升        | 模拟行情暴涨/大 V 转发后的瞬间流量      |

## 快速开始

```bash
# 安装 k6 (macOS)
brew install k6

# 登录 k6 Cloud (可选)
k6 cloud login --token YOUR_TOKEN
```

## 运行测试

### 本地运行

```bash
# 冒烟测试 - 快速验证（必须显式选择 preview/staging）
k6 run -e BASE_URL=https://your-preview.example.com k6/smoke-test.js

# 负载测试 - 日常流量
k6 run -e BASE_URL=https://your-preview.example.com k6/load-test.js

# API 负载测试 - 短时接口基线
k6 run -e BASE_URL=https://your-preview.example.com k6/api-load-test.js

# 压力测试 - 极限压力 ⚠️
k6 run -e BASE_URL=https://your-preview.example.com k6/stress-test.js
```

### 云端运行 (推荐)

```bash
# 结果上传到 Grafana Cloud 查看详细报告
k6 cloud -e BASE_URL=https://your-preview.example.com k6/smoke-test.js
k6 cloud -e BASE_URL=https://your-preview.example.com k6/load-test.js
k6 cloud -e BASE_URL=https://your-preview.example.com k6/stress-test.js
```

## 测试配置

### 冒烟测试

- 用户数: 2
- 持续时间: 1 分钟
- 阈值: P95 < 1s, 错误率 < 1%

### 负载测试

- 阶段:
  1. 1 分钟爬升到 50 用户
  2. 保持 50 用户 3 分钟
  3. 1 分钟爬升到 100 用户
  4. 保持 100 用户 3 分钟
  5. 2 分钟降到 0
- 阈值: P95 < 2s, 错误率 < 5%

### 压力测试

- 阶段:
  1. 预热: 10 用户
  2. 正常/高负载: 30→60 用户
  3. 极限: 100 用户（当前 Cloud 限额）
  4. 回落: 50→20→0
- 阈值: P95 < 3s, 错误率 < 10%

## 报告查看

云端测试完成后，访问:
https://tyche1107.grafana.net/a/k6-app

## 性能指标说明

| 指标                | 说明         | 目标值   |
| ------------------- | ------------ | -------- |
| `http_req_duration` | 请求响应时间 | P95 < 2s |
| `http_req_failed`   | 请求失败率   | < 5%     |
| `page_load_time`    | 页面加载时间 | P95 < 3s |
| `api_response_time` | API 响应时间 | P95 < 1s |

## 注意事项

1. **压力测试** 会产生大量请求，可能触发限流或成本；默认拒绝缺失 `BASE_URL` 的运行
2. 默认使用 preview/staging。生产必须有明确变更授权并额外传
   `-e ALLOW_PRODUCTION_LOAD=1 -e BASE_URL=https://www.arenafi.org`
3. 首次运行建议使用冒烟测试验证配置
4. 云端测试需要 k6 Cloud 账号
