# 环境变量审计指南 (Environment Variables Audit)

> 项目环境隔离状态良好。此文档记录现状和待改进项。

---

## 现状（已到位）

| 检查项                            | 状态                                 |
| --------------------------------- | ------------------------------------ |
| `.env` 文件被 .gitignore 忽略     | ✅ 安全                              |
| `.env.example` 模板完整（191 行） | ✅ 齐全                              |
| Zod 验证（`lib/env.ts`）          | ✅ 关键变量有类型校验                |
| 代码中无硬编码密钥                | ✅ 全部扫描通过                      |
| 服务端密钥与客户端隔离            | ✅ NEXT*PUBLIC* 前缀区分             |
| timing-safe 密钥比较              | ✅ `lib/auth/verify-service-auth.ts` |
| 敏感数据加密存储                  | ✅ AES-256-CBC 加密 OAuth token      |

---

## 环境分层

| 环境              | 配置方式                     | 密钥存储         |
| ----------------- | ---------------------------- | ---------------- |
| 开发 (dev)        | `.env.local` 文件            | 本地文件，不提交 |
| 预览 (preview)    | Vercel Environment Variables | Vercel 加密存储  |
| 生产 (production) | Vercel Environment Variables | Vercel 加密存储  |

---

## 如何新建环境

1. 复制 `.env.example` 为 `.env.local`
2. 填入开发环境的值
3. 生产环境的值在 Vercel Dashboard → Settings → Environment Variables 配置

---

## 待改进项（低优先级）

**22 处 `process.env.XXX` 直接访问**应改为使用 `lib/env.ts` 的 `env.XXX`：

涉及文件（其他 session 的代码，避免并行修改冲突）：

- `app/api/exchange/oauth/callback/route.ts` (3 处)
- `app/api/exchange/oauth/refresh/route.ts` (4 处)
- `app/api/exchange/oauth/authorize/route.ts` (2 处)
- `app/api/health/detailed/route.ts` (2 处)
- `app/api/stream/prices/route.ts` (2 处)
- `app/api/admin/sync-subscription/route.ts` (2 处)
- `app/api/translate/route.ts` (1 处)
- `app/api/health/route.ts` (2 处)
- `app/api/test/route-matrix/route.ts` (3 处)
- `app/api/pipeline/ingest/route.ts` (1 处)

**改法**：把 `process.env.XXX` 替换为 `env.XXX`（从 `@/lib/env` 导入），如果 `env.ts` 里没有定义这个变量就先加上。
