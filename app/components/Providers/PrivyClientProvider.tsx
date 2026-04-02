'use client';

/**
 * Privy Provider Wrapper (Lazy-loaded)
 *
 * Defers loading the heavy Privy/Wagmi/Wallet SDK bundle until user interaction.
 * This reduces initial TBT by ~500-800ms and JS parse time significantly.
 *
 * IMPORTANT: Privy SDK uses noble-secp256k1 which can throw BigInt errors
 * in certain environments. We wrap it in an error boundary so any Privy
 * initialization crash doesn't take down the entire page.
 */

import { ReactNode, useState, useEffect, lazy, Suspense, Component } from 'react';
import type { ErrorInfo } from 'react';
import { PRIVY_APP_ID } from '@/lib/privy/config';

// Lazy-load the actual PrivyProvider to defer its massive JS bundle.
// Wrap import in try-catch: noble-secp256k1 can throw BigInt errors at module evaluation
// time (before any React component renders), which ErrorBoundary cannot catch.
const LazyPrivyProvider = lazy(() =>
  import('./PrivyProviderInner').catch((err) => {
    console.warn('[Privy] SDK failed to load, Web3 features disabled:', err?.message);
    // Return a passthrough component so React doesn't crash
    return { default: ({ children }: { children: ReactNode }) => <>{children}</> };
  })
);

/** Isolate Privy SDK crashes — children render without Privy on failure */
class PrivyErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[Privy] SDK initialization failed, Web3 features disabled:', error.message, info.componentStack?.slice(0, 200));
  }
  render() {
    if (this.state.hasError) return <>{this.props.children}</>;
    return this.props.children;
  }
}

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
    <PrivyErrorBoundary>
      <Suspense fallback={<>{children}</>}>
        <LazyPrivyProvider>{children}</LazyPrivyProvider>
      </Suspense>
    </PrivyErrorBoundary>
  );
}
