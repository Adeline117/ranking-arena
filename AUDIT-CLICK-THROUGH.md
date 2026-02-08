# Click-Through Audit Report

Date: 2026-02-08
Method: Code-level static analysis (browser automation unavailable)

---

## CRITICAL BUGS FOUND & FIXED

### 1. Footer Legal Links Return 404 [FIXED]
- **Location:** `app/components/layout/Footer.tsx`
- **Issue:** Links pointed to `/legal/terms`, `/legal/privacy`, `/legal/disclaimer` but the Next.js route group `(legal)` does not create a `/legal/` URL segment. Actual routes are `/terms`, `/privacy`, `/disclaimer`.
- **Impact:** All 3 footer legal links were broken for every user.
- **Fix:** Changed href paths to `/terms`, `/privacy`, `/disclaimer`.

### 2. OnChainCopyTrading Uses raw alert() [FIXED]
- **Location:** `app/components/web3/OnChainCopyTrading.tsx:249`
- **Issue:** "Notify Me" button used `alert('Notification signup coming soon!')` instead of the app's toast system.
- **Impact:** Jarring UX, inconsistent with rest of app.
- **Fix:** Replaced with `showToast()` using the existing Toast system.

---

## ISSUES FOUND (Not Fixed - Low Priority)

### 3. Follow Buttons Show "Coming Soon" When DB Table Missing
- **Location:** `TraderFollowButton.tsx`, `UserFollowButton.tsx`
- **Behavior:** Follow buttons attempt API call, get `tableNotFound` response, show toast "coming soon".
- **Assessment:** Backend issue, not a UI bug. Buttons work correctly -- they make the API call and handle the error gracefully with toast feedback. Fix requires creating the DB table.

### 4. Exchange Partner Logos Not Clickable
- **Location:** `app/components/home/ExchangePartners.tsx`
- **Behavior:** Exchange names (Binance, OKX, etc.) rendered as `<span>` elements with no click handler.
- **Assessment:** Intentional design -- these are display labels, not links. Could be enhanced to filter rankings by exchange on click.

### 5. Comment Image Upload Shows "Coming Soon" Toast
- **Location:** `app/components/post/CommentsModal.tsx:647`
- **Behavior:** Image upload button in comment modal shows toast "coming soon".
- **Assessment:** Feature not yet implemented. Button provides feedback via toast (not broken, just incomplete).

### 6. Footer "Contact Us" Uses `<a>` with `target="_blank"` for Internal Link
- **Location:** `app/components/layout/Footer.tsx`
- **Behavior:** `/u/adelinewen1107` opened with `target="_blank"` and `rel="noopener noreferrer"` as a plain `<a>` tag instead of Next.js `<Link>`.
- **Assessment:** Functional but non-standard. Opens internal route in new tab without client-side navigation benefits.

---

## PAGES AUDITED - INTERACTIVE ELEMENTS STATUS

### Homepage (/)
| Element | Status | Notes |
|---------|--------|-------|
| Time range tabs (90D/30D/7D) | OK | Updates URL, fetches data, visual feedback |
| Ranking table sort headers | OK | All 6 columns sortable with direction toggle |
| Trader row click | OK | Navigates to `/trader/[handle]` |
| View toggle (table/card) | OK | Switches view mode with visual feedback |
| Filter button | OK | Opens advanced filter panel |
| Column settings | OK | Checkbox toggles for column visibility |
| Copy filter link | OK | Copies URL to clipboard |
| Refresh button | OK | Refetches data |
| Pull-to-refresh | OK | Mobile gesture support |
| Export button | OK | Dropdown with CSV/JSON options |
| Sidebar: Popular Traders | OK | Lazy loaded, links to trader pages |
| Sidebar: Watchlist Market | OK | Lazy loaded |
| Sidebar: News Flash | OK | Lazy loaded |
| Exchange Partners | N/A | Display only (not interactive) |
| Guest signup prompt | OK | Shows for logged-out users |

### Rankings (/rankings)
| Element | Status | Notes |
|---------|--------|-------|
| Window tabs (7D/30D/90D) | OK | URL-synced, hover effects, focus ring |
| Category tabs | OK | Filters by CEX/spot/on-chain |
| Exchange quick filter chips | OK | Toggle with clear button |
| Search input | OK | Real-time filtering with clear button |
| Sort headers (all 7) | OK | Sort with direction indicator |
| Trader rows | OK | Full row is a Link to trader detail |
| Virtual scrolling | OK | Activates for >2000 traders |
| Data freshness indicator | OK | Shows staleness badge |

