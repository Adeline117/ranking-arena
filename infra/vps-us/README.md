# VPS-US Deployment Guide

## Purpose
Second VPS in US region for:
- Fetching US-geo-restricted data sources
- Redundancy for data pipeline
- Load distribution with VPS-SG (45.76.152.169)

## Recommended Specs
- **Provider**: Vultr / DigitalOcean
- **Region**: Los Angeles or San Jose
- **Plan**: $6-12/mo (1-2 vCPU, 2GB RAM, 50GB SSD)
- **OS**: Ubuntu 24.04 LTS

## Setup

```bash
# From local machine:
ssh root@<vps-us-ip> 'bash -s' < infra/vps-us/setup.sh

# Deploy worker code:
rsync -avz --exclude node_modules --exclude .git \
  worker/ root@<vps-us-ip>:/root/arena-worker/

# Copy env (edit REDIS_URL, SUPABASE_URL etc):
scp worker/.env root@<vps-us-ip>:/root/arena-worker/.env

# Install deps & start:
ssh root@<vps-us-ip> "cd /root/arena-worker && npm ci && pm2 start ecosystem.config.js"
```

## Architecture

```
VPS-SG (45.76.152.169)          VPS-US (TBD)
├── BullMQ worker               ├── Playwright worker
├── Redis (primary)              ├── Redis (local cache)
├── Playwright (APAC sources)    ├── US-geo sources
└── Clash proxy                  └── Direct US IP
```

## Monitoring
```bash
pm2 status
pm2 logs arena-worker --lines 50
```
