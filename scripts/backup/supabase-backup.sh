#!/bin/bash
set -euo pipefail

###############################################################################
# Arena Supabase 数据库备份脚本 (简化版)
#
# 用途：快速手动备份Supabase数据库到本地
# 使用：./supabase-backup.sh [--output-dir DIR] [--tables-only]
#
# 注意：生产环境请使用 scripts/maintenance/backup-to-r2.mjs
#       这个脚本仅用于应急备份或本地测试
#
# 前置要求：
#   1. PostgreSQL 17 客户端：brew install postgresql@17
#   2. .env文件包含DATABASE_URL
#   3. 足够的磁盘空间（估计1-2GB）
#
# ─── Backup & Recovery SLA ──────────────────────────────────────────────────
#
# RTO (Recovery Time Objective): 4 hours
#   Restore from latest backup + re-run cron jobs to backfill any gap.
#
# RPO (Recovery Point Objective): 24 hours max (manual backup schedule)
#   - Manual backups: run this script or `npm run backup:r2` daily
#   - Supabase Pro: point-in-time recovery (PITR) available for finer RPO
#   - Automated backups: scripts/maintenance/backup-to-r2.mjs uploads to
#     Cloudflare R2 on a schedule
#
# Recovery Procedure:
#   1. Obtain the latest backup file (local or from R2):
#        - Local:  ls -lt backups/arena-full-backup-*.sql.gz | head -1
#        - R2:     npm run backup:r2 -- --list   (then download latest)
#
#   2. Restore with pg_restore / psql:
#        createdb arena_restore
#        gunzip -c backups/arena-full-backup-YYYYMMDD-HHMMSS.sql.gz \
#          | psql arena_restore
#      For Supabase hosted DB, use the connection string from the dashboard:
#        gunzip -c backup.sql.gz | psql "$DATABASE_URL"
#
#   3. Verify data integrity:
#        psql "$DATABASE_URL" -c "
#          SELECT 'trader_sources' AS tbl, count(*) FROM trader_sources
#          UNION ALL
#          SELECT 'trader_snapshots', count(*) FROM trader_snapshots
#          UNION ALL
#          SELECT 'leaderboard_ranks', count(*) FROM leaderboard_ranks;
#        "
#      Compare row counts against expected values (34k+ traders, etc.).
#
#   4. Re-run leaderboard computation to rebuild derived data:
#        curl -X POST https://www.arenafi.org/api/cron/compute-leaderboard \
#          -H "Authorization: Bearer $CRON_SECRET"
#
#   5. Trigger enrichment crons to fill any gap between backup and now:
#        curl -X POST https://www.arenafi.org/api/cron/batch-enrich \
#          -H "Authorization: Bearer $CRON_SECRET"
#
#   6. Verify the live site returns fresh data (check /api/health/pipeline).
#
# ────────────────────────────────────────────────────────────────────────────
###############################################################################

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 配置
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_OUTPUT_DIR="$PROJECT_ROOT/backups"
OUTPUT_DIR="$DEFAULT_OUTPUT_DIR"
TABLES_ONLY=false
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# 加载环境变量
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
else
    echo -e "${RED}Error: .env file not found${NC}"
    exit 1
fi

if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}Error: DATABASE_URL not set in .env${NC}"
    exit 1
fi

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --tables-only)
            TABLES_ONLY=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 检查pg_dump
PG_DUMP="/opt/homebrew/opt/postgresql@17/bin/pg_dump"
if [ ! -f "$PG_DUMP" ]; then
    echo -e "${YELLOW}Warning: PostgreSQL 17 not found, trying system pg_dump${NC}"
    PG_DUMP="pg_dump"
fi

if ! command -v "$PG_DUMP" &> /dev/null; then
    echo -e "${RED}Error: pg_dump not found. Install: brew install postgresql@17${NC}"
    exit 1
fi

###############################################################################
# 备份函数
###############################################################################

backup_full() {
    local output_file="$OUTPUT_DIR/arena-full-backup-$TIMESTAMP.sql.gz"
    
    echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} Starting full database backup..."
    echo "  Output: $output_file"
    
    "$PG_DUMP" "$DATABASE_URL" \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        | gzip > "$output_file"
    
    local size=$(du -h "$output_file" | cut -f1)
    echo -e "${GREEN}✅ Full backup complete: $size${NC}"
}

backup_trader_tables() {
    local output_file="$OUTPUT_DIR/arena-trader-tables-$TIMESTAMP.sql.gz"
    
    # 核心trader表（与backup-to-r2.mjs保持一致）
    local tables=(
        "trader_equity_curve"
        "trader_snapshots"
        "trader_snapshots_v2"
        "trader_daily_snapshots"
        "trader_timeseries"
        "trader_roi_history"
        "trader_position_history"
        "trader_positions_history"
        "trader_positions_live"
        "trader_position_summary"
        "trader_asset_breakdown"
        "trader_frequently_traded"
        "trader_sources"
        "trader_sources_v2"
        "traders"
        "trader_profiles_v2"
        "trader_stats_detail"
        "trader_scores"
        "trader_links"
        "trader_portfolio"
        "trader_flags"
        "trader_anomalies"
        "trader_seasons"
        "trader_merges"
        "trader_follows"
        "trader_authorizations"
        "trader_alerts"
        "leaderboard_ranks"
        "leaderboard_snapshots"
        "daily_trader_stats"
    )
    
    echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} Starting trader tables backup (${#tables[@]} tables)..."
    echo "  Output: $output_file"
    
    # 构建--table参数
    local table_args=""
    for table in "${tables[@]}"; do
        table_args="$table_args --table=$table"
    done
    
    "$PG_DUMP" "$DATABASE_URL" \
        $table_args \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        | gzip > "$output_file"
    
    local size=$(du -h "$output_file" | cut -f1)
    echo -e "${GREEN}✅ Trader tables backup complete: $size${NC}"
}

###############################################################################
# 主流程
###############################################################################

echo "════════════════════════════════════════════════════════"
echo "  Arena Supabase Backup"
echo "  Time: $(date +'%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════════"
echo ""

if [ "$TABLES_ONLY" = true ]; then
    backup_trader_tables
else
    backup_full
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo -e "${GREEN}✅ Backup completed successfully!${NC}"
echo "════════════════════════════════════════════════════════"
echo ""
echo "📁 Backup location: $OUTPUT_DIR"
echo ""
echo "📋 Next steps:"
echo "  1. Verify backup integrity:"
echo "     gunzip -c $OUTPUT_DIR/arena-*-$TIMESTAMP.sql.gz | head -50"
echo ""
echo "  2. Test restore (to temporary database):"
echo "     createdb arena_test"
echo "     gunzip -c $OUTPUT_DIR/arena-*-$TIMESTAMP.sql.gz | psql arena_test"
echo ""
echo "  3. Upload to R2 (for long-term storage):"
echo "     Use: npm run backup:r2"
echo ""
echo "⚠️  Remember:"
echo "  - This is a LOCAL backup only"
echo "  - For automated backups, use: npm run backup:r2"
echo "  - For disaster recovery, see: docs/DISASTER_RECOVERY.md"
echo ""

# 列出最近的备份
echo "📂 Recent backups in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"/arena-*backup*.sql.gz 2>/dev/null | tail -5 || echo "  (no backups found)"
