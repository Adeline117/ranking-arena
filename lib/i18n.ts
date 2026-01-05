// 国际化翻译文件
export type Language = 'zh' | 'en'

export const translations = {
  zh: {
    home: '首页',
    groups: '小组',
    hot: '热榜',
    search: '搜索',
    login: '登录',
    logout: '退出',
    follow: '关注',
    following: '关注中',
    followers: '粉丝',
    bio: '个人简介',
    performance: 'Performance',
    stats: 'Stats',
    portfolio: 'Portfolio',
    chart: 'Chart',
    traderLeaderboard: '交易者排行榜',
    loggedIn: '已登录',
    guest: '游客模式',
    roi: 'ROI',
    winRate: '胜率',
    noData: '暂无数据',
    loading: '加载中...',
    editProfile: '编辑个人资料',
    badges: '徽章',
    joinGroup: '加入小组',
    activities: '动态',
    details: '详情',
    copy: 'Copy',
    myHome: '我的主页',
    dashboard: '仪表盘',
    notifications: '通知',
    market: '市场',
  },
  en: {
    home: 'Home',
    groups: 'Groups',
    hot: 'Hot',
    search: 'Search',
    login: 'Login',
    logout: 'Logout',
    follow: 'Follow',
    following: 'Following',
    followers: 'Followers',
    bio: 'Bio',
    performance: 'Performance',
    stats: 'Stats',
    portfolio: 'Portfolio',
    chart: 'Chart',
    traderLeaderboard: 'Trader Leaderboard',
    loggedIn: 'Logged in',
    guest: 'Guest',
    roi: 'ROI',
    winRate: 'Win Rate',
    noData: 'No data',
    loading: 'Loading...',
    editProfile: 'Edit Profile',
    badges: 'Badges',
    joinGroup: 'Join Group',
    activities: 'Activities',
    details: 'Details',
    copy: 'Copy',
    myHome: 'My Home',
    dashboard: 'Dashboard',
    notifications: 'Notifications',
    market: 'Market',
  },
}

let currentLanguage: Language = 'zh'

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language | null
    if (saved) {
      currentLanguage = saved
      return saved
    }
  }
  return currentLanguage
}

export function setLanguage(lang: Language) {
  currentLanguage = lang
  if (typeof window !== 'undefined') {
    localStorage.setItem('language', lang)
    window.dispatchEvent(new CustomEvent('languageChange', { detail: lang }))
  }
}

export function t(key: keyof typeof translations.zh): string {
  const lang = getLanguage()
  return translations[lang][key] || translations.zh[key] || key
}


