-- Migration: 20260703234459_upstream_field_inventory.sql
-- Description: 上游字段清单(数据全面性 P1 — 新字段雷达的数据底座)
--
-- ingest 内存路径(tier-A/B 处理器,payload 还在内存时)按采样收集 raw
-- payload 的 field path 清单 upsert 到这里;每日哨兵把「过去 24h 新出现的
-- field_path」发 Telegram 摘要 —— 交易所悄悄新增字段(如开始提供 sortino)
-- 时我们主动发现,评估是否采集。RAW 本体是外部 gzip blob(30 天保留,
-- 不可 SQL),所以只能在 ingest 时收集,不能事后查。
-- 体量:~每源几百 path,全局 <2 万行,last_seen 原地更新不膨胀。

-- Up
create table if not exists arena.upstream_field_inventory (
  source_id  smallint not null references arena.sources(id),
  job_type   text not null,
  field_path text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (source_id, job_type, field_path)
);

comment on table arena.upstream_field_inventory is
  '上游 RAW payload 字段清单(采样);first_seen 近 24h = 上游新字段,哨兵播报';

alter table arena.upstream_field_inventory enable row level security;
