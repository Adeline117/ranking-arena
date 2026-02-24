# Arena Vercel Deployment

Vercel 部署注意事项。

## 部署命令

```bash
# CLI 部署（GitHub webhook 可能坏了）
npx vercel deploy --prod --yes --token=$VERCEL_TOKEN

# 部署前必须
touch .env  # gitignored，build 需要
npx tsc --noEmit  # 类型检查
```

## 已知问题

1. **Pro plan 最多 3 regions** — 曾设 17 个导致部署失败好几天
2. **Turbopack 编译**: Vercel 4核8GB 上需 95s（本地 17s），偶尔 hang
3. **Stuck builds**: 用 API 取消
   ```bash
   curl -X PATCH "https://api.vercel.com/v13/deployments/{uid}/cancel" \
     -H "Authorization: Bearer $TOKEN"
   ```
4. **`ssr: false` on provider wrappers**: 会杀掉所有 SSR
5. **Top-level await in lib**: 会导致 build 无限挂起
6. **Stripe**: 当前是 sandbox (pk_test_/sk_test_)

## Pre-push 检查

```bash
touch .env
npx tsc --noEmit
# lint 由 git hook 自动跑
```

## 环境变量

从 Vercel prod 拉取:
```bash
npx vercel env pull .env.local --token=$TOKEN
```

## 更新日志

- 2026-02-23: 创建 skill
