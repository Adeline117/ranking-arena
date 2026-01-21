# Git Workflow 规范

## 分支策略

### 主分支
- `main` - 生产分支，只接受 PR 合并，禁止直接 push

### 功能分支命名
```
feature/<简短描述>    # 新功能
fix/<简短描述>        # Bug 修复
refactor/<简短描述>   # 代码重构
docs/<简短描述>       # 文档更新
chore/<简短描述>      # 构建/配置相关
```

### Claude 生成分支
```
claude/<描述>-<session-id>  # Claude 自动生成的分支
```

## PR 合并流程

### 提交前检查清单
1. [ ] `npm run lint` 通过
2. [ ] `npm run type-check` 通过
3. [ ] `npm test` 通过
4. [ ] `npm run build` 成功
5. [ ] 本地已 rebase 最新 main

### 合并前必须执行
```bash
# 1. 获取最新 main
git fetch origin main

# 2. Rebase 到最新 main（推荐）
git rebase origin/main

# 3. 如果有冲突，解决后继续
git rebase --continue

# 4. 强制推送（仅限自己的分支）
git push -f origin <your-branch>
```

### 禁止操作
- **禁止** 直接 push 到 main
- **禁止** 使用 `git merge main` 创建合并提交
- **禁止** `git push --force origin main`
- **禁止** 跳过 CI 检查（`--no-verify`）

## Commit Message 规范

### 格式
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Type 类型
- `feat` - 新功能
- `fix` - Bug 修复
- `docs` - 文档更新
- `style` - 代码格式（不影响逻辑）
- `refactor` - 重构
- `perf` - 性能优化
- `test` - 测试相关
- `chore` - 构建/工具相关
- `ci` - CI 配置
- `revert` - 回滚

### Scope 范围
- `db` - 数据库/迁移
- `api` - API 路由
- `ui` - 前端组件
- `stripe` - 支付相关
- `auth` - 认证相关
- `i18n` - 国际化
- `perf` - 性能相关

### 示例
```
feat(api): add trader comparison endpoint

- Support comparing up to 5 traders
- Include ROI, drawdown, win rate metrics
- Add caching for comparison results

Closes #123
```

## 数据库迁移规范

### 文件命名
```
supabase/migrations/00XXX_<description>.sql
```

### 版本号规则
- 使用 5 位数字前缀：`00001`, `00002`, ..., `00012`
- **禁止** 使用重复版本号
- 每次新增迁移前检查：`ls supabase/migrations/`

### 迁移内容规范
```sql
-- 描述这个迁移做什么
-- 版本: 00XXX
-- 创建日期: YYYY-MM-DD
-- 相关 PR: #XXX

-- 你的 SQL 代码
```

## 冲突解决策略

### 常见冲突文件
1. `package-lock.json` - 删除后重新 `npm install`
2. `supabase/migrations/` - 重命名版本号避免冲突
3. `lib/i18n.ts` - 手动合并翻译 key

### 解决步骤
```bash
# 1. 查看冲突文件
git status

# 2. 编辑文件解决冲突
# 删除 <<<<<<<, =======, >>>>>>> 标记

# 3. 标记已解决
git add <resolved-files>

# 4. 继续 rebase
git rebase --continue
```

## 紧急修复流程

### Hotfix 分支
```bash
git checkout main
git pull origin main
git checkout -b hotfix/<description>

# 修复后
git push -u origin hotfix/<description>
# 创建 PR 并请求紧急审查
```

---

最后更新: 2026-01-21
