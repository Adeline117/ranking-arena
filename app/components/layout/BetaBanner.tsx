/**
 * BetaBanner — Server-rendered for LCP optimization.
 *
 * Previously a 'use client' component loaded via dynamic() — this made it
 * invisible until JS hydrated (~3-5s on slow 4G), which could cause it to
 * become the LCP element when it popped in late.
 *
 * Now rendered as a server component with fixed positioning (no layout shift).
 * Dismiss logic is handled via a tiny inline script that reads localStorage
 * before paint, avoiding a flash of the banner for dismissed users.
 */

export default function BetaBanner() {
  if (process.env.NEXT_PUBLIC_SHOW_BETA_BANNER === 'false') return null

  return (
    <>
      <div
        id="beta-banner"
        style={{
          background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
          color: 'white',
          textAlign: 'center',
          padding: '10px 48px 10px 16px',
          fontSize: '14px',
          fontWeight: 600,
          position: 'relative',
          zIndex: 1, /* flows in document — no longer overlaps sticky header */
        }}
      >
        Arena is in closed beta — data is being updated and some features are under development.
        <button
          id="beta-banner-dismiss"
          aria-label="Dismiss"
          style={{
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            color: 'white',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '8px 12px',
            lineHeight: 1,
            opacity: 0.8,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
      {/* Inline script: hide if dismissed <24h ago, attach click handler.
          Runs synchronously before paint to avoid flash. */}
      <script dangerouslySetInnerHTML={{ __html: `(function(){var k='beta-banner-dismissed-at',b=document.getElementById('beta-banner');if(!b)return;try{var d=localStorage.getItem(k);if(d&&Date.now()-Number(d)<864e5){b.style.display='none';return}}catch(e){}var btn=document.getElementById('beta-banner-dismiss');if(btn)btn.onclick=function(){try{localStorage.setItem(k,String(Date.now()))}catch(e){}b.style.display='none'}})()` }} />
    </>
  )
}
