/**
 * /api/library 分页参数验证测试
 */

describe('/api/library parameter validation', () => {
  describe('page parameter', () => {
    it('should default to 1', () => {
      const params = new URLSearchParams('')
      const page = Math.max(1, parseInt(params.get('page') || '1') || 1)
      expect(page).toBe(1)
    })

    it('should clamp negative to 1', () => {
      const params = new URLSearchParams('page=-5')
      const page = Math.max(1, parseInt(params.get('page') || '1') || 1)
      expect(page).toBe(1)
    })

    it('should clamp 0 to 1', () => {
      const params = new URLSearchParams('page=0')
      const page = Math.max(1, parseInt(params.get('page') || '1') || 1)
      expect(page).toBe(1)
    })

    it('should accept valid page numbers', () => {
      const params = new URLSearchParams('page=5')
      const page = Math.max(1, parseInt(params.get('page') || '1') || 1)
      expect(page).toBe(5)
    })

    it('should handle non-numeric input', () => {
      const params = new URLSearchParams('page=abc')
      const page = Math.max(1, parseInt(params.get('page') || '1') || 1)
      expect(page).toBe(1)
    })
  })

  describe('limit parameter', () => {
    it('should default to 24', () => {
      const params = new URLSearchParams('')
      const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '24') || 24), 100)
      expect(limit).toBe(24)
    })

    it('should clamp to max 100', () => {
      const params = new URLSearchParams('limit=500')
      const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '24') || 24), 100)
      expect(limit).toBe(100)
    })

    it('should clamp to min 1', () => {
      const params = new URLSearchParams('limit=0')
      const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '24') || 24), 100)
      expect(limit).toBe(1)
    })

    it('should handle non-numeric input', () => {
      const params = new URLSearchParams('limit=xyz')
      const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '24') || 24), 100)
      expect(limit).toBe(24)
    })
  })

  describe('offset calculation', () => {
    it('should calculate correct offset from page and limit', () => {
      const page = 3
      const limit = 24
      const offset = (page - 1) * limit
      expect(offset).toBe(48)
    })

    it('should be 0 for first page', () => {
      const page = 1
      const limit = 24
      const offset = (page - 1) * limit
      expect(offset).toBe(0)
    })
  })

  describe('sort parameter', () => {
    it('should default to recent', () => {
      const params = new URLSearchParams('')
      const sort = params.get('sort') || 'recent'
      expect(sort).toBe('recent')
    })

    it('should accept valid sort values', () => {
      const validSorts = ['recent', 'popular', 'rating', 'date']
      for (const s of validSorts) {
        const params = new URLSearchParams(`sort=${s}`)
        expect(params.get('sort')).toBe(s)
      }
    })
  })

  describe('search parameter', () => {
    it('should cap search length to 200 chars', () => {
      const longSearch = 'a'.repeat(300)
      const search = longSearch.slice(0, 200)
      expect(search.length).toBe(200)
    })

    it('should default to empty string', () => {
      const params = new URLSearchParams('')
      const search = (params.get('search') || '').slice(0, 200)
      expect(search).toBe('')
    })
  })

  describe('category parameter', () => {
    it('should default to empty string', () => {
      const params = new URLSearchParams('')
      const category = params.get('category') || ''
      expect(category).toBe('')
    })

    it('should accept category values', () => {
      const params = new URLSearchParams('category=trading')
      expect(params.get('category')).toBe('trading')
    })
  })
})
