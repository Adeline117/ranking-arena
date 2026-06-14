# 交易员详情 — 每来源数据可用性总表

> 设计依据(2026-06-13)。统一交易员详情页前,先汇总**每个来源实际能提供哪些信息**——
> 结合 `EXCHANGE_FIELD_MAPPING.md`(交易所"应该有")与生产实测(`arena_source_capabilities`
>
> - `arena.trader_stats` + `trading_preferences`/`extras`,即我们"真正抓到")。
>   统一页用 NULL-collapse:有则展示、无则收起,绝不造数据。

## 0. 全来源通用(所有 serving 源都有)

| 数据                                                                                                                                            | 来源                                   | 当前面板               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------- |
| 身份(昵称/头像/source/traderId/kind)                                                                                                            | first-screen                           | ✅ Header              |
| ROI / PnL 时序曲线(按日)                                                                                                                        | core.series.roi / .pnl                 | ✅ CoreCharts          |
| **资产偏好(交易币种 + 占比)**                                                                                                                   | core.extras.trading_preferences.assets | ✅ AssetPreference(新) |
| **元数据**(带单起始 lead_start_time、最近交易 last_trade_time、保证金 margin_balance、最大跟单 copier_count_max、合约类型 futures_type、收藏数) | core.extras                            | ❌ **未展示**          |
| 派生:回撤曲线(从 ROI 序列算)                                                                                                                    | 可算                                   | ❌ 未展示              |

## 1. 核心指标矩阵(arena_source_capabilities.metrics 实测)

`✓`=实测有 · 空=该源无此字段

| 来源                                       | roi | pnl |   win   |  mdd   | sharpe  | total/win 仓 | aum | copier_pnl/count | profit_share | holding_avg |  volume   |
| ------------------------------------------ | :-: | :-: | :-----: | :----: | :-----: | :----------: | :-: | :--------------: | :----------: | :---------: | :-------: |
| **bybit_copytrade**                        |  ✓  |  ✓  |    ✓    |   ✓    |    ✓    |      ✓       |  ✓  |        ✓         |      ✓       |      ✓      |           |
| **bitget\_\*** (futures/spot/cfd)          |  ✓  |  ✓  |    ✓    |   ✓    |         |      ✓       |  ✓  |        ✓         |      ✓       |      ✓      |           |
| **htx\_\*** / **mexc_futures**             |  ✓  |  ✓  |    ✓    |   ✓    |         |      ✓       |  ✓  |        ✓         |      ✓       |      ✓      |           |
| **gate_futures**                           |  ✓  |  ✓  |    ✓    |   ✓    |    ✓    |      ✓       |  ✓  |        ✓         |      ✓       |             |     ✓     |
| gate_cfd / coinex / phemex / bitunix       |  ✓  |  ✓  |    ✓    |   ✓    | (gate✓) |      ✓       |  ✓  |        ✓         |      ✓       |             | (phemex✓) |
| btcc_futures / bitmart_futures             |  ✓  |  ✓  |    ✓    |   ✓    |         |   (btcc✓)    |  ✓  |        ✓         |      ✓       |      ✓      |           |
| **binance_futures/spot**                   |  ✓  |  ✓  |    ✓    |   ✓    |    ✓    |    (fut✓)    |  ✓  |        ✓         |      ✓       |             |           |
| okx_futures/spot                           |  ✓  |  ✓  |    ✓    |        |         |              |     |   copier_pnl✓    |              |             |           |
| lbank / toobit / xt_futures / kucoin       |  ✓  |  ✓  | (多数✓) | (部分) |         | (lbank部分)  |  ✓  |     (多数✓)      |    (部分)    |             |           |
| **gmx**                                    |  ✓  |  ✓  |    ✓    |        |         |      ✓       |  ✓  |                  |              |             |     ✓     |
| **hyperliquid**                            |  ✓  |  ✓  |         |        |         |              |  ✓  |                  |              |             |     ✓     |
| gtrade                                     |     |  ✓  |    ✓    |        |         |      ✓       |     |                  |              |             |           |
| bybit_mt5 / binance_web3 / xt_spot / bingx |  ✓  |  ✓  |    ✓    |        |         |              |     |                  |              |             |           |
| bitget*bots*\*                             |  ✓  |  ✓  |         |        |         |              |  ✓  |        ✓         |              |             |           |
| **bitfinex**                               |     |  ✓  |         |        |         |              |     |                  |              |             |           |

## 2. 记录面(surfaces)矩阵 + 跟单深度

`✓`=有数据表 · copier_depth: full=完整名单 / top10 / top3_preview / none

| 来源                                                                           | 当前持仓 | 历史持仓 | 订单 | 划转 | 跟单名单深度 |
| ------------------------------------------------------------------------------ | :------: | :------: | :--: | :--: | :----------: |
| **binance_futures / gate_futures / bitmart_futures**                           |    ✓     |    ✓     |  ✓   |  ✓   | full / top10 |
| bitget*\* / htx*\* / mexc / btcc / coinex / phemex / bitunix / bybit_copytrade |    ✓     |    ✓     |      |      |     full     |
| gate_cfd / okx_futures / lbank / toobit                                        |          |    ✓     |      |      | top10 / top3 |
| binance_spot                                                                   |    ✓     |          |  ✓   |      |     full     |
| gmx / hyperliquid / bybit_mt5                                                  |    ✓     |          |      |      |     none     |
| gtrade                                                                         |          |          |  ✓   |      |     none     |
| 仅 copiers:bingx/blofin/okx_spot/xt/kucoin/bitget_bots                         |          |          |      |      |  full/top10  |
| **bitfinex / okx_web3 / binance_web3**                                         |          |          |      |      | none(纯榜单) |

## 3. 富度分层(驱动统一页设计)

- **T1 富(~12 源)**:bybit_copytrade、bitget×3、htx×2、mexc、gate×2、coinex、phemex、bitunix、btcc、bitmart、binance×2 —— 完整指标 + 持仓/历史/跟单。**统一页满配**:指标网格 + 净值/回撤图 + 资产偏好 + 持仓/历史表 + 跟单聚合 + 元数据条。
- **T2 中(~8 源)**:okx×2、lbank、toobit、xt、kucoin、gmx、hyperliquid —— roi/pnl(+部分 win/mdd/positions)、历史或持仓其一。**统一页**:指标(收起缺项)+ ROI 图 + 有的那张记录表。
- **T3 稀(~6 源)**:bitfinex(仅 pnl)、web3×2、bybit_mt5、bitget_bots —— 仅榜单级。**统一页**:Header + 基础指标 + ROI 图 +(bots 有 copiers)。

## 4. 设计结论

1. **一套页面,NULL-collapse**:同一套富前端(Overview/Stats/Portfolio 风格),按上表每源有什么显什么。T1 满,T3 自然收成精简,无需两套布局。
2. **立刻能补的零数据成本项**(数据已在库、仅缺 UI):资产偏好(已补)、**回撤图**、**元数据条**(带单天数/保证金/最大跟单/最近交易)、holding_avg/win 仓位 等已在 MetricGrid 注册表但要确认 capability 放行。
3. **真实数据缺口**(非 UI 能补):sharpe 仅 6 源、avg_holding 仅 ~9 源、orders/transfers 仅 binance/gate 系、bitfinex/web3 无任何记录面 —— 这些 NULL-collapse,不强求。

参考:[EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md)(交易所原始字段 + 标准化规则)。
