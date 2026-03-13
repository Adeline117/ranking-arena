#!/bin/bash
set -euo pipefail

###############################################################################
# Arena 密钥轮换脚本
# 
# 用途：安全地轮换所有生产密钥并更新Vercel环境变量
# 使用：./rotate-secrets.sh [--service SERVICE] [--dry-run]
# 
# 示例：
#   ./rotate-secrets.sh --dry-run                # 预览所有操作
#   ./rotate-secrets.sh --service telegram       # 只轮换Telegram Bot Token
#   ./rotate-secrets.sh --service supabase       # 只轮换Supabase密钥
# 
# 前置要求：
#   1. vercel CLI: npm i -g vercel
#   2. vercel login
#   3. 访问各服务Dashboard的权限
# 
# 审计记录：scripts/security/rotation-history.log
###############################################################################

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 配置
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/scripts/security/rotation-history.log"
DRY_RUN=false
SERVICE=""

# 日志函数
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $*"
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
    echo "[WARNING] $*" >> "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
    echo "[ERROR] $*" >> "$LOG_FILE"
    exit 1
}

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --service)
            SERVICE="$2"
            shift 2
            ;;
        *)
            error "Unknown option: $1"
            ;;
    esac
done

# 检查Vercel CLI
if ! command -v vercel &> /dev/null; then
    error "Vercel CLI not found. Install: npm i -g vercel"
fi

log "🔄 Starting secret rotation process..."
if [ "$DRY_RUN" = true ]; then
    warn "DRY RUN MODE - No changes will be made"
fi

###############################################################################
# 1. Telegram Bot Token
###############################################################################
rotate_telegram() {
    log "📱 Rotating Telegram Bot Token..."
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate Telegram Bot Token"
        echo "  Steps:"
        echo "    1. Visit https://t.me/BotFather"
        echo "    2. Send /revoke to BotFather"
        echo "    3. Generate new token"
        echo "    4. Update Vercel env: vercel env rm TELEGRAM_BOT_TOKEN production"
        echo "    5. Update Vercel env: vercel env add TELEGRAM_BOT_TOKEN production"
        echo "    6. Redeploy: vercel --prod"
        return
    fi
    
    echo "❌ MANUAL ACTION REQUIRED:"
    echo "  1. Visit https://t.me/BotFather"
    echo "  2. Send: /mybots → Select @ArenaFiBot → API Token → Revoke current token"
    echo "  3. Copy new token"
    read -p "Paste new Telegram Bot Token: " NEW_TOKEN
    
    if [ -z "$NEW_TOKEN" ]; then
        error "Empty token provided"
    fi
    
    # 更新Vercel环境变量
    vercel env rm TELEGRAM_BOT_TOKEN production --yes
    echo "$NEW_TOKEN" | vercel env add TELEGRAM_BOT_TOKEN production
    
    # 更新本地.env
    sed -i.bak "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=\"$NEW_TOKEN\"/" "$PROJECT_ROOT/.env"
    
    log "✅ Telegram Bot Token rotated successfully"
}

###############################################################################
# 2. Supabase密钥
###############################################################################
rotate_supabase() {
    log "🗄️ Rotating Supabase Service Role Key..."
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate Supabase Service Role Key"
        echo "  Steps:"
        echo "    1. Visit https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/settings/api"
        echo "    2. Click 'Rotate service_role key'"
        echo "    3. Update Vercel env variables"
        return
    fi
    
    warn "Supabase Service Role Key轮换需要手动操作"
    echo "Steps:"
    echo "  1. 访问 https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/settings/api"
    echo "  2. 点击 'Rotate service_role key' 按钮"
    echo "  3. 复制新的key"
    read -p "Paste new Service Role Key: " NEW_KEY
    
    if [ -z "$NEW_KEY" ]; then
        error "Empty key provided"
    fi
    
    vercel env rm SUPABASE_SERVICE_ROLE_KEY production --yes
    echo "$NEW_KEY" | vercel env add SUPABASE_SERVICE_ROLE_KEY production
    
    sed -i.bak "s/SUPABASE_SERVICE_ROLE_KEY=.*/SUPABASE_SERVICE_ROLE_KEY=\"$NEW_KEY\"/" "$PROJECT_ROOT/.env"
    
    log "✅ Supabase Service Role Key rotated successfully"
}

###############################################################################
# 3. Upstash Redis Token
###############################################################################
rotate_upstash() {
    log "⚡ Rotating Upstash Redis Token..."
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate Upstash Redis Token"
        echo "  Steps:"
        echo "    1. Visit https://console.upstash.com/redis"
        echo "    2. Select database → Details → Rotate REST Token"
        return
    fi
    
    warn "Upstash Redis Token轮换需要手动操作"
    echo "Steps:"
    echo "  1. 访问 https://console.upstash.com/redis"
    echo "  2. 选择你的数据库 → Details → Rotate REST Token"
    read -p "Paste new REST Token: " NEW_TOKEN
    
    if [ -z "$NEW_TOKEN" ]; then
        error "Empty token provided"
    fi
    
    vercel env rm UPSTASH_REDIS_REST_TOKEN production --yes
    echo "$NEW_TOKEN" | vercel env add UPSTASH_REDIS_REST_TOKEN production
    
    sed -i.bak "s/UPSTASH_REDIS_REST_TOKEN=.*/UPSTASH_REDIS_REST_TOKEN=\"$NEW_TOKEN\"/" "$PROJECT_ROOT/.env"
    
    log "✅ Upstash Redis Token rotated successfully"
}

