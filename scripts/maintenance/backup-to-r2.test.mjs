import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { preparePgDumpConnection } from './backup-to-r2.mjs'

test('moves an encoded authority password out of the pg_dump URL', () => {
  const result = preparePgDumpConnection(
    'postgresql://backup:p%40ss%3Aword@db.example.com:6543/app?sslmode=require'
  )

  assert.deepEqual(result, {
    connectionUrl: 'postgresql://backup@db.example.com:6543/app?sslmode=require',
    password: 'p@ss:word',
  })
  assert.equal(result.connectionUrl.includes('p%40ss'), false)
})

test('removes query-string passwords and preserves libpq precedence', () => {
  const result = preparePgDumpConnection(
    'postgres://backup:authority-secret@db.example.com/app?sslmode=verify-full&password=query+secret&application_name=arena+backup'
  )

  assert.deepEqual(result, {
    connectionUrl:
      'postgres://backup@db.example.com/app?sslmode=verify-full&application_name=arena+backup',
    password: 'query+secret',
  })
  assert.equal(result.connectionUrl.includes('authority-secret'), false)
  assert.equal(result.connectionUrl.includes('query'), false)
})

test('leaves passwordless URLs and inherited libpq authentication unchanged', () => {
  assert.deepEqual(
    preparePgDumpConnection('postgresql://backup@db.example.com/app?sslmode=require'),
    {
      connectionUrl: 'postgresql://backup@db.example.com/app?sslmode=require',
      password: undefined,
    }
  )

  assert.deepEqual(preparePgDumpConnection('postgresql://db.example.com:6543/app'), {
    connectionUrl: 'postgresql://db.example.com:6543/app',
    password: undefined,
  })
})

test('preserves an explicitly empty URI password over an inherited password', () => {
  assert.deepEqual(preparePgDumpConnection('postgresql://backup:@db.example.com/app'), {
    connectionUrl: 'postgresql://backup@db.example.com/app',
    password: '',
  })
})

test('the executable passes only the sanitized URL in argv and the password through env', async () => {
  const source = await readFile(new URL('./backup-to-r2.mjs', import.meta.url), 'utf8')

  assert.match(source, /`\$\{pgDumpPath\} "\$\{connectionUrl\}"/)
  assert.match(source, /\{ \.\.\.process\.env, PGPASSWORD: password \}/)
  assert.doesNotMatch(source, /`\$\{pgDumpPath\} "\$\{DATABASE_URL\}"/)
})
