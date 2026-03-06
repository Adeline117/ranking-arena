#!/usr/bin/env python3
"""
Enrich win_rate and max_drawdown by fetching from exchange APIs.
Handles: hyperliquid, aevo, gmx, gains, jupiter_perps, dydx, and calculates
from equity curve data where possible.
"""
import json
import time
import sys
import requests
import psycopg2
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor, as_completed

import os
DB = os.environ.get("DATABASE_URL", "")

def log(msg):
    print(msg, flush=True)

def get_missing(conn, source, field='both'):
    """Get traders missing win_rate and/or max_drawdown for a source."""
    cur = conn.cursor()
    if field == 'win_rate':
        cond = "win_rate IS NULL"
    elif field == 'max_drawdown':
        cond = "max_drawdown IS NULL"
    else:
        cond = "(win_rate IS NULL OR max_drawdown IS NULL)"
    
    cur.execute(f"""
        SELECT DISTINCT source_trader_id, season_id, win_rate IS NULL as need_wr, max_drawdown IS NULL as need_mdd
        FROM trader_snapshots
        WHERE source = %s AND ({cond})
    """, (source,))
    rows = cur.fetchall()
    cur.close()
    return rows

def batch_update(conn, source, updates):
    """updates: list of (trader_id, season_id, win_rate_or_None, max_drawdown_or_None)"""
    if not updates:
        return 0
    cur = conn.cursor()
    count = 0
    for trader_id, season_id, wr, mdd in updates:
        sets = []
        vals = []
        if wr is not None:
            sets.append("win_rate = %s")
            vals.append(wr)
        if mdd is not None:
            sets.append("max_drawdown = %s")
            vals.append(mdd)
        if not sets:
            continue
        vals.extend([source, trader_id, season_id])
        cur.execute(f"""
            UPDATE trader_snapshots 
            SET {', '.join(sets)}
            WHERE source = %s AND source_trader_id = %s AND season_id = %s
            AND (win_rate IS NULL OR max_drawdown IS NULL)
        """, vals)
        count += cur.rowcount
    conn.commit()
    cur.close()
    return count

# ============ HYPERLIQUID ============
def enrich_hyperliquid(conn):
    """Hyperliquid info API: POST https://api.hyperliquid.xyz/info"""
    missing = get_missing(conn, 'hyperliquid')
    if not missing:
        log("hyperliquid: nothing to enrich")
        return
    
    # Group by trader
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"hyperliquid: {len(traders)} traders to check")
    updates = []
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            # Get clearinghouse state for account stats
            resp = requests.post('https://api.hyperliquid.xyz/info', json={
                "type": "clearinghouseState",
                "user": trader_id
            }, timeout=10)
            data = resp.json()
            
            # Try portfolio endpoint for more stats
            resp2 = requests.post('https://api.hyperliquid.xyz/info', json={
                "type": "userFills",
                "user": trader_id
            }, timeout=10)
            fills = resp2.json()
            
            # Calculate win_rate from fills
            wr = None
            if fills and len(fills) >= 3:
                # Group fills by position (simplified: count profitable vs unprofitable)
                wins = sum(1 for f in fills if float(f.get('closedPnl', 0)) > 0)
                total = sum(1 for f in fills if float(f.get('closedPnl', 0)) != 0)
                if total >= 3:
                    wr = wins / total * 100
            
            # Max drawdown from account value history
            mdd = None
            # Try portfolio API
            try:
                resp3 = requests.post('https://api.hyperliquid.xyz/info', json={
                    "type": "userNonFundingLedgerUpdates",
                    "user": trader_id
                }, timeout=10)
            except:
                pass
            
            for season, need_wr, need_mdd in seasons:
                updates.append((trader_id, season, 
                    wr if need_wr else None,
                    mdd if need_mdd else None))
            
            if (i + 1) % 50 == 0:
                log(f"  hyperliquid: {i+1}/{len(traders)}")
                time.sleep(0.5)
            else:
                time.sleep(0.2)
                
        except Exception as e:
            if i < 3:
                log(f"  hyperliquid error for {trader_id}: {e}")
    
    count = batch_update(conn, 'hyperliquid', updates)
    log(f"hyperliquid: updated {count} rows")


