'use client';

/**
 * Privy Provider Wrapper (Lazy-loaded)
 * 
 * Defers loading the heavy Privy/Wagmi/Wallet SDK bundle until user interaction.
 * This reduces initial TBT by ~500-800ms and JS parse time significantly.
 */

import { ReactNode, useState, useEffect, lazy, Suspense } from 'react';
import { PRIVY_APP_ID } from '@/lib/privy/config';

// Lazy-load the actual PrivyProvider to defer its massive JS bundle
const LazyPrivyProvider = lazy(() => import('./PrivyProviderInner'));

interface Props {
  children: ReactNode;
}

export default function PrivyClientProvider({ children }: Props) {
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (!PRIVY_APP_ID) return;

    // Only load Privy when user interacts (click/touch/key).
    // This avoids downloading ~956KB of wallet SDK on initial page load,
    // drastically improving PageSpeed scores for first-time visitors.
    const events = ['click', 'touchstart', 'keydown'] as const;
    const handler = () => {
      setShouldLoad(true);
      events.forEach(e => document.removeEventListener(e, handler));
    };
    events.forEach(e => document.addEventListener(e, handler, { once: true, passive: true }));
    return () => {
      events.forEach(e => document.removeEventListener(e, handler));
    };
  }, []);

  if (!PRIVY_APP_ID || !shouldLoad) {
    return <>{children}</>;
  }

  return (
    <Suspense fallback={<>{children}</>}>
      <LazyPrivyProvider>{children}</LazyPrivyProvider>
    </Suspense>
  );
}
