import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import Button from '../Button'

// Mock design tokens
jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px' },
    touchTarget: { min: 44, comfortable: 48, large: 56 },
    radius: { lg: '8px' },
    typography: {
      fontWeight: { bold: 700 },
      fontSize: { sm: '14px', base: '16px', md: '18px' },
      fontFamily: { sans: ['Inter', 'sans-serif'] },
    },
    transition: { all: 'all 0.2s ease' },
    gradient: {
      primary: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      primaryHover: 'linear-gradient(135deg, #5a6fd6 0%, #6a4294 100%)',
      success: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
      error: 'linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%)',
    },
    glass: {
      bg: { light: 'rgba(255, 255, 255, 0.1)' },
      blur: { sm: 'blur(4px)' },
      border: { light: '1px solid rgba(255, 255, 255, 0.1)' },
    },
    colors: {
      text: { primary: '#ffffff' },
      border: { primary: '#333' },
      accent: { primary: '#667eea', success: '#11998e', error: '#ff416c' },
    },
    shadow: {
      xs: '0 1px 2px rgba(0,0,0,0.05)',
      sm: '0 1px 3px rgba(0,0,0,0.1)',
      md: '0 4px 6px rgba(0,0,0,0.1)',
      glow: '0 0 20px rgba(102, 126, 234, 0.4)',
      glowSuccess: '0 0 20px rgba(17, 153, 142, 0.4)',
      glowError: '0 0 20px rgba(255, 65, 108, 0.4)',
    },
  },
}))

describe('Button', () => {
  it('renders children correctly', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toBeInTheDocument()
  })

  it('renders with different variants', () => {
    const { rerender } = render(<Button variant="primary">Primary</Button>)
    expect(screen.getByRole('button')).toBeInTheDocument()

    rerender(<Button variant="secondary">Secondary</Button>)
    expect(screen.getByText('Secondary')).toBeInTheDocument()

    rerender(<Button variant="ghost">Ghost</Button>)
    expect(screen.getByText('Ghost')).toBeInTheDocument()

    rerender(<Button variant="danger">Danger</Button>)
    expect(screen.getByText('Danger')).toBeInTheDocument()

    rerender(<Button variant="success">Success</Button>)
    expect(screen.getByText('Success')).toBeInTheDocument()
  })

  it('renders with different sizes', () => {
    const { rerender } = render(<Button size="sm">Small</Button>)
    expect(screen.getByText('Small')).toBeInTheDocument()

    rerender(<Button size="md">Medium</Button>)
    expect(screen.getByText('Medium')).toBeInTheDocument()

    rerender(<Button size="lg">Large</Button>)
    expect(screen.getByText('Large')).toBeInTheDocument()
  })

  it('handles click events', () => {
    const handleClick = jest.fn()
    render(<Button onClick={handleClick}>Click me</Button>)
    
    fireEvent.click(screen.getByRole('button'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('does not trigger click when disabled', () => {
    const handleClick = jest.fn()
    render(<Button onClick={handleClick} disabled>Disabled</Button>)
    
    fireEvent.click(screen.getByRole('button'))
    expect(handleClick).not.toHaveBeenCalled()
  })

  it('shows loading state', () => {
    render(<Button loading>Loading</Button>)
    
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
  })

  it('renders with icon', () => {
    const icon = <span data-testid="test-icon">S</span>
    render(<Button icon={icon}>With Icon</Button>)
    
    expect(screen.getByTestId('test-icon')).toBeInTheDocument()
    expect(screen.getByText('With Icon')).toBeInTheDocument()
  })

  it('renders icon on the right when iconPosition is right', () => {
    const icon = <span data-testid="test-icon">S</span>
    render(<Button icon={icon} iconPosition="right">Icon Right</Button>)
    
    expect(screen.getByTestId('test-icon')).toBeInTheDocument()
  })

  it('renders full width when fullWidth prop is true', () => {
    render(<Button fullWidth>Full Width</Button>)
    
    const button = screen.getByRole('button')
    expect(button.style.width).toBe('100%')
  })

  it('has correct aria-label', () => {
    render(<Button aria-label="Custom Label">Text</Button>)
    
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Custom Label')
  })

  it('uses text content as aria-label when not provided', () => {
    render(<Button>Button Text</Button>)
    
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Button Text')
  })

  it('supports keyboard navigation', () => {
    const handleClick = jest.fn()
    render(<Button onClick={handleClick}>Keyboard</Button>)
    
    const button = screen.getByRole('button')
    fireEvent.keyDown(button, { key: 'Enter' })
    
    expect(handleClick).toHaveBeenCalled()
  })

  it('has tabIndex of -1 when disabled', () => {
    render(<Button disabled>Disabled</Button>)
    
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1')
  })

  it('has tabIndex of 0 when enabled', () => {
    render(<Button>Enabled</Button>)
    
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0')
  })
})
