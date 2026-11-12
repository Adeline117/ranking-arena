# Bug 为什么反复出现：2026-06 至 2026-11 修复提交根因归类

> 日期：2026-11-11 · 范围：`git log --since=2026-06-01 --no-merges`
> 配套门禁：`scripts/qa/unchecked-supabase-error.mjs`（`npm run qa:unchecked-supabase-error`）

## 1. 方法

- 2026-06-01 以来共 3342 个非合并提交，其中标题以 `fix`/`hotfix` 开头或含"修"的有 **1807** 个。
- 对这 1807 个按时间顺序**每隔 11 个抽 1 个**，得到 **164 个**样本（覆盖 06-02 至 11-11 全区间）。
- 每个样本都读了 diff（排除测试文件后的 `git show`），按"实际改了什么"判根因，不看标题下结论。
  每个提交给一个主类；`A/B` 这类写法表示主类 A、次类 B。
- 纯文档或非修复提交（标题含"修"但其实是 docs）归入 K。

## 2. 归类结果（164 个样本）

| 排名 | 类别                                                                     | 主类数 | 占比  | 代表提交                                                                                                                                               |
| ---- | ------------------------------------------------------------------------ | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | D 数据语义/指标口径错误（cohort、clamp、provenance、单位、过期冒充新鲜） | 26     | 15.9% | `203528a08` 回撤把 ROI% 当净值算出 -800%；`450ac9858` MDD 显示成 `+22.60%`；`3919ced94` 跟随者跨源混计                                                 |
| 2    | F 前端状态/渲染逻辑（viewer 隔离、stale state、登录意图丢失、崩溃）      | 23     | 14.0% | `b9638cd04` 切换账号后看到上一个人的关联交易员；`7d1fc6d81` 切周期时显示上一周期指标；`01410cb27` setState 里读 currentTarget 整页崩溃                 |
| 3    | A 静默吞错/失败伪装成空或成功                                            | 19     | 11.6% | `a86854667` 群管理鉴权 `const { data }` 不查 error；`ee7fd90bd` 关注 feed 读失败退回热门 feed；`c389e9e93` admin_logs insert 结果被丢弃                |
| 4    | G UI 布局/样式/a11y/移动端                                               | 18     | 11.0% | `dee818f72` 手机端被代码块撑出屏幕；`d69b023cf` 暗色 badge 对比度；`8c7cb8ac8` 移动端末列不可达                                                        |
| 5    | C 原子性/竞态/并发                                                       | 15     | 9.1%  | `93c837e54` 收藏/投票多步写改原子 RPC；`cd17844c6` 频道 PATCH 先读角色再写（TOCTOU）；`0f2580eb5` 迟到 webhook 把新订阅降级                            |
| 6    | B schema/列/表/RPC 漂移                                                  | 13     | 7.9%  | `70b19b3ff` 读了不存在的 `subscriptions.expires_at` 等三列；`0e3efd602` collection_items 读不存在列，集合恒为空；`6e6937703` embed 关系不存在 PGRST200 |
| 7    | E 鉴权/权限/安全                                                         | 12     | 7.3%  | `a428b87dc` 备份写入公开桶；`fc3b7bc5c` code-login 账号枚举；`b864a1f1d` RLS 允许用户自插通知                                                          |
| 8    | I CI/构建/部署/钩子/多会话工作树                                         | 10     | 6.1%  | `99844fd5b` `git add -A` 误提交脚本让 CI 红、扣住 28 次部署；`18ddb5296` build 期 env 硬 throw；`c14b90321` pre-push 无界 `git diff` 拖死推送          |
| 9    | J 外部数据源/adapter 解析                                                | 10     | 6.1%  | `06e7e4799` lbank side 恒为 null 导致 0 持仓；`4cacd1536` bybit-mt5 漏提 MDD/Sharpe                                                                    |
| 10   | H i18n/文案/写死数量                                                     | 9      | 5.5%  | `b911a7197` 写死的 34,000+/68,000+ 过期；`29f634a34` snake_case key 渲染出原始 key                                                                     |
| 11   | K 其他/非修复                                                            | 9      | 5.5%  | `46fadb38a` RPC 性能；`ccedc8dbb` 纯文档                                                                                                               |

