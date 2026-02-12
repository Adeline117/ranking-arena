# Privy Integration Plan — Web3 一键登录

> Created: 2026-02-12

## 1. What is Privy

Privy provides unified auth (social login + Web3 wallets) with **embedded wallets** — users who login via Google/email automatically get a Web3 wallet created for them. No MetaMask needed.

## 2. Pricing

| Tier | MAU | Cost |
|------|-----|------|
| **Developer (Free)** | 0–500 | $0 |
| Core | 500–2,499 | $299/mo |
| Scale | 2,500–9,999 | $499/mo |
| Enterprise | 10K+ | Custom |

Free tier includes: 50K signatures/mo, $1M transaction volume/mo. **More than enough for initial launch.**

## 3. Architecture

### Current Stack
- **Auth**: Supabase Auth (Google OAuth)
- **DB**: Supabase Postgres
- **Frontend**: Next.js (App Router)

### Proposed: Privy as Web3 Layer (Not Auth Replacement)

```
User Login Flow:
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Supabase    │     │   Privy      │     │  Embedded    │
│  Google OAuth│────▶│  Link Wallet │────▶│  Wallet      │
│  (existing)  │     │  (optional)  │     │  (auto-gen)  │
└──────────────┘     └──────────────┘     └──────────────┘
```

**Strategy: Keep Supabase as primary auth. Add Privy as optional Web3 wallet layer.**

Reasons:
- Existing auth works fine, no need to rip it out
- Privy can run alongside Supabase — user logs in with Supabase, then Privy creates/links a wallet
- Avoids migration headaches

### Alternative: Privy as Primary Auth
- Replace Supabase auth entirely with Privy
- Privy handles Google, email, wallet login in one flow
- Cleaner but requires migration of all existing users
- **Not recommended for Phase 1**

## 4. User Flows

### Flow A: New User (Recommended Phase 1)
1. User clicks "Login with Google" → Supabase OAuth (unchanged)
2. After login, user sees "Enable Web3 Wallet" button in settings
3. Click → Privy creates embedded wallet, links to Supabase user ID
4. Wallet address stored in `user_wallets` table

### Flow B: Future — Unified Login (Phase 2)
1. User clicks login → Privy modal (Google, email, MetaMask, Phantom)
2. Privy handles auth + wallet creation
3. Privy JWT exchanged for Supabase session via custom auth

## 5. Database Changes

```sql
-- New table (don't modify existing tables)
CREATE TABLE user_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  chain TEXT DEFAULT 'ethereum',
  wallet_type TEXT DEFAULT 'privy_embedded', -- 'privy_embedded' | 'external'
  privy_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, chain)
);
```

## 6. Implementation Steps

### Phase 1: Setup + Wallet Creation (1-2 days)
- [x] Research Privy docs & pricing ✅
- [ ] **Get Privy App ID** from https://dashboard.privy.io (⚠️ needs Adeline)
- [ ] Install `@privy-io/react-auth`
- [ ] Create `PrivyProvider` wrapper component
- [ ] Add "Enable Web3 Wallet" in settings page
- [ ] Create `user_wallets` table in Supabase
- [ ] API route to save wallet address

### Phase 2: Features (3-5 days)
- [ ] Display wallet address on user profile
- [ ] On-chain trader verification (prove you own a wallet)
- [ ] Tipping/donations between users
- [ ] NFT badges for top traders

### Phase 3: Full Web3 Auth (optional, future)
- [ ] Privy as primary auth provider
- [ ] Migrate existing users
- [ ] Wallet-first login flow

## 7. Files to Create

```
app/components/Providers/PrivyClientProvider.tsx  — PrivyProvider wrapper
lib/privy/config.ts                               — Privy configuration
app/api/wallet/link/route.ts                      — API to link wallet to user
```

## 8. Environment Variables Needed

```env
NEXT_PUBLIC_PRIVY_APP_ID=       # From Privy Dashboard
```

## 9. ⚠️ Action Required from Adeline

1. **Create Privy account** at https://dashboard.privy.io
2. **Create a new app** and copy the App ID
3. **Set App ID** in `.env.local` as `NEXT_PUBLIC_PRIVY_APP_ID`
4. In Privy Dashboard: enable Google login + embedded wallets

## 10. Cost Estimate

| Phase | Users | Monthly Cost |
|-------|-------|-------------|
| MVP/Beta | <500 | **$0 (free tier)** |
| Growth | 500-2.5K | $299/mo |
| Scale | 2.5K-10K | $499/mo |

No cost until 500 MAU. Perfect for starting.
