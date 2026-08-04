# VPS Browser and Proxy Services

This directory owns the PM2 topology for the infrastructure deployed by
`scripts/vps-deploy/deploy.sh`:

- SG: `arena-scraper` (browser HTTP service on port 3457) and `arena-proxy`
  (port 3456).
- JP: `arena-proxy` only.

The canonical SG ingest worker, `arena-ingest-worker-sg`, is deployed separately
under `/opt/arena-ingest`. This directory does not own that worker, any recurring
data-fetch cron, or any database writer. See
[`docs/INGEST_WORKER_DEPLOY.md`](../../docs/INGEST_WORKER_DEPLOY.md) and
[`docs/INGEST_WORKER_TOPOLOGY.md`](../../docs/INGEST_WORKER_TOPOLOGY.md).

The remote `/opt/arena-cron` directory is a retained path name for these PM2
configuration and log files. It does not authorize an `arena-cron` process.

## Deployment

Run the scoped deployment script from the repository root:

```bash
scripts/vps-deploy/deploy.sh sg
scripts/vps-deploy/deploy.sh jp
```

The script copies only the declared service artifacts, verifies that the SG
ingest worker PID is unchanged, rejects the retired `arena-cron` process, and
performs scoped service health checks. It must not be used to deploy or restart
the ingest worker.

## Runtime configuration

Provide `PROXY_KEY_CURRENT` and optionally `PROXY_KEY_NEXT` through the
root-owned, mode-0600 `/etc/arena-proxy.env` file. Do not place credentials in
this repository, the PM2 configuration, command output, or `/etc/environment`.
The proxy/scraper topology must not receive a Supabase service-role key.

## Read-only status

Use `scripts/vps-deploy/check-vps.sh [sg|jp|all]` to check the proxy on either
VPS and the canonical ingest PM2 process on SG. The command does not inspect or
print credentials, old cron logs, or unrelated PM2 applications.

The browser service implementation and endpoint contracts live in
`scripts/vps-deploy/scraper-v16-parallel.js`.
