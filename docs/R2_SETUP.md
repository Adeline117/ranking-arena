# Cloudflare R2 Setup — Library PDF/Ebook Storage

## Overview

We use Cloudflare R2 (S3-compatible object storage) to host PDFs and ebooks for the library, enabling in-app reading without external redirects.

**Current state:** 2,104 of 60,689 library items have `pdf_url` pointing to external sources. This setup migrates them to R2 and hosts all future uploads there.

## Setup Steps

### 1. Create R2 Bucket

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **R2 Object Storage**
2. Click **Create bucket**
3. Name: `ranking-arena-library`
4. Location: **Automatic** (or pick WNAM for US West)
5. Click **Create bucket**

### 2. Set Up Custom Domain (Public Access)

1. In the bucket settings → **Settings** → **Public access**
2. Click **Connect Domain**
3. Enter: `cdn.arenafi.org` (or your preferred subdomain)
4. Cloudflare will auto-configure DNS
5. This makes files accessible at `https://cdn.arenafi.org/library/{itemId}/file.pdf`

### 3. Create API Token

1. Go to **R2** → **Manage R2 API Tokens**
2. Click **Create API token**
3. Permissions: **Object Read & Write**
4. Specify bucket: `ranking-arena-library`
5. Click **Create API Token**
6. Save the **Access Key ID** and **Secret Access Key**

### 4. Get Account ID

Your Cloudflare Account ID is in the dashboard URL or on the R2 overview page.

### 5. Configure Environment Variables

Add to `.env.local`:

```env
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=ranking-arena-library
R2_PUBLIC_URL=https://cdn.arenafi.org
```

For production, add these in **Vercel Dashboard → Settings → Environment Variables**.

### 6. Add DB Columns

Run this SQL in Supabase:

```sql
ALTER TABLE library_items
  ADD COLUMN IF NOT EXISTS r2_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS r2_pdf_key TEXT;

-- Index for migration queries
CREATE INDEX IF NOT EXISTS idx_library_items_r2_migration
  ON library_items (pdf_url) WHERE r2_pdf_url IS NULL;
```

### 7. Migrate Existing PDFs

```bash
# Dry run first
npx tsx scripts/migrate-pdfs-to-r2.ts --dry-run

# Migrate in batches of 50
npx tsx scripts/migrate-pdfs-to-r2.ts --limit 50

# Continue from where you left off
npx tsx scripts/migrate-pdfs-to-r2.ts --limit 50 --offset 50
```

## Architecture

```
User → cdn.arenafi.org/library/{id}/file.pdf → Cloudflare R2
                                                    ↑
Upload API (POST /api/library/upload) ──────────────┘
Migration script ───────────────────────────────────┘
```

**Files:**
- `lib/r2.ts` — R2 client (S3-compatible via `@aws-sdk/client-s3`)
- `app/api/library/upload/route.ts` — Upload API endpoint
- `scripts/migrate-pdfs-to-r2.ts` — Batch migration script

## Cost Estimate

R2 pricing (as of 2025):
- **Storage:** $0.015/GB/month
- **Class A ops (writes):** $4.50/million
- **Class B ops (reads):** $0.36/million
- **Egress:** **Free** (this is R2's main advantage)

For ~2,100 PDFs averaging 5MB each ≈ 10.5GB → **~$0.16/month storage**.

## CORS (if needed)

If serving PDFs directly to the browser reader, add CORS rules in the R2 bucket settings:

```json
[
  {
    "AllowedOrigins": ["https://www.arenafi.org", "http://localhost:3000"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```
