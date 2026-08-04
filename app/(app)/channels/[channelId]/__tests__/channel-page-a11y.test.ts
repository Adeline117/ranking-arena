import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNEL_CONTEXT_MENU_ESTIMATED_HEIGHT,
  CHANNEL_CONTEXT_MENU_GAP,
  CHANNEL_CONTEXT_MENU_WIDTH,
  getChannelContextMenuPlacement,
} from '../channel-context-menu-position'

const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

describe('channel page interaction accessibility', () => {
  it.each([
    { width: 320, height: 600, x: 312, y: 592 },
    { width: 375, height: 650, x: 367, y: 642 },
    { width: 1440, height: 800, x: 1432, y: 792 },
  ])('keeps a pointer-opened menu inside a $width px viewport', ({ width, height, x, y }) => {
    const placement = getChannelContextMenuPlacement({ x, y }, { width, height })
    const left = placement.left as number
    const top = placement.top as number
    const renderedWidth = Math.min(CHANNEL_CONTEXT_MENU_WIDTH, width - CHANNEL_CONTEXT_MENU_GAP * 2)
    const renderedHeight = Math.min(
      CHANNEL_CONTEXT_MENU_ESTIMATED_HEIGHT,
      height - CHANNEL_CONTEXT_MENU_GAP * 2
    )

    expect(left).toBeGreaterThanOrEqual(CHANNEL_CONTEXT_MENU_GAP)
    expect(top).toBeGreaterThanOrEqual(CHANNEL_CONTEXT_MENU_GAP)
    expect(left + renderedWidth).toBeLessThanOrEqual(width - CHANNEL_CONTEXT_MENU_GAP)
    expect(top + renderedHeight).toBeLessThanOrEqual(height - CHANNEL_CONTEXT_MENU_GAP)
    expect(placement.transform).toBe('none')
  })

  it('centers the long-press menu when no pointer coordinates are available', () => {
    expect(getChannelContextMenuPlacement({ x: 0, y: 0 }, { width: 320, height: 600 })).toEqual({
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    })
  })

  it('uses localized names and the shared touch target for composer actions', () => {
    expect(page).not.toContain('aria-label="Cancel reply"')
    expect(page).not.toContain('aria-label="Send message"')
    expect(page).not.toContain('aria-label="Reply"')
    expect(page).not.toContain('aria-label={`React ${')
    expect(page).toContain("aria-label={`${t('cancel')}: ${t('reply')}`}")
    expect(page).toContain("aria-label={`${t('remove')}: ${pendingAttachment.originalName}`}")
    expect(page).toContain("aria-label={`${t('upload')}: ${t('file')}`}")
    expect(page).toContain("aria-label={t('send')}")
    expect(page).toContain("aria-label={t('reply')}")

    const touchTargetWidths = page.match(/width: tokens\.touchTarget\.min/g) ?? []
    const touchTargetHeights = page.match(/height: tokens\.touchTarget\.min/g) ?? []
    expect(touchTargetWidths.length).toBeGreaterThanOrEqual(5)
    expect(touchTargetHeights.length).toBeGreaterThanOrEqual(5)
  })
})