### 合并视角："失败不可见"才是最大的单一机制

A 和 B 在症状上是同一件事：**Supabase 查询失败不抛异常，只返回 `{ data: null, error }`；代码只拿 `data`，于是失败被当成"空结果"。**
B 类 13 个里，至少 `70b19b3ff`（tier 永远 free、封禁检查永远 false、静音永不过期）、
`0e3efd602`（集合永远为空）、`1370ce379`（RPC 缺失时悄悄退回直接写表）的根本症状都是"失败不可见"——
列漂移本身每次都不同，但让它们潜伏数周的通道是同一个。A+B 合计 **32 个（19.5%）**，按机制算是第一大类。
D 类里的 `20dc92be6`（bot_snapshots 停更 141 天无人发现）、I 类里的 `28697d53a`（fireAndForget 被函数结束杀掉）也是同一机制的变体。

## 3. 前三类为什么没被现有门禁拦住

### D 数据语义/口径（26）

- **没有可执行的口径定义**：clamp 上限、cohort 资格、provenance 绑定散落在 SQL 迁移、serving 代码和前端格式化三层，
  每次修复都是在其中一层补规则（`450ac9858` 在 metric registry 加 `displaySign`，`203528a08` 在图表里 clamp）。
- 现有门禁都是**结构性**的（schema 契约、类型绕过、架构边界、鉴权覆盖），没有一个检查"这个数字的含义对不对"。
- `fix-requires-test`（2026-10-30 才加）要求修复带测试，但测试只锁住被修的那一个点，同一口径在别的渲染点还会再错
  （记忆里记过：score tooltip 是 v4 切换的第 6 个漏网渲染点）。
- 结论：这类不适合用便宜的文件扫描拦，需要的是"单一口径来源 + 契约测试"，属于架构治理，不在本次范围。

### F 前端状态（23）

- tsc 和 ESLint 的 react-hooks 规则只查语法层依赖，不理解"这份状态属于哪个 viewer / 哪个周期"。
- 2026-07 引入了 `useViewerOwnedState` 一类的共享 hook，但没有规则强制使用，新组件仍然用裸 `useState` 存跨 viewer 数据。
- E2E 冒烟只跑核心路径的 desktop（`5a4d81c5f`），不覆盖切换账号/切换周期这类时序场景。
- 结论：可做但不便宜（需要识别"哪些状态是 viewer 所有"），误报风险高。

### A 静默吞错（19，与 B 合计 32）

- ESLint 只拦**字面空**的 `.catch(() => {})` 和空 `catch {}`，而且全局层是 `warn` 不是 `error`。
  `.catch(() => [])`、`.catch(() => null)` 和**根本不写 catch 的 `const { data } = await supabase...`** 完全不在规则范围。
- `qa:schema` / `qa:insert-drift` / `qa:read-drift` 需要生产凭据，在 CI 里是 `if: ${{ false }}`（V1 NO-GO 期间停用），
  而且它们只能发现"列名对不上"，发现不了"列名对了但 RLS/网络失败被吞"。
- `qa:cast-ratchet` 防的是用 `as any` 绕过生成类型，但即使类型完全正确，运行时失败仍然返回 `{ data: null }`，类型系统看不见。
- 每次修复都是逐文件补 `error` 检查（`a86854667` 修了 4 个路由、`c1efeffef` 修了一批次级路径），
  但从来没有规则阻止**下一个新文件**再写出同样的代码，所以它一直回来。

## 4. 新门禁：未检查 Supabase 错误棘轮

选 A 类（含 B 的静默症状）的理由：

