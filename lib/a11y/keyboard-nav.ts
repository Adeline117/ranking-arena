/**
 * 键盘导航工具
 * 提供键盘快捷键管理和导航增强
 */

// ============================================
// 类型定义
// ============================================

export interface KeyboardShortcut {
  /** 快捷键组合 */
  key: string
  /** 修饰键 */
  modifiers?: ('ctrl' | 'alt' | 'shift' | 'meta')[]
  /** 回调函数 */
  handler: (e: KeyboardEvent) => void
  /** 描述（用于显示快捷键提示） */
  description?: string
  /** 是否阻止默认行为 */
  preventDefault?: boolean
  /** 是否仅在特定元素聚焦时触发 */
  when?: () => boolean
}

export interface RovingFocusOptions {
  /** 导航方向 */
  orientation?: 'horizontal' | 'vertical' | 'both'
  /** 是否循环 */
  loop?: boolean
  /** 是否允许 Home/End 键 */
  allowHomeEnd?: boolean
}

// ============================================
// 键盘快捷键管理器
// ============================================

class KeyboardShortcutManager {
  private shortcuts: Map<string, KeyboardShortcut> = new Map()
  private enabled = true

  constructor() {
    if (typeof window !== 'undefined') {
      this.init()
    }
  }

  private init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this))
  }

  /**
   * 注册快捷键
   */
  register(id: string, shortcut: KeyboardShortcut): () => void {
    this.shortcuts.set(id, shortcut)
    return () => this.unregister(id)
  }

  /**
   * 取消注册快捷键
   */
  unregister(id: string): void {
    this.shortcuts.delete(id)
  }

  /**
   * 启用/禁用所有快捷键
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * 获取所有注册的快捷键
   */
  getShortcuts(): Map<string, KeyboardShortcut> {
    return new Map(this.shortcuts)
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (!this.enabled) return

    // 忽略输入框中的快捷键（除非有特定处理）
    const target = e.target as HTMLElement
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      // 只响应特定的全局快捷键
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        return
      }
    }

    for (const [, shortcut] of this.shortcuts) {
      if (this.matchesShortcut(e, shortcut)) {
        // 检查条件
        if (shortcut.when && !shortcut.when()) {
          continue
        }

        if (shortcut.preventDefault !== false) {
          e.preventDefault()
        }

        shortcut.handler(e)
        break
      }
    }
  }

  private matchesShortcut(e: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
    const key = shortcut.key.toLowerCase()
    const eventKey = e.key.toLowerCase()

    if (eventKey !== key) return false

    const modifiers = shortcut.modifiers || []
    const ctrlRequired = modifiers.includes('ctrl')
    const altRequired = modifiers.includes('alt')
    const shiftRequired = modifiers.includes('shift')
    const metaRequired = modifiers.includes('meta')

    return (
      e.ctrlKey === ctrlRequired &&
      e.altKey === altRequired &&
      e.shiftKey === shiftRequired &&
      e.metaKey === metaRequired
    )
  }
}

// 全局实例
export const keyboardManager = new KeyboardShortcutManager()

// ============================================
// Roving Focus（漫游焦点）
// ============================================

/**
 * 创建漫游焦点管理器
 * 用于工具栏、菜单、选项卡等组件的键盘导航
 */
export function createRovingFocus(
  container: HTMLElement,
  itemSelector: string,
  options: RovingFocusOptions = {}
) {
  const {
    orientation = 'horizontal',
    loop = true,
    allowHomeEnd = true,
  } = options

  const getItems = () =>
    Array.from(container.querySelectorAll<HTMLElement>(itemSelector))

  const getCurrentIndex = () => {
    const items = getItems()
    const active = document.activeElement as HTMLElement
    return items.indexOf(active)
  }

  const focusItem = (index: number) => {
    const items = getItems()
    if (items.length === 0) return

    // 处理循环或边界
    let targetIndex = index
    if (loop) {
      targetIndex = ((index % items.length) + items.length) % items.length
    } else {
      targetIndex = Math.max(0, Math.min(index, items.length - 1))
    }

    const item = items[targetIndex]
    item?.focus()

    // 更新 tabindex
    items.forEach((el, i) => {
      el.tabIndex = i === targetIndex ? 0 : -1
    })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const currentIndex = getCurrentIndex()
    if (currentIndex === -1) return

    const items = getItems()
    let handled = false

    switch (e.key) {
      case 'ArrowLeft':
        if (orientation === 'horizontal' || orientation === 'both') {
          focusItem(currentIndex - 1)
          handled = true
        }
        break
      case 'ArrowRight':
        if (orientation === 'horizontal' || orientation === 'both') {
          focusItem(currentIndex + 1)
          handled = true
        }
        break
      case 'ArrowUp':
        if (orientation === 'vertical' || orientation === 'both') {
          focusItem(currentIndex - 1)
          handled = true
        }
        break
      case 'ArrowDown':
        if (orientation === 'vertical' || orientation === 'both') {
          focusItem(currentIndex + 1)
          handled = true
        }
        break
      case 'Home':
        if (allowHomeEnd) {
          focusItem(0)
          handled = true
        }
        break
      case 'End':
        if (allowHomeEnd) {
          focusItem(items.length - 1)
          handled = true
        }
        break
    }

    if (handled) {
      e.preventDefault()
    }
  }

  // 初始化 tabindex
  const items = getItems()
  items.forEach((el, i) => {
    el.tabIndex = i === 0 ? 0 : -1
  })

  container.addEventListener('keydown', handleKeyDown)

  return {
    focusFirst: () => focusItem(0),
    focusLast: () => focusItem(getItems().length - 1),
    focusNext: () => focusItem(getCurrentIndex() + 1),
    focusPrevious: () => focusItem(getCurrentIndex() - 1),
    destroy: () => container.removeEventListener('keydown', handleKeyDown),
  }
}

