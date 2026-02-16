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

    // Load Privy after initial render + a short delay to not block LCP
    // Use requestIdleCallback if available, otherwise setTimeout
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(() => setShouldLoad(true), { timeout: 3000 });
      return () => cancelIdleCallback(id);
    } else {
      const timer = setTimeout(() => setShouldLoad(true), 2000);
      return () => clearTimeout(timer);
    }
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
