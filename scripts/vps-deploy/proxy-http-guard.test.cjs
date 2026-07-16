const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const test = require('node:test')

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForHealth(origin) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${origin}/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('proxy test server did not become healthy')
}

test('caps request bodies and rate-limits authenticated traffic', async (t) => {
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['arena-proxy.mjs'], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      PORT: String(port),
      PROXY_KEY_CURRENT: 'qa-current-transition-key',
      PROXY_MAX_REQUEST_BYTES: '128',
      PROXY_RATE_LIMIT_MAX: '2',
    },
    stdio: 'ignore',
  })
  t.after(() => child.kill('SIGTERM'))
  await waitForHealth(origin)

  const oversized = await fetch(origin, {
    method: 'POST',
    headers: { 'X-Proxy-Key': 'qa-current-transition-key' },
    body: JSON.stringify({ payload: 'x'.repeat(256) }),
  })
  assert.equal(oversized.status, 413)

  const accepted = await fetch(origin, {
    method: 'POST',
    headers: { 'X-Proxy-Key': 'qa-current-transition-key' },
    body: '{}',
  })
  assert.equal(accepted.status, 400)

  const limited = await fetch(origin, {
    method: 'POST',
    headers: { 'X-Proxy-Key': 'wrong-key' },
    body: '{}',
  })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
})
