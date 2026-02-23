# 删除候选清单（2026-02-22）

> 先列清单再删除；以下均为**低风险删除候选**。

## 候选文件

1. `scripts/enrich-bitget-futures-avatar.mjs`
2. `scripts/enrich-bitget-spot-avatar.mjs`
3. `scripts/enrich-coinex-tc.mjs`
4. `scripts/enrich-gateio-tc.mjs`
5. `scripts/enrich-lbank-tc-mdd.mjs`
6. `scripts/enrich-okx-web3-tc.mjs`
7. `scripts/fill-null-snapshots-from-details.mjs`

## 删除理由

- 以上文件均为未纳入版本控制的临时脚本（`git status` 为 untracked）。
- `git grep` 在仓库（排除自身脚本目录）中未发现任何引用，未被 package scripts / 代码路径依赖。
- 多个文件内含硬编码 Supabase service-role key，属于高风险敏感信息，不应进入仓库历史。
- 保留会增加误用风险与维护噪音；删除不影响线上主流程代码路径。
