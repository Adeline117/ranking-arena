# Owner 认领亲测手册（goal 最后一步，约 10 分钟）

> 目的：产出第一个**真实** verified 徽章，并用你的交易所 App 对账验证
> 第一方数据链路——这是「数据可信度从底层到用户可见」唯一无法合成的验证。
> （E2E 干跑 14/14 已过，这里走的是真账号真数据。）

## 前置

- 你的交易所账号（binance / bybit / okx / bitget / gate 任一，建议选你有
  真实交易记录的）创建一把**只读** API key（禁提现、禁交易；okx/bitget 需
  passphrase）。
- 该账号如在交易所排行榜/带单榜上有 UID，最好——可走 UID 匹配；没有也能走。

## 步骤

1. **提交认领**：登录 arenafi.org → 打开你在榜上的交易员页（或搜索你的
   UID）→ 点 "Is this your account? Claim to customize your profile." →
   按向导填 UID + 只读 API key → 提交。状态会显示「审核中」。
2. **审核**：/admin → Trader Claims tab → 找到你的申请 → Approve。
   （这一步也可以直接叫我批。）
3. **等首次同步**：批准即打 claimed 标 + 建 15 分钟一档的 first-party
   sync 调度（本机 worker 跑，需 worker/.env 有 ENCRYPTION_KEY——已配）。
   最迟 15 分钟内首跑。
4. **对账验证**（核心）：打开你的交易员页——
   - verified 徽章出现（排行榜行 + 详情页）
   - 7D/30D/90D PnL、ROI 与你交易所 App 里的数字对得上（第一方分支
     provenance='first_party'，<48h 新鲜时全权威）
   - 数字对不上 → 直接把两边截图发我，我查 engine 口径。
5. **（可选）多账号**：再绑第二个交易所账号，确认排行榜显示所有账号、
   主页可切换「全部/分账号」视图。

## 出问题时

- 同步连挂 3 次会站内通知你换 key（status='error'，榜上数据自动回退到
  抓取值，不会消失）。
- 撤销：Settings → 删除授权（或叫我 SQL 置 revoked）。

## 完成标志

第一个非测试 verified 徽章上榜截图 + PnL 与交易所 App 一致 → goal #22
关闭，可信度六维全绿。
