-- P0 数据基准对账(ARENA_REBUILD_SPEC Phase 1):arena.sources.expected_count 校准。
--
-- expected_count 是 day-one sanity floor(冷启动用);稳态 count-check 用近 7 次
-- 通过快照的 actual_count median。本迁移按"近 15 次实际 median"修正三类问题:
--   1) 三个 web3/bot 源 expected_count 为 NULL(无 day-one floor)→ 填保守 floor;
--   2) btcc_futures 1824 偏高于实际(median 1529)→ 防冷启动误判,降到 1300;
--   3) xt_spot 84 偏高于实际(median 38,翻页后归零特性)→ 降到 25。
--
-- 对账中确认(无需改、记录在案):bitmart 7/30 native + 90 derived 正确
-- (交易所无 3M 榜,90d 由 sheet stats 派生);bitget_bots timeframes_native=[30]
-- 正确(板块单次触发,7/30/90+inception 在 profile 层);其余源 expected_count
-- 均在实际 ±10% 内,不动。kucoin/okx/toobit 的时间段覆盖需实抓验证,留 P2。
-- 幂等:WHERE 守卫现值,重复执行无副作用。

UPDATE arena.sources SET expected_count = 400  WHERE slug = 'binance_web3_bsc'    AND expected_count IS NULL;
UPDATE arena.sources SET expected_count = 4000 WHERE slug = 'okx_web3_solana'     AND expected_count IS NULL;
UPDATE arena.sources SET expected_count = 180  WHERE slug = 'bitget_bots_futures' AND expected_count IS NULL;
UPDATE arena.sources SET expected_count = 130  WHERE slug = 'bitget_bots_spot'    AND expected_count IS NULL;
UPDATE arena.sources SET expected_count = 1300 WHERE slug = 'btcc_futures'        AND expected_count = 1824;
UPDATE arena.sources SET expected_count = 25   WHERE slug = 'xt_spot'             AND expected_count = 84;
