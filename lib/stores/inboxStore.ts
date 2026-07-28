import { create } from 'zustand'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { inboxViewerScopeKey } from '@/lib/inbox/viewer-scope'

export interface InboxState {
  ownerScopeKey: string | null
  unreadNotifications: number
  unreadMessages: number
  panelOpen: boolean
  activateViewer: (scope: ViewerScope) => boolean
  setUnreadNotifications: (scope: ViewerScope, count: number) => boolean
  setUnreadMessages: (scope: ViewerScope, count: number) => boolean
  togglePanel: (scope: ViewerScope) => boolean
  openPanel: (scope: ViewerScope) => boolean
  closePanel: (scope: ViewerScope) => boolean
}

function normalizedCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

function scopeCanWrite(state: InboxState, scope: ViewerScope): boolean {
  return state.ownerScopeKey === inboxViewerScopeKey(scope) && isViewerScopeCurrent(scope)
}

export const useInboxStore = create<InboxState>((set, get) => ({
  ownerScopeKey: null,
  unreadNotifications: 0,
  unreadMessages: 0,
  panelOpen: false,
  activateViewer: (scope) => {
    if (!isViewerScopeCurrent(scope)) return false
    const ownerScopeKey = inboxViewerScopeKey(scope)
    if (get().ownerScopeKey === ownerScopeKey) return true
    set({
      ownerScopeKey,
      panelOpen: false,
      unreadMessages: 0,
      unreadNotifications: 0,
    })
    return true
  },
  setUnreadNotifications: (scope, count) => {
    if (!scopeCanWrite(get(), scope)) return false
    set({ unreadNotifications: normalizedCount(count) })
    return true
  },
  setUnreadMessages: (scope, count) => {
    if (!scopeCanWrite(get(), scope)) return false
    set({ unreadMessages: normalizedCount(count) })
    return true
  },
  togglePanel: (scope) => {
    if (!scopeCanWrite(get(), scope) || !scope.userId) return false
    set((state) => ({ panelOpen: !state.panelOpen }))
    return true
  },
  openPanel: (scope) => {
    if (!scopeCanWrite(get(), scope) || !scope.userId) return false
    set({ panelOpen: true })
    return true
  },
  closePanel: (scope) => {
    if (!scopeCanWrite(get(), scope)) return false
    set({ panelOpen: false })
    return true
  },
}))

/** Derived selector for total unread count — stable reference, no store re-creation */
export const selectTotalUnread = (state: InboxState) =>
  state.unreadNotifications + state.unreadMessages

export function selectScopedUnreadNotifications(state: InboxState, scope: ViewerScope): number {
  return state.ownerScopeKey === inboxViewerScopeKey(scope) && isViewerScopeCurrent(scope)
    ? state.unreadNotifications
    : 0
}

export function selectScopedUnreadMessages(state: InboxState, scope: ViewerScope): number {
  return state.ownerScopeKey === inboxViewerScopeKey(scope) && isViewerScopeCurrent(scope)
    ? state.unreadMessages
    : 0
}

export function selectScopedTotalUnread(state: InboxState, scope: ViewerScope): number {
  return state.ownerScopeKey === inboxViewerScopeKey(scope) && isViewerScopeCurrent(scope)
    ? selectTotalUnread(state)
    : 0
}

export function selectScopedPanelOpen(state: InboxState, scope: ViewerScope): boolean {
  return (
    state.ownerScopeKey === inboxViewerScopeKey(scope) &&
    isViewerScopeCurrent(scope) &&
    state.panelOpen
  )
}
