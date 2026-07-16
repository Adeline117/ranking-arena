import assert from 'node:assert/strict'
import test from 'node:test'
import { exerciseFill, fillProbeFor } from './input-interaction.mjs'

const cases = [
  [{ tag: 'input', type: '' }, 'qa-probe'],
  [{ tag: 'input', type: 'text' }, 'qa-probe'],
  [{ tag: 'input', type: 'search' }, 'qa-probe'],
  [{ tag: 'input', type: 'tel' }, '5550100'],
  [{ tag: 'input', type: 'password' }, 'qa-probe'],
  [{ tag: 'input', type: 'email' }, 'qa-probe@example.invalid'],
  [{ tag: 'input', type: 'url' }, 'https://example.invalid/'],
  [{ tag: 'input', type: 'number' }, '1'],
  [{ tag: 'textarea', type: '' }, 'qa-probe'],
  [{ tag: 'input', type: 'checkbox' }, null],
  [{ tag: 'input', type: 'radio' }, null],
  [{ tag: 'input', type: 'file' }, null],
  [{ tag: 'input', type: 'date' }, null],
  [{ tag: 'select', type: '' }, null],
  [{ tag: 'button', type: '' }, null],
]

test('dispatches only fill-compatible controls with type-valid probes', () => {
  for (const [descriptor, expected] of cases) {
    assert.equal(fillProbeFor(descriptor), expected, JSON.stringify(descriptor))
  }
})

test('records a successful fill without treating it as a click', async () => {
  const calls = []
  const result = await exerciseFill(
    {
      async fill(value) {
        calls.push(['fill', value])
      },
      async press(key) {
        calls.push(['press', key])
      },
    },
    { tag: 'input', type: 'email' }
  )

  assert.deepEqual(result, { handled: true, ok: true })
  assert.deepEqual(calls, [
    ['fill', 'qa-probe@example.invalid'],
    ['press', 'Escape'],
  ])
})

test('turns a rejected fill into an explicit failure result', async () => {
  const result = await exerciseFill(
    {
      async fill() {
        throw new Error('element is not editable')
      },
      async press() {
        throw new Error('must not press after failed fill')
      },
    },
    { tag: 'textarea', type: '' }
  )

  assert.deepEqual(result, {
    handled: true,
    ok: false,
    error: 'element is not editable',
  })
})

test('leaves checkbox, radio, and file inputs to their non-fill handlers', async () => {
  for (const type of ['checkbox', 'radio', 'file']) {
    const result = await exerciseFill(
      {
        async fill() {
          throw new Error('fill must not be called')
        },
      },
      { tag: 'input', type }
    )
    assert.deepEqual(result, { handled: false })
  }
})