# ============ AEVO ============  
def enrich_aevo(conn):
    """Aevo API: GET https://api.aevo.xyz/statistics?account={address}"""
    missing = get_missing(conn, 'aevo')
    if not missing:
        log("aevo: nothing to enrich")
        return
    
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"aevo: {len(traders)} traders to check")
    updates = []
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            resp = requests.get(f'https://api.aevo.xyz/statistics?account={trader_id}', timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                wr = data.get('win_rate')
                mdd = data.get('max_drawdown')
                
                if wr is not None:
                    wr = float(wr) * 100 if float(wr) <= 1 else float(wr)
                if mdd is not None:
                    mdd = abs(float(mdd)) * 100 if abs(float(mdd)) <= 1 else abs(float(mdd))
                
                for season, need_wr, need_mdd in seasons:
                    updates.append((trader_id, season,
                        wr if need_wr else None,
                        mdd if need_mdd else None))
            
            if (i + 1) % 20 == 0:
                log(f"  aevo: {i+1}/{len(traders)}")
                time.sleep(1)
            else:
                time.sleep(0.3)
                
        except Exception as e:
            if i < 3:
                log(f"  aevo error for {trader_id}: {e}")
    
    count = batch_update(conn, 'aevo', updates)
    log(f"aevo: updated {count} rows")


# ============ GMX SUBGRAPH ============
def enrich_gmx(conn):
    """GMX: calculate max_drawdown from equity curve which has good coverage."""
    # GMX has 192 traders with 90D equity curves (avg 22.6 points)
    # Already handled by SQL-based approach, but let's try the subgraph for remaining
    missing = get_missing(conn, 'gmx', 'max_drawdown')
    if not missing:
        log("gmx: nothing to enrich")
        return
    
    traders = set(tid for tid, _, _, need_mdd in missing if need_mdd)
    log(f"gmx: {len(traders)} traders still missing max_drawdown")
    # GMX subgraph doesn't provide max_drawdown directly
    # We'd need to reconstruct from position data - skip for now
    log("gmx: subgraph doesn't provide max_drawdown directly, would need position reconstruction")


# ============ CEX COPY TRADE APIs ============
def enrich_mexc(conn):
    """MEXC copy trade API."""
    missing = get_missing(conn, 'mexc')
    if not missing:
        log("mexc: nothing to enrich")
        return
    
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"mexc: {len(traders)} traders to check")
    updates = []
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            resp = requests.get(
                f'https://futures.mexc.com/api/v1/private/copy/trader/detail?traderId={trader_id}',
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                d = data.get('data', {})
                wr = d.get('winRate')
                mdd = d.get('maxDrawdown') or d.get('maxRetrace')
                
                if wr is not None:
                    wr = float(wr) * 100 if float(wr) <= 1 else float(wr)
                if mdd is not None:
                    mdd = abs(float(mdd)) * 100 if abs(float(mdd)) <= 1 else abs(float(mdd))
                
                for season, need_wr, need_mdd in seasons:
                    updates.append((trader_id, season,
                        wr if need_wr else None,
                        mdd if need_mdd else None))
            
            if (i + 1) % 20 == 0:
                log(f"  mexc: {i+1}/{len(traders)}")
            time.sleep(0.3)
                
        except Exception as e:
            if i < 3:
                log(f"  mexc error for {trader_id}: {e}")
    
    count = batch_update(conn, 'mexc', updates)
    log(f"mexc: updated {count} rows")


def enrich_bitget(conn, source='bitget_futures'):
    """Bitget copy trade API."""
    missing = get_missing(conn, source)
    if not missing:
        log(f"{source}: nothing to enrich")
        return
    
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"{source}: {len(traders)} traders to check")
    updates = []
    product_type = 'umcbl' if source == 'bitget_futures' else 'spot'
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            resp = requests.get(
                f'https://www.bitget.com/v1/copy/mix/trader/detail',
                params={'traderId': trader_id, 'languageType': 0},
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                d = data.get('data', {})
                wr = d.get('winRate') or d.get('winRatio')
                mdd = d.get('maxDrawdown') or d.get('maxDrawRate')
                
                if wr is not None:
                    wr = float(wr) * 100 if float(wr) <= 1 else float(wr)
                if mdd is not None:
                    mdd = abs(float(mdd)) * 100 if abs(float(mdd)) <= 1 else abs(float(mdd))
                
                for season, need_wr, need_mdd in seasons:
                    updates.append((trader_id, season,
                        wr if need_wr else None,
                        mdd if need_mdd else None))
            
            if (i + 1) % 20 == 0:
                log(f"  {source}: {i+1}/{len(traders)}")
            time.sleep(0.3)
                
        except Exception as e:
            if i < 3:
                log(f"  {source} error for {trader_id}: {e}")
    
    count = batch_update(conn, source, updates)
    log(f"{source}: updated {count} rows")


def enrich_gateio(conn):
    """Gate.io copy trade API."""
    missing = get_missing(conn, 'gateio')
    if not missing:
        log("gateio: nothing to enrich")
        return
    
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"gateio: {len(traders)} traders to check")
    updates = []
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            resp = requests.get(
                f'https://www.gate.io/api/copytrade/copy_trading/trader/detail/{trader_id}',
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                d = data.get('data', {})
                wr = d.get('win_rate') or d.get('winRate')
                mdd = d.get('max_drawdown') or d.get('maxDrawdown')
                
                if wr is not None:
                    wr = float(wr) * 100 if float(wr) <= 1 else float(wr)
                if mdd is not None:
                    mdd = abs(float(mdd)) * 100 if abs(float(mdd)) <= 1 else abs(float(mdd))
                
                for season, need_wr, need_mdd in seasons:
                    updates.append((trader_id, season,
                        wr if need_wr else None,
                        mdd if need_mdd else None))
            
            if (i + 1) % 20 == 0:
                log(f"  gateio: {i+1}/{len(traders)}")
            time.sleep(0.3)
                
        except Exception as e:
            if i < 3:
                log(f"  gateio error for {trader_id}: {e}")
    
    count = batch_update(conn, 'gateio', updates)
    log(f"gateio: updated {count} rows")


def enrich_bingx(conn):
    """BingX copy trade API."""
    missing = get_missing(conn, 'bingx')
    if not missing:
        log("bingx: nothing to enrich")
        return
    
    traders = {}
    for tid, season, need_wr, need_mdd in missing:
        if tid not in traders:
            traders[tid] = []
        traders[tid].append((season, need_wr, need_mdd))
    
    log(f"bingx: {len(traders)} traders to check")
    updates = []
    
    for i, (trader_id, seasons) in enumerate(traders.items()):
        try:
            resp = requests.get(
                f'https://bingx.com/api/copy/v2/user/detail',
                params={'uid': trader_id},
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                d = data.get('data', {})
                wr = d.get('winRate')
                mdd = d.get('maxDrawdown')
                
                if wr is not None:
                    wr = float(wr) * 100 if float(wr) <= 1 else float(wr)
                if mdd is not None:
                    mdd = abs(float(mdd)) * 100 if abs(float(mdd)) <= 1 else abs(float(mdd))
                
                for season, need_wr, need_mdd in seasons:
                    updates.append((trader_id, season,
                        wr if need_wr else None,
                        mdd if need_mdd else None))
            
            if (i + 1) % 20 == 0:
                log(f"  bingx: {i+1}/{len(traders)}")
            time.sleep(0.3)
                
        except Exception as e:
            if i < 3:
                log(f"  bingx error for {trader_id}: {e}")
    
    count = batch_update(conn, 'bingx', updates)
    log(f"bingx: updated {count} rows")


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


def main():
    conn = psycopg2.connect(DB)
    print_status(conn, "BEFORE API enrichment")
    
    # Try each source
    enrich_hyperliquid(conn)
    enrich_aevo(conn)
    enrich_mexc(conn)
    enrich_bitget(conn, 'bitget_futures')
    enrich_bitget(conn, 'bitget_spot')
    enrich_gateio(conn)
    enrich_bingx(conn)
    
    print_status(conn, "AFTER API enrichment")
    conn.close()


if __name__ == '__main__':
    main()
