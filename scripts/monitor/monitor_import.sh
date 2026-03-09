#!/bin/bash
# Arena Import Monitor - Fixed version
set -e

NOTIFY=false
if [[ "$1" == "--notify" ]]; then
    NOTIFY=true
fi

# Find latest log file
LOG_FILE=$(ls -t /var/log/ranking-arena/import_all_api.log 2>/dev/null | head -1)
if [[ -z "$LOG_FILE" ]]; then
    LOG_FILE="/var/log/ranking-arena/import_all_api.log"
fi

DB_HOST="aws-0-us-west-2.pooler.supabase.com"
DB_PORT="6543"
DB_USER="postgres.iknktzifjdyujdccyhsv"
DB_NAME="postgres"
DB_PASS="j0qvCCZDzOHDfBka"

echo "================================================"
echo "Arena Import Monitor"
echo "Time: $(date)"
echo "Log: $LOG_FILE"
echo "================================================"
echo ""

# Check if import is running
if pgrep -f "import_all_platforms.mjs" > /dev/null; then
    echo "⏳ Import is currently running..."
    ps aux | grep "import_all_platforms.mjs" | grep -v grep
    exit 0
fi

# Check last import log
if [[ ! -f "$LOG_FILE" ]]; then
    echo "❌ ERROR: Log file not found: $LOG_FILE"
    exit 1
fi

echo "📋 Last Import Summary:"
echo "---"
tail -100 "$LOG_FILE" | grep -E "===" || echo "(no sections found)"

# Parse results - improved with fallback to 0
parse_count() {
    local result=$(tail -200 "$LOG_FILE" | grep -A30 "$1" | grep "Saved:" | head -1 | grep -oE "[0-9]+/[0-9]+" | cut -d'/' -f1 2>/dev/null)
    if [[ -z "$result" ]]; then
        echo "0"
    else
        echo "$result"
    fi
}

BYBIT_COUNT=$(parse_count "=== BYBIT ===")
BITGET_COUNT=$(parse_count "=== BITGET ===")
MEXC_COUNT=$(parse_count "=== MEXC ===")

# Parse total
TOTAL_COUNT=$(tail -100 "$LOG_FILE" | grep "TOTAL:" | tail -1 | grep -oE "[0-9]+" | tail -1 2>/dev/null || echo "0")
if [[ -z "$TOTAL_COUNT" ]]; then
    TOTAL_COUNT=0
fi

# If log parsing failed, try database as source of truth
if [[ $TOTAL_COUNT -eq 0 ]]; then
    echo "⚠️  Log parsing incomplete, checking database..."
    TOTAL_DB=$(PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(DISTINCT source) FROM leaderboard_snapshots WHERE time_window='30D' AND computed_at > NOW() - INTERVAL '2 hours';" 2>/dev/null | tr -d ' \n' || echo "0")
    if [[ -n "$TOTAL_DB" ]] && [[ "$TOTAL_DB" != "0" ]]; then
        TOTAL_COUNT=$TOTAL_DB
    fi
fi

echo ""
echo "📊 Import Counts (from log):"
echo "  Bybit: $BYBIT_COUNT"
echo "  Bitget: $BITGET_COUNT"
echo "  MEXC: $MEXC_COUNT"
echo "  Total: $TOTAL_COUNT"
echo ""

# Check database
echo "💾 Database Status:"
DB_RESULT=$(PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "
SELECT 
    source || ': ' || COUNT(*) || ' (' || 
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(computed_at)))/60) || ' min ago)'
FROM leaderboard_snapshots 
WHERE time_window='30D' 
    AND computed_at > NOW() - INTERVAL '6 hours'
GROUP BY source 
ORDER BY MAX(computed_at) DESC;
" 2>&1)

if [[ $? -eq 0 ]]; then
    echo "$DB_RESULT"
else
    echo "❌ Database query failed: $DB_RESULT"
fi
echo ""

# Health check
ERRORS=0
WARNINGS=0

