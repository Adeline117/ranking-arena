import { create } from 'zustand'

interface InboxState {
  unreadNotifications: number
  unreadMessages: number
  panelOpen: boolean
  setUnreadNotifications: (count: number) => void
  setUnreadMessages: (count: number) => void
  togglePanel: () => void
  openPanel: () => void
  closePanel: () => void
  totalUnread: () => number
}

export const useInboxStore = create<InboxState>((set, get) => ({
  unreadNotifications: 0,
  unreadMessages: 0,
  panelOpen: false,
  setUnreadNotifications: (count) => set({ unreadNotifications: count }),
  setUnreadMessages: (count) => set({ unreadMessages: count }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  totalUnread: () => get().unreadNotifications + get().unreadMessages,
}))
