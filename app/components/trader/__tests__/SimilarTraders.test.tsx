import React from 'react'
import { render } from '@testing-library/react'
import SimilarTraders from '../SimilarTraders'

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, unoptimized }: { src: string; alt: string; unoptimized?: boolean }) => (
    <img src={src} alt={alt} data-unoptimized={String(Boolean(unoptimized))} />
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('SimilarTraders avatars', () => {
  it('bypasses the Next image optimizer for DiceBear SVG avatars', () => {
    const { container } = render(
      <SimilarTraders
        traders={[
          {
            id: '0x95465e180697879cdd127b210c4830a16e3f96e4',
            handle: 'GMX trader',
            source: 'gmx',
            avatar_url:
              'https://api.dicebear.com/7.x/identicon/svg?seed=gmx_0x95465e180697879cdd127b210c4830a16e3f96e4',
          },
        ]}
      />
    )

    expect(container.querySelector('img[data-unoptimized]')).toHaveAttribute(
      'data-unoptimized',
      'true'
    )
  })

  it('keeps bitmap avatars on the optimizer path', () => {
    const { container } = render(
      <SimilarTraders
        traders={[
          {
            id: 'bitmap-trader',
            handle: 'Bitmap trader',
            source: 'gmx',
            avatar_url: 'https://i.pravatar.cc/80?u=bitmap-trader',
          },
        ]}
      />
    )

    expect(container.querySelector('img[data-unoptimized]')).toHaveAttribute(
      'data-unoptimized',
      'false'
    )
  })
})
