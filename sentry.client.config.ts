/**
 * Sentry client config -- intentionally empty.
 *
 * The @sentry/nextjs webpack plugin auto-injects this file into the client
 * bundle. A synchronous `import * as Sentry` here would add ~200KB+ to the
 * critical path and block FCP/LCP.
 *
 * All client-side Sentry initialization is handled in instrumentation-client.ts
 * via requestIdleCallback / dynamic import, keeping Sentry entirely off the
 * critical rendering path.
 *
 * DO NOT add Sentry.init() here -- it will create a duplicate init and undo
 * the deferred loading strategy.
 */
