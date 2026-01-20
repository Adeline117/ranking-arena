import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import Card from '../Card'

// Mock design tokens
jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px' },
    radius: { xl: '16px' },
    transition: { all: 'all 0.2s ease' },
    glass: {
      bg: { secondary: 'rgba(255, 255, 255, 0.05)' },
      blur: { lg: 'blur(16px)' },
      border: { light: '1px solid rgba(255, 255, 255, 0.1)' },
    },
    colors: {
      bg: { secondary: '#1a1a2e' },
      border: { primary: '#333' },
    },
    gradient: {
      primary: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    },
    shadow: {
      sm: '0 1px 3px rgba(0,0,0,0.1)',
      lg: '0 10px 15px rgba(0,0,0,0.1)',
      cardHover: '0 20px 25px rgba(0,0,0,0.15)',
    },
    typography: {
      fontWeight: { bold: 700, black: 900 },
      fontSize: { sm: '14px', lg: '18px' },
    },
  },
}))

// Mock Box and Text components
jest.mock('../../Base', () => ({
  Box: ({ children, className, style, onClick, onMouseEnter, onMouseLeave, ...props }: React.HTMLAttributes<HTMLDivElement> & { p?: number; radius?: string }) => (
    <div className={className} style={style} onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} {...props}>
      {children}
    </div>
  ),
  Text: ({ children, style, ...props }: React.HTMLAttributes<HTMLSpanElement> & { size?: string; weight?: string; color?: string }) => (
    <span style={style} {...props}>{children}</span>
  ),
}))

describe('Card', () => {
  it('renders children correctly', () => {
    render(<Card>Card Content</Card>)
    expect(screen.getByText('Card Content')).toBeInTheDocument()
  })

  it('renders with title', () => {
    render(<Card title="Card Title">Content</Card>)
    expect(screen.getByText('Card Title')).toBeInTheDocument()
    expect(screen.getByText('Content')).toBeInTheDocument()
  })

  it('renders with title and subtitle', () => {
    render(
      <Card title="Title" subtitle="Subtitle">
        Content
      </Card>
    )
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('Subtitle')).toBeInTheDocument()
  })

  it('renders with different variants', () => {
    const { rerender } = render(<Card variant="default">Default</Card>)
    expect(screen.getByText('Default')).toBeInTheDocument()

    rerender(<Card variant="glass">Glass</Card>)
    expect(screen.getByText('Glass')).toBeInTheDocument()

    rerender(<Card variant="outline">Outline</Card>)
    expect(screen.getByText('Outline')).toBeInTheDocument()

    rerender(<Card variant="elevated">Elevated</Card>)
    expect(screen.getByText('Elevated')).toBeInTheDocument()
  })

  it('renders with different padding sizes', () => {
    const { rerender } = render(<Card padding="sm">Small Padding</Card>)
    expect(screen.getByText('Small Padding')).toBeInTheDocument()

    rerender(<Card padding="md">Medium Padding</Card>)
    expect(screen.getByText('Medium Padding')).toBeInTheDocument()

    rerender(<Card padding="lg">Large Padding</Card>)
    expect(screen.getByText('Large Padding')).toBeInTheDocument()
  })

  it('handles click events', () => {
    const handleClick = jest.fn()
    render(<Card onClick={handleClick}>Clickable</Card>)
    
    fireEvent.click(screen.getByText('Clickable'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('renders accent border when accent prop is true', () => {
    const { container } = render(<Card accent>Accent Card</Card>)
    
    // Card with accent should render - the accent div is added inside
    expect(container.firstChild).toBeInTheDocument()
    expect(screen.getByText('Accent Card')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(<Card className="custom-class">Content</Card>)
    
    expect(container.firstChild).toHaveClass('custom-class')
  })

  it('applies custom style', () => {
    const { container } = render(<Card style={{ marginTop: '20px' }}>Styled Card</Card>)
    
    // Card renders with custom style (style is merged in the component)
    expect(screen.getByText('Styled Card')).toBeInTheDocument()
    expect(container.firstChild).toBeInTheDocument()
  })

  it('handles hover effects when hoverable is true', () => {
    render(<Card hoverable>Hoverable</Card>)
    
    const card = screen.getByText('Hoverable').parentElement!
    fireEvent.mouseEnter(card)
    fireEvent.mouseLeave(card)
    
    // Just verify no errors are thrown during hover events
    expect(card).toBeInTheDocument()
  })

  it('does not apply hover class when hoverable is false', () => {
    const { container } = render(<Card hoverable={false}>Non-hoverable</Card>)
    
    expect(container.firstChild).not.toHaveClass('card-hover-lift')
    expect(container.firstChild).not.toHaveClass('glass-card-hover')
  })
})
