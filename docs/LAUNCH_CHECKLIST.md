# 上线清单

更新于 2026-10-30。基于当前 main 的仓库内容核对，**没有查询生产**，所以无法确认生产实际状态。

完整步骤见 `V1_PRODUCT_STATUS_AND_PLAN_2026-08-03.md` 阶段 2。本文记录它和现状的差异，以及执行前要解决的问题。下列操作都需要 owner 另行批准，agent 不执行。

## 必须先解决：迁移清单已过期

`npm run qa:launch-migration-inventory` 的分类停在 2026-08-04。之后新增的 **17 个迁移都不在清单里**，名单见 `scripts/qa/launch-inventory-gap.json`。

其中 `20260816151614_public_ranked_leaderboard.sql` 影响最大：main 的榜单、详情和搜索都读 `public_ranked_leaderboard`。**已证实生产没有这个视图**（2026-11-11 UTC 只读取证：`to_regclass('public.public_ranked_leaderboard')` 为空，`supabase_migrations.schema_migrations` 中也没有对应记录），部署当前 main 后这些页面会拿不到排名数据。生产缺口与排练结果见 `LAUNCH_REHEARSAL_2026-11-11.md`。

**要做的事：**

1. 逐个判断这 17 个迁移属于 predeploy、postdeploy，还是已被取代，并确定顺序。
2. 把它们写入清单，同时从 `launch-inventory-gap.json` 删除。
3. 查询生产 ledger 和 catalog，重算实际缺项。**2026-11-11 已完成**：17 个里 16 个未应用，全部 112 个缺口见 `LAUNCH_REHEARSAL_2026-11-11.md`。

8 月文档里的 "122 项 predeploy" 只是下界，不能直接使用。

## 与 8 月文档的其他差异

| 项目                 | 8 月文档         | 现状                                |
| -------------------- | ---------------- | ----------------------------------- |
| 文档引用的 15 个迁移 | 存在             | 仍全部存在                          |
| 工作流数量           | 17 个            | 15 个                               |
| 迁移文件             | 未统计           | 611 个，其中 191 个不是纯时间戳命名 |
| Supabase Preview     | 要求从空环境通过 | 仍失败，从零重放迁移会报错          |

## 执行顺序

1. **数据安全**：完成备份并恢复验证；处理 R2 公开桶。
2. **托管恢复**：确认 Supabase 恢复；轮换数据库密码和其他 provider 凭据。
3. **恢复环境**：准备约 100GB 的隔离 PG17，认证旧备份和新备份。
4. **补齐清单**：完成上一节的工作。
5. **排练**：先在 staging 按顺序应用迁移并部署同一个提交。
6. **生产**：按 ADR-023 单文件应用迁移，部署 staging 验证过的同一提交。
7. **观察**：网页金丝雀、支付金丝雀，写入截止后至少等待 48 小时再开放榜单。
8. **恢复 worker**：单 worker 金丝雀，观察完整调度周期后再扩容。
9. **解除 NO-GO**：核心接口和数据新鲜度连续 24 小时正常，由 owner 决定。
10. **Beta**：分批邀请真实用户。

## 上线前要确认的产品问题

- `lib/config/product-facts.ts` 写死了回退值 9,600 名交易员和 28 个榜单。接口取不到数据时，登录页和关于页会照常显示这些数字。V1 文档要求公开数字来自带时间戳的事实源，是否保留由 owner 决定。
- `Pro` 限时免费开关（`PRO_FREE_PROMO`）和 Stripe 正式环境何时切换。
- `hold` 档页面 `portfolio`、`tip`、`wrapped` 的去留。
