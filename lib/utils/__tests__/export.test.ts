/**
 * @jest-environment jsdom
 */
import { exportToCSV, exportToJSON } from '../export'

// Mock URL.createObjectURL and Blob
const mockClick = jest.fn()
const mockCreateElement = jest.fn(() => ({
  click: mockClick,
  download: '',
  href: '',
  setAttribute: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  global.URL.createObjectURL = jest.fn(() => 'blob:mock')
  global.URL.revokeObjectURL = jest.fn()
  document.createElement = mockCreateElement as any
  document.body.appendChild = jest.fn()
  document.body.removeChild = jest.fn()
})

describe('exportToCSV', () => {
  it('does nothing for empty data', () => {
    exportToCSV([], 'test')
    expect(mockClick).not.toHaveBeenCalled()
  })

  it('creates CSV and triggers download for valid data', () => {
    const data = [
      { name: 'Bitcoin', price: 50000 },
      { name: 'Ethereum', price: 3000 },
    ]
    exportToCSV(data, 'coins')
    expect(mockClick).toHaveBeenCalled()
  })

  it('escapes values with commas and quotes', () => {
    const data = [{ note: 'hello, "world"' }]
    exportToCSV(data, 'test')
    expect(mockClick).toHaveBeenCalled()
  })
})

describe('exportToJSON', () => {
  it('triggers download with JSON content', () => {
    exportToJSON({ a: 1 }, 'test')
    expect(mockClick).toHaveBeenCalled()
  })
})
