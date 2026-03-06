#!/usr/bin/env python3
"""
Enrich win_rate and max_drawdown from existing DB data.
"""
import sys
import psycopg2
from decimal import Decimal

def log(msg, **kw):
    print(msg, flush=True)

import os
DB = os.environ.get("DATABASE_URL", "")


def print_status(conn, label=""):
    cur = conn.cursor()
    cur.execute("""
        SELECT season_id,
            COUNT(*) total,
            COUNT(*) FILTER (WHERE win_rate IS NULL) wr_null,
            COUNT(*) FILTER (WHERE max_drawdown IS NULL) mdd_null
        FROM trader_snapshots 
        GROUP BY season_id ORDER BY season_id
    """)
    log(f"\n{'='*50}")
    log(f"Status {label}:")
    log(f"{'season':<8} {'total':>6} {'wr_null':>8} {'mdd_null':>9}")
    for row in cur.fetchall():
        log(f"{row[0]:<8} {row[1]:>6} {row[2]:>8} {row[3]:>9}")
    cur.close()


def enrich_max_drawdown_sql(conn):
    """Calculate and update max_drawdown using pure SQL with window functions."""
    cur = conn.cursor()
    
    # Use SQL to calculate max drawdown from equity curves
    # For each trader+period combo, calculate running peak and drawdown
    log("\nCalculating max_drawdown from equity curves (SQL)...")
    
    cur.execute("""
        WITH equity_with_peak AS (
            SELECT source, source_trader_id, period, data_date, roi_pct,
                (1 + roi_pct / 100) as val,
                MAX(1 + roi_pct / 100) OVER (
                    PARTITION BY source, source_trader_id, period 
                    ORDER BY data_date 
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) as peak
            FROM trader_equity_curve
            WHERE roi_pct IS NOT NULL
        ),
        max_dd AS (
            SELECT source, source_trader_id, period,
                MAX(CASE WHEN peak > 0 THEN (peak - val) / peak * 100 ELSE 0 END) as mdd,
                COUNT(*) as points
            FROM equity_with_peak
            GROUP BY source, source_trader_id, period
            HAVING COUNT(*) >= 2
            AND MAX(CASE WHEN peak > 0 THEN (peak - val) / peak * 100 ELSE 0 END) > 0
        )
        UPDATE trader_snapshots s
        SET max_drawdown = d.mdd
        FROM max_dd d
        WHERE s.source = d.source
        AND s.source_trader_id = d.source_trader_id
        AND s.season_id = d.period
        AND s.max_drawdown IS NULL
    """)
    
    updated = cur.rowcount
    conn.commit()
    log(f"Updated {updated} max_drawdown values from equity curves")
    cur.close()


def enrich_win_rate_sql(conn):
    """Calculate and update win_rate from position history using SQL."""
    cur = conn.cursor()
    
    log("\nCalculating win_rate from position history (SQL)...")
    
    cur.execute("""
        WITH trade_stats AS (
            SELECT source, source_trader_id,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE pnl_usd > 0) as wins
            FROM trader_position_history
            WHERE status = 'closed'
            GROUP BY source, source_trader_id
            HAVING COUNT(*) >= 3
        )
        UPDATE trader_snapshots s
        SET win_rate = (t.wins::numeric / t.total * 100)
        FROM trade_stats t
        WHERE s.source = t.source
        AND s.source_trader_id = t.source_trader_id
        AND s.win_rate IS NULL
    """)
    
    updated = cur.rowcount
    conn.commit()
    log(f"Updated {updated} win_rate values from position history")
    cur.close()


def main():
    conn = psycopg2.connect(DB)
    
    print_status(conn, "BEFORE")
    
    enrich_max_drawdown_sql(conn)
    enrich_win_rate_sql(conn)
    
    print_status(conn, "AFTER DB-based enrichment")
    
    # Print per-source breakdown
    cur = conn.cursor()
    cur.execute("""
        SELECT season_id, source,
            COUNT(*) total,
            COUNT(*) FILTER (WHERE win_rate IS NULL) wr_null,
            COUNT(*) FILTER (WHERE max_drawdown IS NULL) mdd_null
        FROM trader_snapshots
        GROUP BY season_id, source
        HAVING COUNT(*) FILTER (WHERE win_rate IS NULL) > 0 
           OR COUNT(*) FILTER (WHERE max_drawdown IS NULL) > 0
        ORDER BY season_id, mdd_null DESC
    """)
    log(f"\n{'='*50}")
    log("Remaining gaps per source:")
    log(f"{'season':<6} {'source':<18} {'total':>6} {'wr_null':>8} {'mdd_null':>9}")
    for row in cur.fetchall():
        log(f"{row[0]:<6} {row[1]:<18} {row[2]:>6} {row[3]:>8} {row[4]:>9}")
    cur.close()
    
    conn.close()


if __name__ == '__main__':
    main()
