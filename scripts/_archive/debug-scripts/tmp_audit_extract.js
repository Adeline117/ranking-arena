const {Client}=require('pg');
(async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
 const out={};
 out.generated_at=new Date().toISOString();
 out.total={};
 for(const t of ['leaderboard_ranks','trader_snapshots','trader_sources']){const r=await c.query(`select count(*)::int as n from ${t}`); out.total[t]=r.rows[0].n}
 const compQ=`
 select lr.source, lr.season_id,
  count(*) as total,
  round(100.0*avg((lr.roi is null)::int),2) as miss_roi,
  round(100.0*avg((lr.win_rate is null)::int),2) as miss_wr,
  round(100.0*avg((lr.trades_count is null)::int),2) as miss_tc,
  round(100.0*avg((lr.max_drawdown is null)::int),2) as miss_mdd,
  round(100.0*avg((lr.sharpe_ratio is null)::int),2) as miss_sharpe,
  round(100.0*avg((lr.sortino_ratio is null)::int),2) as miss_sortino,
  round(100.0*avg((lr.profit_factor is null)::int),2) as miss_pf,
  100.0 as miss_aum,
  round(100.0*avg((ts.aum is null)::int),2) as miss_aum_snapshot,
  round(100.0*avg((ps.total_positions is null)::int),2) as miss_positions,
  round(100.0*avg((ec.source_trader_id is null)::int),2) as miss_equity
 from leaderboard_ranks lr
 left join trader_snapshots ts on ts.source=lr.source and ts.source_trader_id=lr.source_trader_id and ts.season_id=lr.season_id
 left join trader_position_summary ps on ps.platform=lr.source and ps.trader_key=lr.source_trader_id
 left join (select distinct source,source_trader_id,period from trader_equity_curve) ec
   on ec.source=lr.source and ec.source_trader_id=lr.source_trader_id and ec.period=lr.season_id
 where lr.season_id in ('default','7D','30D')
 group by lr.source,lr.season_id
 order by lr.season_id, total desc`;
 out.completeness=(await c.query(compQ)).rows;
 out.completeness_season=(await c.query(`select season_id,count(*) total,
 round(100.0*avg((roi is null)::int),2) miss_roi,
 round(100.0*avg((win_rate is null)::int),2) miss_wr,
 round(100.0*avg((trades_count is null)::int),2) miss_tc,
 round(100.0*avg((max_drawdown is null)::int),2) miss_mdd,
 round(100.0*avg((sharpe_ratio is null)::int),2) miss_sharpe,
 round(100.0*avg((sortino_ratio is null)::int),2) miss_sortino,
 round(100.0*avg((profit_factor is null)::int),2) miss_pf
 from leaderboard_ranks where season_id in ('default','7D','30D') group by season_id order by season_id`)).rows;
 const consQ=`with j as (
 select lr.source,lr.season_id,lr.source_trader_id,
   lr.roi lr_roi, ts.roi ts_roi,
   lr.win_rate lr_wr, ts.win_rate ts_wr,
   lr.trades_count lr_tc, ts.trades_count ts_tc,
   lr.max_drawdown lr_mdd, ts.max_drawdown ts_mdd,
   lr.handle lr_handle, src.handle src_handle,
   lr.avatar_url lr_avatar, src.avatar_url src_avatar
 from leaderboard_ranks lr
 join trader_snapshots ts on ts.source=lr.source and ts.source_trader_id=lr.source_trader_id and ts.season_id=lr.season_id
 left join trader_sources src on src.source=lr.source and src.source_trader_id=lr.source_trader_id
 where lr.season_id in ('7D','30D','90D'))
 select season_id,count(*) total,
 round(100.0*avg((abs(coalesce(lr_roi,0)-coalesce(ts_roi,0))>0.01)::int),2) roi_mismatch,
 round(100.0*avg((abs(coalesce(lr_wr,0)-coalesce(ts_wr,0))>0.01)::int),2) wr_mismatch,
 round(100.0*avg((coalesce(lr_tc,-1)<>coalesce(ts_tc,-1))::int),2) tc_mismatch,
 round(100.0*avg((abs(coalesce(lr_mdd,0)-coalesce(ts_mdd,0))>0.01)::int),2) mdd_mismatch,
 round(100.0*avg((coalesce(lr_handle,'')<>coalesce(src_handle,''))::int),2) handle_mismatch,
 round(100.0*avg((coalesce(lr_avatar,'')<>coalesce(src_avatar,''))::int),2) avatar_mismatch
 from j group by season_id order by season_id`;
 out.consistency=(await c.query(consQ)).rows;
 out.timeliness=(await c.query(`select season_id, source, count(*) total,
 round(extract(epoch from (now()-max(computed_at)))/3600,2) as latest_lag_h,
 round(percentile_cont(0.5) within group(order by extract(epoch from (now()-computed_at))/3600)::numeric,2) as p50_lag_h,
 round(percentile_cont(0.95) within group(order by extract(epoch from (now()-computed_at))/3600)::numeric,2) as p95_lag_h
 from leaderboard_ranks group by season_id,source order by latest_lag_h desc limit 120`)).rows;
 out.stale_platforms=(await c.query(`select season_id, source, round(extract(epoch from (now()-max(computed_at)))/3600,2) lag_h, count(*) rows
 from leaderboard_ranks group by season_id,source
 having max(computed_at) < now() - interval '24 hours'
 order by lag_h desc`)).rows;
 out.capture_lag=(await c.query(`select season_id, source,
 round(extract(epoch from (now()-max(captured_at)))/3600,2) latest_lag_h,
 count(*) rows from trader_snapshots group by season_id,source order by latest_lag_h desc limit 120`)).rows;
 out.anomalies={};
 out.anomalies.extreme_roi=(await c.query(`select season_id,source,count(*) cnt from leaderboard_ranks where abs(roi)>5000 group by season_id,source order by cnt desc`)).rows;
 out.anomalies.out_of_bounds=(await c.query(`select
 sum((win_rate<0 or win_rate>100)::int) as wr_oob,
 sum((max_drawdown<0 or max_drawdown>100)::int) as mdd_oob,
 sum((trades_count<0)::int) as tc_neg,
 sum((followers<0)::int) as fol_neg,
 sum((rank<=0)::int) as rank_bad
 from leaderboard_ranks`)).rows[0];
 out.anomalies.dup=(await c.query(`select season_id,source,count(*) dup_groups,sum(c-1) extra_rows from (select season_id,source,source_trader_id,count(*) c from leaderboard_ranks group by 1,2,3 having count(*)>1) t group by season_id,source order by extra_rows desc nulls last`)).rows;
 out.anomalies.empty_profile=(await c.query(`select season_id,source,count(*) total,
 round(100.0*avg((handle is null or btrim(handle)='')::int),2) empty_handle_pct,
 round(100.0*avg((avatar_url is null or btrim(avatar_url)='' or avatar_url !~* '^https?://')::int),2) bad_avatar_pct
 from leaderboard_ranks group by season_id,source order by empty_handle_pct desc limit 120`)).rows;
 out.traceability=(await c.query(`select count(*) total,
 sum((source_trader_id is null or btrim(source_trader_id)='')::int) missing_source_trader_id,
 sum((computed_at is null)::int) missing_computed_at from leaderboard_ranks`)).rows[0];
 out.traceability.telemetry_recent=(await c.query(`select source, max(created_at) last_job_at, count(*) jobs_7d
 from scrape_telemetry where created_at>now()-interval '7 day' group by source order by last_job_at desc`)).rows;
 out.frontend={};
 out.frontend.rank_vs_score=(await c.query(`select season_id,
 sum((rank is null)::int) missing_rank,
 sum((arena_score is null)::int) missing_score,
 corr(rank::float, arena_score::float) as corr_rank_score
 from leaderboard_ranks where season_id in ('7D','30D','90D') group by season_id`)).rows;
 out.frontend.empty_cards=(await c.query(`select season_id,
 round(100.0*avg(((handle is null or btrim(handle)='') and (source_trader_id is null or btrim(source_trader_id)=''))::int),4) as fully_empty_identity_pct,
 round(100.0*avg((coalesce(roi,0)=0 and coalesce(pnl,0)=0 and arena_score is null)::int),2) as empty_metric_pct
 from leaderboard_ranks group by season_id`)).rows;
 console.log(JSON.stringify(out,null,2));
 await c.end();
})();