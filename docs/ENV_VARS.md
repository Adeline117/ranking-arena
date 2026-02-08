# Environment Variables

## Core Infrastructure

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `DATABASE_URL` | ✅ | ❌ | PostgreSQL connection string |
| `SUPABASE_URL` | ✅ | ❌ | Supabase project URL (server-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ❌ | Supabase service role key |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ | Supabase project URL (client-side) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | ✅ | Supabase anonymous key |
| `REDIS_URL` | ❌ | ❌ | Redis connection URL |
| `UPSTASH_REDIS_REST_URL` | ❌ | ❌ | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | ❌ | ❌ | Upstash Redis REST token |
| `NODE_ENV` | ❌ | ❌ | `development` / `production` / `test` |

## Authentication & Security

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `CRON_SECRET` | ✅ | ❌ | Secret for authenticating Vercel cron requests |
| `ADMIN_SECRET` | ✅ | ❌ | Admin API authentication secret |
| `ADMIN_EMAILS` | ❌ | ❌ | Comma-separated admin email list |
| `NEXT_PUBLIC_ADMIN_EMAILS` | ❌ | ✅ | Client-side admin email list |
| `INVITE_SECRET` | ❌ | ❌ | Secret for invite link generation |
| `ENCRYPTION_KEY` | ✅ | ❌ | Encryption key for sensitive data |
| `ENCRYPTION_KEY_PART1` | ❌ | ❌ | Split encryption key (part 1) |
| `ENCRYPTION_SALT` | ❌ | ❌ | Salt for encryption |
| `WORKER_SECRET` | ❌ | ❌ | Auth secret for worker endpoints |

## Application URLs

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `NEXT_PUBLIC_APP_URL` | ✅ | ✅ | Application base URL, e.g. `https://ranking-arena.com` |
| `NEXT_PUBLIC_SITE_URL` | ❌ | ✅ | Site URL (alias for APP_URL) |
| `WORKER_URL` | ❌ | ❌ | Worker service URL |
| `NEXT_PUBLIC_ANALYTICS_ENDPOINT` | ❌ | ✅ | Analytics endpoint URL |

## Exchange API Keys

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `BINANCE_OAUTH_CLIENT_ID` | ❌ | ❌ | Binance OAuth client ID |
| `BINANCE_OAUTH_CLIENT_SECRET` | ❌ | ❌ | Binance OAuth client secret |
| `BYBIT_API_KEY` | ❌ | ❌ | Bybit API key |
| `BYBIT_API_SECRET` | ❌ | ❌ | Bybit API secret |
| `BYBIT_OAUTH_CLIENT_ID` | ❌ | ❌ | Bybit OAuth client ID |
| `BYBIT_OAUTH_CLIENT_SECRET` | ❌ | ❌ | Bybit OAuth client secret |
| `BITGET_API_KEY` | ❌ | ❌ | Bitget API key |
| `BITGET_API_SECRET` | ❌ | ❌ | Bitget API secret |
| `BITGET_API_PASSPHRASE` | ❌ | ❌ | Bitget API passphrase |
| `GATEIO_API_KEY` | ❌ | ❌ | Gate.io API key |
| `GATEIO_API_SECRET` | ❌ | ❌ | Gate.io API secret |
| `DRIFT_API_KEY` | ❌ | ❌ | Drift protocol API key |

## Web3 / Blockchain

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `ARBITRUM_RPC_URL` | ❌ | ❌ | Arbitrum RPC endpoint |
| `BASE_RPC_URL` | ❌ | ❌ | Base mainnet RPC endpoint |
| `BASE_SEPOLIA_RPC_URL` | ❌ | ❌ | Base Sepolia testnet RPC |
| `NEXT_PUBLIC_BASE_RPC_URL` | ❌ | ✅ | Base RPC (client-side) |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | ❌ | ✅ | Base Sepolia RPC (client-side) |
| `OPTIMISM_RPC_URL` | ❌ | ❌ | Optimism RPC endpoint |
| `POLYGON_RPC_URL` | ❌ | ❌ | Polygon RPC endpoint |
| `ARENA_ATTESTER_PRIVATE_KEY` | ❌ | ❌ | Private key for EAS attestations |
| `NFT_MINTER_PRIVATE_KEY` | ❌ | ❌ | Private key for NFT minting |
| `HSM_ENDPOINT` | ❌ | ❌ | Hardware Security Module endpoint |
| `HSM_KEY_ID` | ❌ | ❌ | HSM key identifier |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | ❌ | ✅ | WalletConnect project ID |
| `NEXT_PUBLIC_ARENA_SCORE_SCHEMA_UID` | ❌ | ✅ | EAS schema UID for arena scores |
| `NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS` | ❌ | ✅ | Membership NFT contract address |
| `NEXT_PUBLIC_SNAPSHOT_SPACE_ID` | ❌ | ✅ | Snapshot governance space ID |
| `THEGRAPH_API_KEY` | ❌ | ❌ | The Graph API key |

## Smart Contract Addresses (Public)

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `NEXT_PUBLIC_COPY_TRADING_ARBITRUM` | ❌ | ✅ | Copy trading contract (Arbitrum) |
| `NEXT_PUBLIC_COPY_TRADING_BASE` | ❌ | ✅ | Copy trading contract (Base) |
| `NEXT_PUBLIC_COPY_TRADING_BASE_SEPOLIA` | ❌ | ✅ | Copy trading contract (Base Sepolia) |
| `NEXT_PUBLIC_COPY_TRADING_OPTIMISM` | ❌ | ✅ | Copy trading contract (Optimism) |

## Payments (Stripe)

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `STRIPE_SECRET_KEY` | ✅ | ❌ | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | ✅ | ❌ | Stripe webhook signing secret |
| `STRIPE_PRICE_MONTHLY_ID` | ❌ | ❌ | Stripe monthly price ID |
| `STRIPE_PRICE_YEARLY_ID` | ❌ | ❌ | Stripe yearly price ID |
| `STRIPE_PRO_PRICE_ID` | ❌ | ❌ | Stripe Pro plan price ID |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | ❌ | ❌ | Stripe Pro monthly price ID |
| `STRIPE_PRO_YEARLY_PRICE_ID` | ❌ | ❌ | Stripe Pro yearly price ID |
| `STRIPE_ELITE_PRICE_ID` | ❌ | ❌ | Stripe Elite plan price ID |

## External Services

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `OPENAI_API_KEY` | ❌ | ❌ | OpenAI API key (for AI features) |
| `NEXT_PUBLIC_SENTRY_DSN` | ❌ | ✅ | Sentry error tracking DSN |
| `RESEND_API_KEY` | ❌ | ❌ | Resend email API key |
| `RESEND_FROM_EMAIL` | ❌ | ❌ | Sender email for Resend, e.g. `noreply@ranking-arena.com` |
| `TELEGRAM_BOT_TOKEN` | ❌ | ❌ | Telegram bot token for alerts |
| `TELEGRAM_ALERT_CHAT_ID` | ❌ | ❌ | Telegram chat ID for alert messages |
| `FCM_SERVER_KEY` | ❌ | ❌ | Firebase Cloud Messaging server key |

## Cloudflare R2 Storage

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `R2_ACCOUNT_ID` | ❌ | ❌ | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | ❌ | ❌ | R2 access key |
| `R2_SECRET_ACCESS_KEY` | ❌ | ❌ | R2 secret key |
| `R2_BUCKET` | ❌ | ❌ | R2 bucket name |
| `R2_PUBLIC_URL` | ❌ | ❌ | R2 public URL for assets |
| `CLOUDFLARE_PROXY_URL` | ❌ | ❌ | Cloudflare Worker proxy URL |
| `CLOUDFLARE_PROXY_SECRET` | ❌ | ❌ | Cloudflare proxy auth secret |

## QStash (Upstash)

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `QSTASH_TOKEN` | ❌ | ❌ | QStash API token |
| `QSTASH_CURRENT_SIGNING_KEY` | ❌ | ❌ | QStash current signing key |
| `QSTASH_NEXT_SIGNING_KEY` | ❌ | ❌ | QStash next signing key |

## Worker Configuration

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `WORKER_BATCH_SIZE` | ❌ | ❌ | Worker batch size (default: varies) |
| `WORKER_POLL_INTERVAL` | ❌ | ❌ | Worker poll interval in ms |
| `WORKER_PLATFORMS` | ❌ | ❌ | Comma-separated platform list for worker |

## Smart Scheduler Configuration

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `ENABLE_SMART_SCHEDULER` | ❌ | ❌ | Enable smart scheduling (`true`/`false`) |
| `SMART_SCHEDULER_HOT_INTERVAL_MINUTES` | ❌ | ❌ | Hot tier refresh interval |
| `SMART_SCHEDULER_HOT_RANK_THRESHOLD` | ❌ | ❌ | Rank threshold for hot tier |
| `SMART_SCHEDULER_HOT_FOLLOWERS_THRESHOLD` | ❌ | ❌ | Followers threshold for hot tier |
| `SMART_SCHEDULER_HOT_VIEWS_THRESHOLD` | ❌ | ❌ | Views threshold for hot tier |
| `SMART_SCHEDULER_ACTIVE_INTERVAL_MINUTES` | ❌ | ❌ | Active tier refresh interval |
| `SMART_SCHEDULER_ACTIVE_FOLLOWERS_THRESHOLD` | ❌ | ❌ | Followers threshold for active tier |
| `SMART_SCHEDULER_ACTIVE_RANK_THRESHOLD` | ❌ | ❌ | Rank threshold for active tier |
| `SMART_SCHEDULER_NORMAL_INTERVAL_MINUTES` | ❌ | ❌ | Normal tier refresh interval |
| `SMART_SCHEDULER_NORMAL_RANK_THRESHOLD` | ❌ | ❌ | Rank threshold for normal tier |
| `SMART_SCHEDULER_DORMANT_INTERVAL_MINUTES` | ❌ | ❌ | Dormant tier refresh interval |
| `SMART_SCHEDULER_MAX_BATCH_SIZE` | ❌ | ❌ | Max batch size per run |
| `SMART_SCHEDULER_STAGGER_MS` | ❌ | ❌ | Stagger delay between requests |
| `SMART_SCHEDULER_TIER_RECALC_MINUTES` | ❌ | ❌ | Tier recalculation interval |

## Anomaly Detection

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `ENABLE_ANOMALY_DETECTION` | ❌ | ❌ | Enable anomaly detection (`true`/`false`) |
| `ANOMALY_DETECTION_Z_SCORE_THRESHOLD` | ❌ | ❌ | Z-score threshold (default: 3.0) |
| `ANOMALY_DETECTION_IQR_MULTIPLIER` | ❌ | ❌ | IQR multiplier (default: 1.5) |
| `ANOMALY_DETECTION_MIN_SAMPLE_SIZE` | ❌ | ❌ | Min sample size (default: 10) |

## Groups

| Variable | Required | Public | Description |
|----------|----------|--------|-------------|
| `PRO_OFFICIAL_GROUP_ID` | ❌ | ❌ | Pro official group/channel ID |