### Hot/Feed (/hot)
| Element | Status | Notes |
|---------|--------|-------|
| Tab switches | OK | onClick handlers present |
| Post card click | OK | Opens modal, URL updates |
| Like/Dislike buttons (in modal) | OK | API call, visual feedback, color change |
| Comment textarea + submit | OK | Disabled when logged out, loading state |
| Expand/collapse long content | OK | Toggle button works |
| Author link | OK | Links to user profile |
| Group badge link | OK | Links to group page |
| Login prompt for actions | OK | Shows for logged-out users |
| Close modal (X, backdrop, ESC) | OK | Multiple close methods |
| Card view count | N/A | Display only |
| Card like/comment counts | N/A | Display only in card view (interactive in modal) |

### Groups (/groups)
| Element | Status | Notes |
|---------|--------|-------|
| Tab switches (my/discover) | OK | onClick handlers |
| Group cards | OK | Link to `/groups/[id]` |
| Create group button | OK | Links to `/groups/apply` |
| "Discover" button in empty state | OK | Switches tab |
| Floating action button | OK | Present |

### Library (/library)
| Element | Status | Notes |
|---------|--------|-------|
| Category tabs | OK | Keyboard navigation support |
| Book cards | OK | Link to `/library/[id]` |
| Pagination (first/prev/page/next/last) | OK | All buttons with disabled states |

### Trader Detail (/trader/[handle])
| Element | Status | Notes |
|---------|--------|-------|
| Breadcrumb links | OK | Links to home and rankings |
| Tab switches (overview/stats/portfolio) | OK | URL-synced with useTransition |
| Follow button | PARTIAL | Works but may show "coming soon" if DB table missing |
| Back to home link | OK | In not-found state |

### Post Detail (/post/[id])
| Element | Status | Notes |
|---------|--------|-------|
| Breadcrumb | OK | Links to /hot |
| PostFeed interactions | OK | Full interaction set via PostFeed component |
| Like/bookmark/repost | OK | Handled by PostFeed callbacks |

### User Profile (/u/[handle])
| Element | Status | Notes |
|---------|--------|-------|
| Follow button | PARTIAL | Same DB table issue as trader follow |
| Message button | OK | Dynamic import, auth-gated |
| Tab switches | OK | With handleTabChange |
| Edit settings button (own profile) | OK | Routes to /settings |
| Follower/following counts (own) | OK | Clickable, navigates to /following |
| Create post button | OK | Routes to `/u/[handle]/new` |
| Post action cards | OK | onClick handlers present |

### TopNav
| Element | Status | Notes |
|---------|--------|-------|
| Logo/home link | OK | Links to / |
| Nav links (Rankings, Groups, Hot, Library) | OK | Active state, click handlers |
| Search input | OK | Form submit, dropdown, keyboard support |
| Mobile search button | OK | Opens overlay |
| Language toggle | OK | onClick handler |
| Theme toggle | OK | onClick handler |
| Notification bell | OK | Mobile -> /inbox, Desktop -> panel toggle |
| User menu toggle | OK | Dropdown with profile/inbox/membership/settings/logout |
| Profile link in menu | OK | Dynamic to /u/[handle] |
| Login button (logged out) | OK | Links to /login |

### Footer
| Element | Status | Notes |
|---------|--------|-------|
| Nav links (Rankings, Groups, Hot, Library) | OK | Next.js Link |
| Legal links (Terms, Privacy, Disclaimer) | FIXED | Were 404, now correct |
| About link | OK | Routes to /about |
| Help link | OK | Routes to /help |
| Twitter/X link | OK | External, target="_blank" |
| Contact Us link | OK | Internal /u/ path, target="_blank" |

### MobileBottomNav
| Element | Status | Notes |
|---------|--------|-------|
| All 5 nav items | OK | Active path detection, Links |

---

## SUMMARY

- **Critical bugs fixed:** 2 (Footer 404 links, alert() in OnChainCopyTrading)
- **Partial functionality:** 2 (Follow buttons depend on DB table existence)
- **Minor issues:** 2 (Exchange logos not clickable, Contact Us uses `<a>` for internal link)
- **Total interactive elements audited:** ~80+
- **Overall health:** Good. Core interactions (navigation, sorting, filtering, posting, commenting) all work correctly.
