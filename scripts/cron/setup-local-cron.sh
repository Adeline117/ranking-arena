#!/bin/bash
#
# 设置本地 Mac Cron 备份任务
#
# 这个脚本会:
# 1. 创建 launchd plist 文件
# 2. 加载到系统 launchd
# 3. 设置每 4 小时执行一次（与 Vercel Cron 错开）
#
# 用法:
#   ./scripts/cron/setup-local-cron.sh [install|uninstall|status]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_NAME="com.ranking-arena.cron-backup"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$PROJECT_ROOT/logs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

create_plist() {
    mkdir -p "$HOME/Library/LaunchAgents"
    mkdir -p "$LOG_DIR"
    
    cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${PROJECT_ROOT}/scripts/cron/local-cron-backup.mjs</string>
        <string>--api-only</string>
    </array>
    
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    
    <key>StartCalendarInterval</key>
    <array>
        <!-- Run at 02:30, 06:30, 10:30, 14:30, 18:30, 22:30 (every 4 hours, offset by 30 min from Vercel) -->
        <dict>
            <key>Hour</key>
            <integer>2</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>6</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>10</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>14</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>18</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>22</integer>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
    </array>
    
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/launchd-stdout.log</string>
    
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/launchd-stderr.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
    
    echo -e "${GREEN}✅ Created plist: $PLIST_FILE${NC}"
}

install() {
    echo "📦 Installing Ranking Arena local cron backup..."
    echo ""
    
    # Check node
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js not found. Please install Node.js first.${NC}"
        exit 1
    fi
    
    NODE_PATH=$(which node)
    echo "   Node: $NODE_PATH"
    echo "   Project: $PROJECT_ROOT"
    echo ""
    
    # Create plist
    create_plist
    
    # Unload if already loaded
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    
    # Load the plist
    launchctl load "$PLIST_FILE"
    
    echo ""
    echo -e "${GREEN}✅ Local cron backup installed successfully!${NC}"
    echo ""
    echo "Schedule: Every 4 hours at :30 (02:30, 06:30, 10:30, 14:30, 18:30, 22:30)"
    echo "Logs: $LOG_DIR/cron-backup.log"
    echo ""
    echo "Commands:"
    echo "  ./scripts/cron/setup-local-cron.sh status   - Check status"
    echo "  ./scripts/cron/setup-local-cron.sh uninstall - Remove cron job"
    echo "  node scripts/cron/local-cron-backup.mjs --force - Run manually"
}

uninstall() {
    echo "🗑️  Uninstalling Ranking Arena local cron backup..."
    
    if [ -f "$PLIST_FILE" ]; then
        launchctl unload "$PLIST_FILE" 2>/dev/null || true
        rm -f "$PLIST_FILE"
        echo -e "${GREEN}✅ Uninstalled successfully${NC}"
    else
        echo -e "${YELLOW}⚠️  Plist not found, nothing to uninstall${NC}"
    fi
}

status() {
    echo "📊 Ranking Arena Local Cron Status"
    echo "==================================="
    echo ""
    
    if [ -f "$PLIST_FILE" ]; then
        echo -e "${GREEN}✅ Plist installed: $PLIST_FILE${NC}"
    else
        echo -e "${RED}❌ Plist not installed${NC}"
        return
    fi
    
    echo ""
    
    # Check if loaded
    if launchctl list | grep -q "$PLIST_NAME"; then
        echo -e "${GREEN}✅ Service is loaded${NC}"
        launchctl list | grep "$PLIST_NAME"
    else
        echo -e "${YELLOW}⚠️  Service is not loaded${NC}"
    fi
    
    echo ""
    
    # Show recent logs
    if [ -f "$LOG_DIR/cron-backup.log" ]; then
        echo "📜 Recent logs:"
        tail -10 "$LOG_DIR/cron-backup.log"
    fi
}

run_now() {
    echo "🚀 Running cron backup now..."
    node "$PROJECT_ROOT/scripts/cron/local-cron-backup.mjs" --force --api-only
}

# Main
case "${1:-install}" in
    install)
        install
        ;;
    uninstall|remove)
        uninstall
        ;;
    status)
        status
        ;;
    run|now)
        run_now
        ;;
    *)
        echo "Usage: $0 [install|uninstall|status|run]"
        exit 1
        ;;
esac
