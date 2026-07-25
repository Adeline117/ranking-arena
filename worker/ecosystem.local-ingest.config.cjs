'use strict'

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

function requireDirectory(path, description, { rejectSymlink = false } = {}) {
  let metadata
  try {
    metadata = rejectSymlink ? lstatSync(path) : statSync(path)
  } catch (error) {
    throw new Error(`${description} is not accessible: ${path}`, { cause: error })
  }
  if (rejectSymlink && metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink: ${path}`)
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${description} must be a directory: ${path}`)
  }
}

function requireFile(path, description, { rejectSymlink = false } = {}) {
  let metadata
  try {
    metadata = rejectSymlink ? lstatSync(path) : statSync(path)
  } catch (error) {
    throw new Error(`${description} is not accessible: ${path}`, { cause: error })
  }
  if (rejectSymlink && metadata.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink: ${path}`)
  }
  if (!metadata.isFile()) {
    throw new Error(`${description} must be a file: ${path}`)
  }
}

const releaseDir = requireAbsolutePath('ARENA_INGEST_RELEASE_DIR')
const nodeBin = requireAbsolutePath('ARENA_NODE_BIN')

requireDirectory(releaseDir, 'ARENA_INGEST_RELEASE_DIR', { rejectSymlink: true })
requireFile(nodeBin, 'ARENA_NODE_BIN', { rejectSymlink: true })
try {
  accessSync(nodeBin, constants.X_OK)
} catch (error) {
  throw new Error(`ARENA_NODE_BIN is not executable: ${nodeBin}`, { cause: error })
}

const workerDir = join(releaseDir, 'worker')
const logDir = join(workerDir, 'logs')
const envFile = join(workerDir, '.env')
const entrypoint = join(workerDir, 'src', 'ingest-worker.ts')
const tsxLoader = join(releaseDir, 'node_modules', 'tsx', 'dist', 'loader.mjs')

requireDirectory(workerDir, 'candidate worker directory')
requireDirectory(logDir, 'candidate worker log directory')
requireFile(envFile, 'candidate worker environment file')
requireFile(entrypoint, 'candidate ingest worker entrypoint', { rejectSymlink: true })
requireFile(tsxLoader, 'candidate tsx loader', { rejectSymlink: true })

module.exports = {
  apps: [
    {
      name: 'arena-ingest-worker',
      cwd: releaseDir,
      script: entrypoint,
      interpreter: nodeBin,
      // ingest-worker.ts and the deployment preflight load worker/.env with
      // dotenv. PM2 7 does not implement env_file loading for ecosystem files.
      env: {
        NODE_ENV: 'production',
        PLAYWRIGHT_BROWSERS_PATH: join(releaseDir, '.playwright-browsers'),
      },
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: join(logDir, 'ingest-error.log'),
      out_file: join(logDir, 'ingest-out.log'),
      merge_logs: true,
      max_memory_restart: '3072M',
      // Importing the release-owned loader keeps the worker in PM2's process;
      // the tsx CLI would spawn a child and break PID-based ownership checks.
      node_args: ['--max-old-space-size=2560', '--import', tsxLoader],
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
  ],
}
