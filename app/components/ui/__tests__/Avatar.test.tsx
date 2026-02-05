import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import Avatar, { SimpleAvatar } from '../Avatar'

// Mock design tokens
jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    radius: { full: '9999px' },
    transition: { base: 'all 0.15s ease' },
    shadow: { sm: '0 1px 3px rgba(0,0,0,0.1)' },
    colors: {
      bg: { secondary: '#1a1a2e' },
      text: { primary: '#fff', secondary: '#ccc', tertiary: '#999' },
    },
    typography: {
      fontWeight: { black: 900, bold: 700, semibold: 600, medium: 500, regular: 400 },
      fontSize: { sm: '14px', md: '16px', lg: '18px', xl: '20px', '2xl': '24px' },
      lineHeight: { tight: 1.2, normal: 1.5, relaxed: 1.7 },
    },
  },
}))

// Mock avatar utils
jest.mock('@/lib/utils/avatar', () => ({
  getAvatarGradient: (userId: string) => `linear-gradient(135deg, #${userId?.slice(0, 6) || '667eea'} 0%, #764ba2 100%)`,
  getAvatarInitial: (name: string) => name?.charAt(0)?.toUpperCase() || '?',
  getUserAvatarUrl: (userId: string, _avatarUrl: string | null, name?: string) =>
    `https://api.dicebear.com/7.x/identicon/svg?seed=${userId || name}`,
  getTraderAvatarUrl: (avatarUrl: string | null) => avatarUrl?.trim() || null,
}))

// Mock Box and Text components
jest.mock('../../base', () => ({
  Box: ({ children, className, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={className} style={style} data-testid="avatar-box" {...props}>
      {children}
    </div>
  ),
  Text: ({ children, style, ...props }: React.HTMLAttributes<HTMLSpanElement> & { size?: string; weight?: string }) => (
    <span style={style} {...props}>{children}</span>
  ),
}))

describe('Avatar', () => {
  it('renders with initial when no avatarUrl is provided', () => {
    render(<Avatar userId="user123" name="John Doe" />)
    
    expect(screen.getByText('J')).toBeInTheDocument()
  })

  it('renders image when avatarUrl is provided', () => {
    const { container } = render(
      <Avatar 
        userId="user123" 
        name="John Doe" 
        avatarUrl="https://example.com/avatar.jpg" 
      />
    )
    
    // Image is rendered but hidden during loading
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg')
  })

  it('shows initial when image fails to load', () => {
    const { container } = render(
      <Avatar 
        userId="user123" 
        name="Jane Doe" 
        avatarUrl="https://example.com/invalid.jpg" 
      />
    )
    
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    fireEvent.error(img!)
    
    expect(screen.getByText('J')).toBeInTheDocument()
  })

  it('renders with custom size', () => {
    const { container } = render(<Avatar userId="user123" name="Test" size={60} />)
    
    // Get the outermost avatar box (first child of container)
    const box = container.firstChild as HTMLElement
    expect(box.style.width).toBe('60px')
    expect(box.style.height).toBe('60px')
  })

  it('renders initial for trader without avatarUrl', () => {
    render(<Avatar userId="trader123" name="Trader Name" isTrader avatarUrl={null} />)
    
    expect(screen.getByText('T')).toBeInTheDocument()
  })

  it('renders image for trader with avatarUrl', () => {
    const { container } = render(
      <Avatar 
        userId="trader123" 
        name="Trader Name" 
        isTrader 
        avatarUrl="https://example.com/trader.jpg" 
      />
    )
    
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'https://example.com/trader.jpg')
  })

  it('shows loading state while image loads', () => {
    render(
      <Avatar 
        userId="user123" 
        name="Loading Test" 
        avatarUrl="https://example.com/slow.jpg" 
      />
    )
    
    // Initial should be visible as loading placeholder
    expect(screen.getByText('L')).toBeInTheDocument()
  })

  it('hides loading state after image loads', () => {
    const { container } = render(
      <Avatar 
        userId="user123" 
        name="Loaded Test" 
        avatarUrl="https://example.com/avatar.jpg" 
      />
    )
    
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    fireEvent.load(img!)
    
    // After load, image should be visible
    expect(img!.style.display).not.toBe('none')
  })

  it('applies custom className', () => {
    const { container } = render(<Avatar userId="user123" name="Test" className="custom-avatar" />)
    
    const box = container.firstChild as HTMLElement
    expect(box).toHaveClass('custom-avatar')
  })

  it('applies custom style', () => {
    const { container } = render(<Avatar userId="user123" name="Test" style={{ border: '2px solid red' }} />)
    
    const box = container.firstChild as HTMLElement
    expect(box.style.border).toBe('2px solid red')
  })

  it('uses userId for initial when name is not provided', () => {
    render(<Avatar userId="abc123" />)
    
    expect(screen.getByText('A')).toBeInTheDocument()
  })
})

describe('SimpleAvatar', () => {
  it('renders initial without image', () => {
    const { container } = render(<SimpleAvatar userId="user123" name="Simple User" />)
    
    expect(screen.getByText('S')).toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('renders with custom size', () => {
    const { container } = render(<SimpleAvatar userId="user123" name="Test" size={48} />)
    
    const box = container.firstChild as HTMLElement
    expect(box.style.width).toBe('48px')
    expect(box.style.height).toBe('48px')
  })

  it('applies custom className', () => {
    const { container } = render(<SimpleAvatar userId="user123" name="Test" className="simple-class" />)
    
    const box = container.firstChild as HTMLElement
    expect(box).toHaveClass('simple-class')
  })

  it('uses userId for initial when name is not provided', () => {
    render(<SimpleAvatar userId="xyz789" />)
    
    expect(screen.getByText('X')).toBeInTheDocument()
  })
})
