# 发布流程（Release Process）

> 2026-07-02 建立。目标：让"哪个版本引入了什么"可追溯、可回滚到任意版本。
> 配合 `CHANGELOG.md`、`.github/CODEOWNERS`、`/ship` skill。

## 版本号（semver）

- **MAJOR**：破坏性变更（API/schema 不兼容、需迁移动作）
- **MINOR**：向后兼容的新功能
- **PATCH**：向后兼容的 bug 修复
- 移动端版本经 `scripts/sync-version.mjs` 从 package.json 同步。

## 发布一个版本

```bash
# 1. 更新 CHANGELOG.md：把 [Unreleased] 下的条目移到新版本号 + 日期
# 2. bump package.json version（并同步移动端）
node scripts/sync-version.mjs --bump patch   # 或 minor / major
# 3. commit
scripts/git-commit-safe.sh "release: vX.Y.Z" package.json CHANGELOG.md <移动端文件>
# 4. 打注释 tag 并推
git tag -a vX.Y.Z -m "vX.Y.Z — <一句话>"
git push origin vX.Y.Z
# 5. CI 门禁绿后 deploy-gate 自动部署（见 RUNBOOK「部署管线」）
```

## 回滚

版本可回滚到任意 tag。生产回滚锚点 = Vercel 部署历史（每个 READY 部署带
`--meta gateSha`），promote 上一个 READY 即可（RUNBOOK「Deployment Rollback」）。

## 分支保护 recipe（团队化时启用，当前 owner bypass 不影响单人流）

现状 `protect main` ruleset = deletion + non_fast_forward + pull_request，
owner 角色 bypass 全部。团队化时补 **required status checks**，让 CI 门禁在
GitHub 层强制（与 Vercel 门禁互补）：

```bash
# 把 CI 四个门禁作业设为 required（context 名必须精确匹配 job name）
RID=$(gh api repos/Adeline117/ranking-arena/rulesets --jq '.[0].id')
gh api -X PUT "repos/Adeline117/ranking-arena/rulesets/$RID" --input - <<'JSON'
{
  "rules": [
    {"type":"deletion"},
    {"type":"non_fast_forward"},
    {"type":"pull_request","parameters":{"required_approving_review_count":1,"require_code_owner_review":true,"dismiss_stale_reviews_on_push":true,"required_review_thread_resolution":false,"require_last_push_approval":false}},
    {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"required_status_checks":[
      {"context":"Pre-flight Checks"},
      {"context":"Lint & Type Check"},
      {"context":"Unit Tests"},
      {"context":"Build"}
    ]}}
  ]
}
JSON
# 完全团队化（移除 owner bypass）时，再清空 bypass_actors。
```

⚠️ 启用 required checks 后，若要保留单人直推能力，保留 owner bypass 即可；
只在真正多人协作、要求 PR review 时移除 bypass。
