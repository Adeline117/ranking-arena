# 回滚急救手册 (Rollback Emergency Guide)

> 这份手册用**非技术语言**写成。遇到问题时，把对应命令发给 Claude 或粘贴到终端执行即可。

---

## 1. 查看历史——最近改了什么？

```bash
# 看最近 10 次提交（每行一条，最新在上面）
git log --oneline -10

# 看某一次提交具体改了什么（把 abc1234 换成你要看的那条编号）
git show abc1234

# 看最近一次提交改了哪些文件
git show --stat HEAD

# 看当前有哪些还没保存的改动
git status
```

---

## 2. 撤销改动——三种情况

### 情况 A：改了文件，但还没 commit（还没"存档"）

```bash
# 丢弃某个文件的改动，恢复到上次存档的状态
git checkout -- 文件路径

# 丢弃所有文件的改动（⚠️ 不可恢复，慎用）
git checkout -- .
```

### 情况 B：已经 commit 了，但还没 push（存档了但没推送到远程）

```bash
# 撤销最近一次 commit，但保留文件改动（可以重新修改后再存档）
git reset --soft HEAD~1

# 撤销最近一次 commit，同时丢弃文件改动（⚠️ 不可恢复）
git reset --hard HEAD~1
```

### 情况 C：已经 push 了（已推送到远程/线上）

```bash
# 用一个"反向提交"来抵消某次改动（安全，不会丢失历史）
# 把 abc1234 换成你要撤销的那次提交编号
git revert abc1234
git push origin main
```

---

## 3. 回滚到昨天（或任意过去时间点）

```bash
# 第一步：找到昨天最后一次提交的编号
git log --oneline --before="yesterday" -1

# 第二步：查看那时的代码（只是"看看"，不会改动当前代码）
git log --oneline --before="yesterday" -5

# 第三步：如果确定要回滚到那个版本
# 方法 A（推荐）—— 创建一个新提交来恢复，保留完整历史：
git revert --no-commit HEAD..abc1234
git commit -m "revert: 回滚到 abc1234（昨天的版本）"
git push origin main

# 方法 B（应急）—— 直接重置到那个版本（⚠️ 会丢失之后所有提交）：
git reset --hard abc1234
git push --force origin main
```

---

## 4. 改代码前先"存档"——建新分支

每次要做大改动之前，先建一个分支，相当于"在旁边复制一份来改"：

```bash
# 建一个新分支并切换过去（名字自己取，比如 fix/xxx 或 feature/xxx）
git checkout -b safety/改动描述

# 在这个分支上随便改，改完后存档
git add .
git commit -m "描述你改了什么"

# 如果改成功了，合并回主分支
git checkout main
git merge safety/改动描述
git push origin main

# 如果改失败了，直接切回主分支，分支可以删掉
git checkout main
git branch -d safety/改动描述
```

---

## 5. Vercel 线上回滚（网站出问题时）

如果线上网站挂了，不需要碰代码，直接在 Vercel 后台操作：

1. 打开 [Vercel Dashboard](https://vercel.com/dashboard)
2. 进入 ranking-arena 项目
3. 点击 **Deployments**（部署记录）
4. 找到上一次正常的部署（绿色 ✅ 的那个）
5. 点击右边的 **⋯** 菜单 → **Promote to Production**
6. 网站会在几秒内恢复到那个版本

---

## 6. 紧急联系清单

| 场景 | 该怎么做 |
|------|---------|
| 改了代码不确定对不对 | 先 `git stash`（临时藏起来），测试完再 `git stash pop`（拿出来） |
| 代码完全乱了 | `git stash` 保存当前改动，然后 `git checkout main` 回到主分支 |
| 数据库改坏了 | 写一个新的迁移文件来修复，**不要**手动改数据库 |
| 线上挂了 | 先 Vercel 回滚（第 5 节），再慢慢查原因 |
| 不确定某个操作安全不安全 | 问 Claude，说"这个操作可以回滚吗？" |

---

## 7. 黄金法则

1. **改之前先建分支** —— `git checkout -b safety/xxx`
2. **小步快跑** —— 每改一小块就 commit 一次，别攒着
3. **推之前先看** —— `git diff` 看看到底改了什么
4. **不确定就不做** —— 问清楚再动手
5. **线上出事先回滚** —— 先恢复服务，再查原因
