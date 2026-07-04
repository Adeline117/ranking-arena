-- Migration: 20260703192324_metric_fill_trend.sql
-- Created: 2026-07-04T02:23:24Z
-- Description: 数据全面度第 3 层 — 指标填充率每日快照表(趋势哨兵数据底座)
--
-- fill-rate-check.mjs(每日 06:30 UTC GH Actions)把每个 active serving 源
-- ×声明指标的 filled/total 写进来;series-backfill 是数天/周级渐进回填,
-- 快照趋势「连续 7 天不涨且未接近满」= 回填带又被饿死/楔死的早期信号
-- (2026-07-03 revive-kick 楔死事故的自动化预警形态)。
-- 体量:~300 行/天(34 源 × ~9 指标),90 天 ≈ 2.7 万行,忽略不计。

-- Up
create table if not exists arena.metric_fill_trend (
  taken_on date not null default current_date,
  slug     text not null,
  metric   text not null,
  filled   bigint not null,
  total    bigint not null,
  primary key (taken_on, slug, metric)
);

comment on table arena.metric_fill_trend is
  '每日指标填充率快照(fill-rate-check 写入);趋势平坦=回填停滞告警的依据';

-- service role / 直连之外无人需要读写;与 arena.* 一致开 RLS 且不加策略。
alter table arena.metric_fill_trend enable row level security;
