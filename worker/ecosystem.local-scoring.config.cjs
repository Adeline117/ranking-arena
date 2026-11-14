'use strict'

/**
 * PM2 config for the scoring process (`arena-worker`) in the controlled local
 * release channel (worker/deploy-scoring-local.sh). Mirrors
 * ecosystem.local-ingest.config.cjs: every path comes from an exact-commit
 * release directory, and PM2 runs the prebuilt artifact
 * (worker/dist/scoring-worker.mjs, see worker/build-scoring-worker.mjs) with
 * an explicit Node binary — never `npx tsx` against the shared working tree
 * (the legacy worker/ecosystem.config.cjs entry, 2026-11 audit P1-3).
 *
 * V1 NO-GO: this file only describes a release. It must not be started while
 * V1_RANKING_COMMAND_CHAIN_PUBLISHED is false; deploy-scoring-local.sh refuses.
 */

const { accessSync, constants, lstatSync, statSync } = require('node:fs')
const { isAbsolute, join, normalize } = require('node:path')

function requireAbsolutePath(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return normalize(value)
}

function requireEntry(path, description, kind, { rejectSymlink = false } = {}) {
  let metadata
  try {
    metadata = rejectSymlink ? lstatSync(path) : statSync(path)
  } catch (error) {
    throw new Error(`${description} is not accessible: ${path}`, { cause: error })
  }
  if (rejectSymlink && metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink: ${path}`)
  }
  if (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
    throw new Error(`${description} must be a ${kind}: ${path}`)
  }
}

const releaseDir = requireAbsolutePath('ARENA_SCORING_RELEASE_DIR')
const nodeBin = requireAbsolutePath('ARENA_NODE_BIN')

requireEntry(releaseDir, 'ARENA_SCORING_RELEASE_DIR', 'directory', { rejectSymlink: true })
requireEntry(nodeBin, 'ARENA_NODE_BIN', 'file', { rejectSymlink: true })
try {
  accessSync(nodeBin, constants.X_OK)
} catch (error) {
  throw new Error(`ARENA_NODE_BIN is not executable: ${nodeBin}`, { cause: error })
}

const workerDir = join(releaseDir, 'worker')
const logDir = join(workerDir, 'logs')
const envFile = join(workerDir, '.env')
const artifact = join(workerDir, 'dist', 'scoring-worker.mjs')

requireEntry(workerDir, 'release worker directory', 'directory')
requireEntry(logDir, 'release worker log directory', 'directory')
requireEntry(envFile, 'release worker environment file', 'file')
requireEntry(artifact, 'prebuilt scoring worker artifact', 'file', { rejectSymlink: true })

module.exports = {
  apps: [
    {
      name: 'arena-worker',
      cwd: releaseDir,
      script: artifact,
      interpreter: nodeBin,
      // index.ts loads worker/.env itself (dotenv, resolved next to the
      // artifact's ../.env); PM2 7 does not implement env_file.
      env: { NODE_ENV: 'production' },
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: join(logDir, 'scoring-error.log'),
      out_file: join(logDir, 'scoring-out.log'),
      merge_logs: true,
      max_memory_restart: '512M',
      node_args: ['--enable-source-maps'],
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
}
