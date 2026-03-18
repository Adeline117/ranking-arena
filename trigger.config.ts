import { defineConfig } from '@trigger.dev/sdk/v3'

export default defineConfig({
  project: 'arena-ranking',
  dirs: ['lib/jobs'],
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
})