###############################################################################
# 4. CRON_SECRET
###############################################################################
rotate_cron_secret() {
    log "🔐 Rotating CRON_SECRET..."
    
    # 生成新的随机密钥
    NEW_SECRET=$(openssl rand -base64 32)
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate CRON_SECRET"
        echo "  New secret: $NEW_SECRET"
        return
    fi
    
    vercel env rm CRON_SECRET production --yes
    echo "$NEW_SECRET" | vercel env add CRON_SECRET production
    
    sed -i.bak "s/CRON_SECRET=.*/CRON_SECRET=\"$NEW_SECRET\"/" "$PROJECT_ROOT/.env"
    
    log "✅ CRON_SECRET rotated successfully"
}

###############################################################################
# 5. Sentry Auth Token
###############################################################################
rotate_sentry() {
    log "🐛 Rotating Sentry Auth Token..."
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate Sentry Auth Token"
        echo "  Steps:"
        echo "    1. Visit https://sentry.io/settings/account/api/auth-tokens/"
        echo "    2. Revoke old token"
        echo "    3. Create new token with 'project:releases' scope"
        return
    fi
    
    warn "Sentry Auth Token轮换需要手动操作"
    echo "Steps:"
    echo "  1. 访问 https://sentry.io/settings/account/api/auth-tokens/"
    echo "  2. Revoke旧token"
    echo "  3. Create new token（需要 'project:releases' scope）"
    read -p "Paste new Auth Token: " NEW_TOKEN
    
    if [ -z "$NEW_TOKEN" ]; then
        error "Empty token provided"
    fi
    
    vercel env rm SENTRY_AUTH_TOKEN production --yes
    echo "$NEW_TOKEN" | vercel env add SENTRY_AUTH_TOKEN production
    
    sed -i.bak "s/SENTRY_AUTH_TOKEN=.*/SENTRY_AUTH_TOKEN=\"$NEW_TOKEN\"/" "$PROJECT_ROOT/.env"
    
    log "✅ Sentry Auth Token rotated successfully"
}

###############################################################################
# 6. VPS_PROXY_KEY
###############################################################################
rotate_vps_proxy() {
    log "🔑 Rotating VPS_PROXY_KEY..."
    
    # 生成新的随机密钥
    NEW_KEY=$(openssl rand -base64 32)
    
    if [ "$DRY_RUN" = true ]; then
        echo "  [DRY RUN] Would rotate VPS_PROXY_KEY"
        echo "  New key: $NEW_KEY"
        echo "  ⚠️ IMPORTANT: Update VPS server config!"
        return
    fi
    
    vercel env rm VPS_PROXY_KEY production --yes
    echo "$NEW_KEY" | vercel env add VPS_PROXY_KEY production
    
    sed -i.bak "s/VPS_PROXY_KEY=.*/VPS_PROXY_KEY=\"$NEW_KEY\"/" "$PROJECT_ROOT/.env"
    
    warn "⚠️ IMPORTANT: 需要同步更新VPS服务器的配置！"
    echo "  SSH到VPS并更新环境变量："
    echo "  echo 'VPS_PROXY_KEY=\"$NEW_KEY\"' >> /path/to/vps/.env"
    
    log "✅ VPS_PROXY_KEY rotated successfully"
}

###############################################################################
# 主流程
###############################################################################

# 根据--service参数决定轮换哪些密钥
case "$SERVICE" in
    telegram)
        rotate_telegram
        ;;
    supabase)
        rotate_supabase
        ;;
    upstash)
        rotate_upstash
        ;;
    cron)
        rotate_cron_secret
        ;;
    sentry)
        rotate_sentry
        ;;
    vps)
        rotate_vps_proxy
        ;;
    "")
        # 轮换所有密钥
        log "Rotating all secrets..."
        rotate_cron_secret
        rotate_telegram
        rotate_supabase
        rotate_upstash
        rotate_sentry
        rotate_vps_proxy
        ;;
    *)
        error "Unknown service: $SERVICE"
        ;;
esac

###############################################################################
# 完成
###############################################################################

if [ "$DRY_RUN" = false ]; then
    log "✅ Secret rotation complete!"
    log "Next steps:"
    echo "  1. Redeploy Vercel: vercel --prod"
    echo "  2. Test all services"
    echo "  3. Verify Telegram bot works"
    echo "  4. Check cron jobs execute successfully"
    echo "  5. Update VPS config if needed"
    
    # 备份.env
    cp "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.$(date +%Y%m%d-%H%M%S)"
    log "Backup created: .env.$(date +%Y%m%d-%H%M%S)"
fi

log "📝 Rotation log: $LOG_FILE"
