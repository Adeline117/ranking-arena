#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'diagnose.mjs')
const result = spawnSync(process.execPath, [scriptPath, '--seasons'], {
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
