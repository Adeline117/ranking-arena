import { readPostDeleteAcknowledgement, readPostDeleteError } from './post-delete-contract'

describe('post delete response contract', () => {
  it('accepts only the exact canonical success envelope', () => {
    expect(readPostDeleteAcknowledgement({ success: true })).toBe(true)
    for (const value of [
      null,
      [],
      {},
      { success: false },
      { success: 1 },
      { success: true, id: 'invented' },
    ]) {
      expect(readPostDeleteAcknowledgement(value)).toBe(false)
    }
  })

  it('accepts only bounded non-empty error text', () => {
    expect(readPostDeleteError({ error: ' Delete failed ' })).toBe('Delete failed')
    expect(readPostDeleteError({ error: '' })).toBeNull()
    expect(readPostDeleteError({ error: 'x'.repeat(201) })).toBeNull()
    expect(readPostDeleteError({ error: { message: 'nested' } })).toBeNull()
  })
})
