'use client'

import { ReactNode } from 'react'

interface MasonryGridProps {
  columns?: { mobile: number; desktop: number }
  gap?: string
  children: ReactNode
}

export default function MasonryGrid({
  columns = { mobile: 2, desktop: 3 },
  gap = '16px',
  children,
}: MasonryGridProps) {
  return (
    <>
      <div className="masonry-grid">
        {children}
      </div>
      <style jsx>{`
        .masonry-grid {
          column-count: ${columns.mobile};
          column-gap: ${gap};
        }
        @media (min-width: 768px) {
          .masonry-grid {
            column-count: ${columns.desktop};
          }
        }
        .masonry-grid > :global(*) {
          break-inside: avoid;
          margin-bottom: ${gap};
        }
      `}</style>
    </>
  )
}
