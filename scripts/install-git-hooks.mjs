#!/usr/bin/env node

import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function gitPath(relativePath) {
  const result = spawnSync('git', ['rev-parse', '--git-path', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })

  if (result.status !== 0) return null

  const resolved = result.stdout.trim()
  return path.isAbsolute(resolved) ? resolved : path.join(repositoryRoot, resolved)
}

const hooksDirectory = gitPath('hooks')
if (hooksDirectory) {
  const source = path.join(repositoryRoot, '.githooks', 'pre-commit')
  const destination = path.join(hooksDirectory, 'pre-commit')

  await mkdir(hooksDirectory, { recursive: true })
  await copyFile(source, destination)
  await chmod(destination, 0o755)
}