1. **最便宜**：纯 TypeScript AST 扫描 `app/` 与 `lib/`，本机实测约 0.4 秒，无网络、无 env、无 secret。
2. **最有效**：拦的是机制而不是某一个列名，A+B 合计约 20% 的修复都经过这个通道；而且和生产凭据无关，V1 期间也能跑。
3. **可验证**：用修复提交的父版本回放，门禁能命中历史真实 bug：

   | 提交                                   | 修复前命中 | 修复后命中 |
   | -------------------------------------- | ---------- | ---------- |
   | `c389e9e93` admin_logs 写入结果被丢弃  | 7          | 0          |
   | `8716a548f` attestation GET 不查 error | 1          | 0          |
   | `a86854667` 群管理鉴权不查 error       | 13         | 9          |
   | `b79c1f778` 群通知失败仍计入成功       | 8          | 4          |
   | `ee7fd90bd` 关注 feed 读失败退回热门   | 3          | 2          |

   （修复后仍有命中，是因为当时只修了出事的那几处，同文件其余写法没动——这正是反复出现的原因。）

### 规则

对包含 `.from(...)` / `.rpc(...)` 调用的 `await` 表达式：

| 原因码             | 写法                                                               | 为什么算问题                           |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| `missing-error`    | `const { data } = await db.from('t').select(..)`（或只取 `count`） | 失败时 data 为 null，被当成"没找到/空" |
| `unused-error`     | `const { data, error } = await ...` 但 `error` 在函数内从未被引用  | 解构了却不看，等同吞错                 |
| `discarded-result` | `await db.from('t').insert(..)` 作为独立语句                       | 写失败完全不可见                       |

不计入：保留整个结果对象（`const res = await ...`）、`...rest` 解构、查询被包在别的函数参数里（`withRetry(...)`、`Promise.all`）、
`.auth.*`、`Array.from`/`Buffer.from`、测试和 `.d.ts` 文件。
已知局限：`Promise.all` 后通过 `result.data` 取值而不查 `result.error` 的写法（`70b19b3ff` 的形状）不在本门禁覆盖内。

### 棘轮

- 存量清单：`scripts/qa/unchecked-supabase-error-baseline.json`，**99 个文件、192 处**
  （`missing-error` 166、`discarded-result` 25、`unused-error` 1）。
- 新文件出现命中、或已有文件命中数增加 → 失败。
- 某文件修好后命中数低于基线 → 也失败，要求同一 PR 运行 `npm run qa:unchecked-supabase-error -- --update` 把基线降下来。
- `--update` 拒绝放大；CI 还会从事件文件读基准提交，比较提交的基线是否比基准提交宽（防手改 JSON）。
- 挂在 `.github/workflows/ci.yml` 的 lint-typecheck 任务；测试 `scripts/qa/unchecked-supabase-error.test.mjs` 随 `qa:sweep-unit` 运行。
- **不进 pre-push 钩子**（钩子必须快、有界、fail-open，重活交给 CI）。

### 怎么修存量

```ts
const { data, error } = await supabase.from('groups').select('name').eq('id', id).maybeSingle()
if (error) {
  logger.error('[groups] load failed', { id, code: error.code })
  return apiError('...', 500) // 或显示错误态 / 抛出，不要当成"没有这个群"
}
```

写操作改为检查返回的 `error`，或者使用已有的 `fireAndForget()` / `sendNotification()` 等会记录失败的封装。

## 5. 后续建议（未在本 PR 实施）

1. D 类：把 clamp/cohort/展示符号收敛到单一 metric registry，并对每个渲染点做契约测试。
2. F 类：给跨 viewer 状态加 ESLint 规则，要求 viewer 所有的数据走 `useViewerOwnedState`。
3. A 类扩展：把 `.catch(() => [] | null | {})` 纳入同一个棘轮；把全局层 `no-restricted-syntax` 从 `warn` 提到 `error`。
