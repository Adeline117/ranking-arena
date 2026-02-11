/**
 * Shared .env.local loader for import scripts
 */
import { readFileSync } from 'fs'

export function loadEnv() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=["']?(.+?)["']?$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch {}
}

// Auto-load on import
loadEnv()
