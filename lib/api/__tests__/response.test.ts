import { success, error, notFound, unauthorized, badRequest, handleError } from '../response'

describe('API Response Helpers', () => {
  describe('success', () => {
    it('should return 200 status with success true', async () => {
      const response = success({ message: 'test' })
      const body = await response.json()
      
      expect(response.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.message).toBe('test')
    })

    it('should allow custom status code', async () => {
      const response = success({ message: 'created' }, 201)
      expect(response.status).toBe(201)
    })
  })

  describe('error', () => {
    it('should return error with message and status', async () => {
      const response = error('Something went wrong', 500)
      const body = await response.json()
      
      expect(response.status).toBe(500)
      expect(body.success).toBe(false)
      expect(body.error.message).toBe('Something went wrong')
    })
  })

  describe('notFound', () => {
    it('should return 404 status', async () => {
      const response = notFound('Resource not found')
      const body = await response.json()
      
      expect(response.status).toBe(404)
      expect(body.success).toBe(false)
      expect(body.error.message).toBe('Resource not found')
    })
  })

  describe('unauthorized', () => {
    it('should return 401 status', async () => {
      const response = unauthorized('Please login')
      const body = await response.json()
      
      expect(response.status).toBe(401)
      expect(body.success).toBe(false)
      expect(body.error.message).toBe('Please login')
    })

    it('should use default message if not provided', async () => {
      const response = unauthorized()
      const body = await response.json()
      
      expect(body.error.message).toBe('未授权')
    })
  })

  describe('badRequest', () => {
    it('should return 400 status', async () => {
      const response = badRequest('Invalid input')
      const body = await response.json()
      
      expect(response.status).toBe(400)
      expect(body.success).toBe(false)
      expect(body.error.message).toBe('Invalid input')
    })
  })

  describe('handleError', () => {
    it('should handle Error objects with statusCode', async () => {
      const err = new Error('Custom error')
      ;(err as any).statusCode = 403
      
      const response = handleError(err, 'test')
      const body = await response.json()
      
      expect(response.status).toBe(403)
      expect(body.error.message).toBe('Custom error')
    })

    it('should default to 500 status for generic errors', async () => {
      const err = new Error('Unknown error')
      
      const response = handleError(err, 'test')
      
      expect(response.status).toBe(500)
    })

    it('should handle non-Error objects', async () => {
      const response = handleError('string error', 'test')
      const body = await response.json()
      
      expect(response.status).toBe(500)
      expect(body.error.message).toBe('服务器错误，请稍后重试')
    })
  })
})
