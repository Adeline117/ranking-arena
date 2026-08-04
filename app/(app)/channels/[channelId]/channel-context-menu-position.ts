export const CHANNEL_CONTEXT_MENU_GAP = 8
export const CHANNEL_CONTEXT_MENU_WIDTH = 240
export const CHANNEL_CONTEXT_MENU_ESTIMATED_HEIGHT = 244

type ContextMenuPoint = { x: number; y: number }
type ViewportSize = { width: number; height: number }

export type ChannelContextMenuPlacement = {
  top: number | '50%'
  left: number | '50%'
  transform: 'none' | 'translate(-50%, -50%)'
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function getChannelContextMenuPlacement(
  point: ContextMenuPoint,
  viewport: ViewportSize
): ChannelContextMenuPlacement {
  const hasPointerPosition = point.x !== 0 || point.y !== 0
  if (
    !hasPointerPosition ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return {
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    }
  }

  const availableWidth = Math.max(0, viewport.width - CHANNEL_CONTEXT_MENU_GAP * 2)
  const availableHeight = Math.max(0, viewport.height - CHANNEL_CONTEXT_MENU_GAP * 2)
  const menuWidth = Math.min(CHANNEL_CONTEXT_MENU_WIDTH, availableWidth)
  const menuHeight = Math.min(CHANNEL_CONTEXT_MENU_ESTIMATED_HEIGHT, availableHeight)
  const maximumLeft = Math.max(
    CHANNEL_CONTEXT_MENU_GAP,
    viewport.width - menuWidth - CHANNEL_CONTEXT_MENU_GAP
  )
  const maximumTop = Math.max(
    CHANNEL_CONTEXT_MENU_GAP,
    viewport.height - menuHeight - CHANNEL_CONTEXT_MENU_GAP
  )

  return {
    left: clamp(point.x, CHANNEL_CONTEXT_MENU_GAP, maximumLeft),
    top: clamp(point.y, CHANNEL_CONTEXT_MENU_GAP, maximumTop),
    transform: 'none',
  }
}
