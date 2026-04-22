# Sentry 错误监控验证指南

> 项目已完整集成 Sentry。按以下步骤确认一切正常运作。

---

## 已有的配置（不需要改动）

| 组件       | 文件                                     | 作用                                |
| ---------- | ---------------------------------------- | ----------------------------------- |
| 服务端捕获 | `sentry.server.config.ts`                | 捕获 API 路由和后端错误             |
| 边缘运行时 | `sentry.edge.config.ts`                  | 捕获中间件错误                      |
| 客户端捕获 | `lib/sentry-init.ts`                     | 延迟加载，不影响页面速度            |
| 错误边界   | `app/components/utils/ErrorBoundary.tsx` | 页面崩溃时自动上报                  |
| 全局错误页 | `app/global-error.tsx`                   | 兜底错误页面                        |
| Web Vitals | `app/components/Providers/WebVitals.tsx` | 性能指标上报                        |
| 日志集成   | `lib/utils/logger.ts`                    | 所有 logger.error() 自动发到 Sentry |

---

## 验证步骤

### 1. 确认环境变量已配置

在 Vercel Dashboard 中检查以下变量已设置（不是 placeholder）：

- `NEXT_PUBLIC_SENTRY_DSN` — 格式: `https://xxx@xxx.ingest.us.sentry.io/xxx`
- `SENTRY_DSN` — 同上（用于服务端）

### 2. 登录 Sentry 后台

- 打开 https://sentry.io 并登录
- 进入你的项目（org / project 对应 `.env` 里的 `SENTRY_ORG` / `SENTRY_PROJECT`）

### 3. 确认有错误数据进来

- 在 Sentry 后台点 **Issues** 左侧菜单
- 应该能看到最近的错误事件
- 如果完全没有数据，可能 DSN 配置不对

### 4. 确认告警规则

- 在 Sentry 后台 → **Alerts** → **Alert Rules**
- 建议至少设置这些规则：
  - 新问题（New Issue）→ 发邮件或 Slack 通知
  - 错误激增（Spike in errors）→ 紧急通知
  - P0 标签的错误 → 立即通知

### 5. 测试错误上报

在浏览器控制台执行（仅用于测试，会发一条测试错误到 Sentry）：

```javascript
// 打开网站 → F12 → Console → 粘贴执行
throw new Error('Sentry test from console')
```

然后去 Sentry 后台看是否收到了这条。

---

## 已知限制

- **Source maps 未上传**：线上错误的堆栈是压缩过的代码，不易读。这是一个已知的优化取舍（节省了 ~200KB 包体积）。
- **客户端 Sentry 延迟加载**：页面打开后 2 秒才初始化 Sentry，极早期的错误可能捕获不到。这是性能和监控的平衡取舍。
