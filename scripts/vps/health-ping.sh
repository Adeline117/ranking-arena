#!/bin/bash
# VPS mutual health monitor - each VPS pings the other every 5 min
# Crontab: */5 * * * * /path/to/health-ping.sh
# Env: PEER_VPS_IP, PEER_VPS_NAME, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

PEER_IP="${PEER_VPS_IP:?Set PEER_VPS_IP}"
PEER_NAME="${PEER_VPS_NAME:-Peer VPS}"
COOLDOWN="${ALERT_COOLDOWN:-1800}"
STATE_FILE="/tmp/vps-peer-alert-state"

check_peer() {
  curl -sf --connect-timeout 5 --max-time 10 "http://${PEER_IP}:3000/health" > /dev/null 2>&1 && return 0
  ping -c 2 -W 5 "$PEER_IP" > /dev/null 2>&1 && return 0
  return 1
}

send_telegram() {
  [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ] && { echo "$1"; return; }
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" -d text="$1" -d parse_mode="HTML" > /dev/null 2>&1
}

should_alert() {
  [ ! -f "$STATE_FILE" ] && return 0
  local diff=$(( $(date +%s) - $(cat "$STATE_FILE") ))
  [ "$diff" -ge "$COOLDOWN" ]
}

if check_peer; then
  [ -f "$STATE_FILE" ] && { rm -f "$STATE_FILE"; send_telegram "✅ <b>${PEER_NAME}</b> is back online"; }
else
  if should_alert; then
    date +%s > "$STATE_FILE"
    send_telegram "🚨 <b>${PEER_NAME}</b> (${PEER_IP}) UNREACHABLE at $(date '+%H:%M:%S')"
  fi
fi