// ============================================
// 表格键盘导航
// ============================================

/**
 * 为表格添加键盘导航支持
 */
export function createTableNavigation(table: HTMLTableElement) {
  const getCell = (row: number, col: number): HTMLElement | null => {
    const rows = table.querySelectorAll('tbody tr')
    const targetRow = rows[row]
    if (!targetRow) return null
    const cells = targetRow.querySelectorAll<HTMLElement>('td, th')
    return cells[col] || null
  }

  const getCurrentPosition = (): { row: number; col: number } | null => {
    const active = document.activeElement as HTMLElement
    const cell = active.closest<HTMLElement>('td, th')
    if (!cell) return null

    const row = cell.closest('tr')
    if (!row) return null

    const rows = Array.from(table.querySelectorAll('tbody tr'))
    const rowIndex = rows.indexOf(row as HTMLTableRowElement)
    const cells = Array.from(row.querySelectorAll('td, th'))
    const colIndex = cells.indexOf(cell as HTMLTableCellElement)

    return { row: rowIndex, col: colIndex }
  }

  const focusCell = (row: number, col: number) => {
    const cell = getCell(row, col)
    if (cell) {
      // 尝试聚焦单元格内的可交互元素
      const focusable = cell.querySelector<HTMLElement>(
        'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable) {
        focusable.focus()
      } else {
        cell.tabIndex = 0
        cell.focus()
      }
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const pos = getCurrentPosition()
    if (!pos) return

    const rows = table.querySelectorAll('tbody tr')
    const maxRow = rows.length - 1
    const currentRow = rows[pos.row]
    const maxCol = currentRow ? currentRow.querySelectorAll('td, th').length - 1 : 0

    let handled = false

    switch (e.key) {
      case 'ArrowUp':
        if (pos.row > 0) {
          focusCell(pos.row - 1, pos.col)
          handled = true
        }
        break
      case 'ArrowDown':
        if (pos.row < maxRow) {
          focusCell(pos.row + 1, pos.col)
          handled = true
        }
        break
      case 'ArrowLeft':
        if (pos.col > 0) {
          focusCell(pos.row, pos.col - 1)
          handled = true
        }
        break
      case 'ArrowRight':
        if (pos.col < maxCol) {
          focusCell(pos.row, pos.col + 1)
          handled = true
        }
        break
      case 'Home':
        if (e.ctrlKey) {
          focusCell(0, 0)
        } else {
          focusCell(pos.row, 0)
        }
        handled = true
        break
      case 'End':
        if (e.ctrlKey) {
          focusCell(maxRow, maxCol)
        } else {
          focusCell(pos.row, maxCol)
        }
        handled = true
        break
      case 'PageUp':
        focusCell(Math.max(0, pos.row - 10), pos.col)
        handled = true
        break
      case 'PageDown':
        focusCell(Math.min(maxRow, pos.row + 10), pos.col)
        handled = true
        break
    }

    if (handled) {
      e.preventDefault()
    }
  }

  table.addEventListener('keydown', handleKeyDown)

  return {
    focusCell,
    destroy: () => table.removeEventListener('keydown', handleKeyDown),
  }
}

// ============================================
// 快捷键描述格式化
// ============================================

/**
 * 格式化快捷键显示文本
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = []
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

  if (shortcut.modifiers) {
    if (shortcut.modifiers.includes('ctrl')) {
      parts.push(isMac ? '⌃' : 'Ctrl')
    }
    if (shortcut.modifiers.includes('alt')) {
      parts.push(isMac ? '⌥' : 'Alt')
    }
    if (shortcut.modifiers.includes('shift')) {
      parts.push(isMac ? '⇧' : 'Shift')
    }
    if (shortcut.modifiers.includes('meta')) {
      parts.push(isMac ? '⌘' : 'Win')
    }
  }

  // 格式化按键名称
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    'arrowup': '↑',
    'arrowdown': '↓',
    'arrowleft': '←',
    'arrowright': '→',
    'enter': '↵',
    'escape': 'Esc',
    'backspace': '⌫',
    'delete': 'Del',
    'tab': '⇥',
  }

  const displayKey = keyMap[shortcut.key.toLowerCase()] || shortcut.key.toUpperCase()
  parts.push(displayKey)

  return parts.join(isMac ? '' : '+')
}

// ============================================
// 预定义快捷键
// ============================================

export const CommonShortcuts = {
  /** 搜索 */
  SEARCH: { key: '/', description: '搜索' },
  /** 关闭模态框 */
  CLOSE: { key: 'Escape', description: '关闭' },
  /** 保存 */
  SAVE: { key: 's', modifiers: ['ctrl'] as const, description: '保存' },
  /** 全选 */
  SELECT_ALL: { key: 'a', modifiers: ['ctrl'] as const, description: '全选' },
  /** 帮助 */
  HELP: { key: '?', modifiers: ['shift'] as const, description: '显示帮助' },
  /** 首页 */
  GO_HOME: { key: 'h', modifiers: ['alt'] as const, description: '返回首页' },
}

// Types are exported at definition
