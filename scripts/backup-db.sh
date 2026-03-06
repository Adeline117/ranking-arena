#!/bin/bash
# 每日数据库备份
# 用法: bash scripts/backup-db.sh
# 建议cron: 0 3 * * * bash /Users/adelinewen/ranking-arena/scripts/backup-db.sh

BACKUP_DIR="/Users/adelinewen/ranking-arena/backups"
DB_URL="${process.env.DATABASE_URL}"
DATE=$(date +%Y%m%d_%H%M)
PSQL="/opt/homebrew/opt/libpq/bin/psql"

mkdir -p "$BACKUP_DIR"

echo "[$DATE] Starting backup..."

# 备份关键表
for table in trader_sources leaderboard_ranks library_items trader_equity_curve trader_profiles_v2 user_profiles posts; do
  echo "  Backing up $table..."
  $PSQL "$DB_URL" -c "\\copy $table TO '$BACKUP_DIR/${table}_${DATE}.csv' WITH CSV HEADER" 2>/dev/null
done

# 压缩
cd "$BACKUP_DIR"
tar czf "backup_${DATE}.tar.gz" *_${DATE}.csv 2>/dev/null
rm -f *_${DATE}.csv

# 保留最近7天的备份
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +7 -delete

echo "[$DATE] Backup complete: backup_${DATE}.tar.gz"
ls -lh "$BACKUP_DIR/backup_${DATE}.tar.gz"