# Use database counts if log parsing failed
if [[ $BYBIT_COUNT -eq 0 ]] && [[ $BITGET_COUNT -eq 0 ]] && [[ $MEXC_COUNT -eq 0 ]]; then
    echo "ℹ️  Using database for validation (log parsing incomplete)"
    # Get from database
    BYBIT_COUNT=$(PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM leaderboard_snapshots WHERE source='bybit' AND time_window='30D' AND computed_at > NOW() - INTERVAL '6 hours';" 2>/dev/null | tr -d ' \n' || echo "0")
    BITGET_COUNT=$(PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM leaderboard_snapshots WHERE source='bitget_futures' AND time_window='30D' AND computed_at > NOW() - INTERVAL '6 hours';" 2>/dev/null | tr -d ' \n' || echo "0")
    MEXC_COUNT=$(PGPASSWORD=$DB_PASS psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM leaderboard_snapshots WHERE source='mexc' AND time_window='30D' AND computed_at > NOW() - INTERVAL '6 hours';" 2>/dev/null | tr -d ' \n' || echo "0")
    
    # Ensure numeric
    [[ -z "$BYBIT_COUNT" ]] && BYBIT_COUNT=0
    [[ -z "$BITGET_COUNT" ]] && BITGET_COUNT=0
    [[ -z "$MEXC_COUNT" ]] && MEXC_COUNT=0
    
    TOTAL_COUNT=$((BYBIT_COUNT + BITGET_COUNT + MEXC_COUNT))
    echo "  Database counts: Bybit=$BYBIT_COUNT, Bitget=$BITGET_COUNT, MEXC=$MEXC_COUNT"
    echo ""
fi

# Check if total is reasonable
if [[ $TOTAL_COUNT -lt 1000 ]]; then
    echo "❌ ERROR: Total count too low ($TOTAL_COUNT < 1000)"
    ERRORS=$((ERRORS + 1))
elif [[ $TOTAL_COUNT -lt 1400 ]]; then
    echo "⚠️  WARNING: Total count below expected ($TOTAL_COUNT < 1400)"
    WARNINGS=$((WARNINGS + 1))
fi

# Check individual platforms
if [[ $BYBIT_COUNT -lt 400 ]]; then
    echo "❌ ERROR: Bybit count too low ($BYBIT_COUNT < 400)"
    ERRORS=$((ERRORS + 1))
fi

if [[ $BITGET_COUNT -lt 400 ]]; then
    echo "❌ ERROR: Bitget count too low ($BITGET_COUNT < 400)"
    ERRORS=$((ERRORS + 1))
fi

if [[ $MEXC_COUNT -lt 100 ]]; then
    echo "⚠️  WARNING: MEXC count low ($MEXC_COUNT < 100)"
    WARNINGS=$((WARNINGS + 1))
fi

# Check for errors in log
RECENT_ERRORS=$(tail -50 "$LOG_FILE" | grep -ci "error" || echo "0")
if [[ $RECENT_ERRORS -gt 5 ]]; then
    echo "⚠️  WARNING: $RECENT_ERRORS errors found in recent log"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""
echo "================================================"
if [[ $ERRORS -eq 0 ]] && [[ $WARNINGS -eq 0 ]]; then
    echo "✅ Status: HEALTHY"
    STATUS="✅ HEALTHY"
elif [[ $ERRORS -eq 0 ]]; then
    echo "⚠️  Status: WARNING ($WARNINGS warnings)"
    STATUS="⚠️ WARNING"
else
    echo "❌ Status: CRITICAL ($ERRORS errors, $WARNINGS warnings)"
    STATUS="❌ CRITICAL"
fi
echo "================================================"

# Notify if requested
if [[ "$NOTIFY" == "true" ]]; then
    MESSAGE="🏟 Arena Import Monitor

$STATUS

📊 Import Counts:
• Bybit: $BYBIT_COUNT
• Bitget: $BITGET_COUNT  
• MEXC: $MEXC_COUNT
• Total: $TOTAL_COUNT

$(date)"

    echo "$MESSAGE" > /tmp/arena_monitor_message.txt
    echo ""
    echo "📨 Notification prepared: /tmp/arena_monitor_message.txt"
fi

exit $ERRORS
