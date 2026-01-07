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
    searchPlaceholder: '搜索交易者、帖子、小组...',
    rank: '排名',
    trader: '交易员',
    roi90d: 'ROI (90D)',
    winRate90d: '胜率 (90D)',
    volume90d: '交易量 (90D)',
    avgBuy90d: '平均买入 (90D)',
    noTraderData: '暂无交易者数据',
    prevPage: '上一页',
    nextPage: '下一页',
    unknownSource: '未知来源',
    upvote: '赞同',
    downvote: '反对',
    hotDiscussion: '热门讨论',
    more: '更多',
    market: '市场',
    traderComparison: '交易者对比',
    saveFailed: '保存失败，请重试',
    loadFailed: '加载失败',
    secondsAgo: '秒前',
    minutesAgo: '分钟前',
    bullish: '看多',
    bearish: '看空',
    wait: '观望',
    comment: '评论',
    customize: '自定义',
    save: '保存',
    cancel: '取消',
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
    searchPlaceholder: 'Search traders, posts, groups...',
    rank: 'Rank',
    trader: 'Trader',
    roi90d: 'ROI (90D)',
    winRate90d: 'Win Rate (90D)',
    volume90d: 'Volume (90D)',
    avgBuy90d: 'Avg Buy (90D)',
    noTraderData: 'No trader data',
    prevPage: 'Previous',
    nextPage: 'Next',
    unknownSource: 'Unknown Source',
    upvote: 'Upvote',
    downvote: 'Downvote',
    hotDiscussion: 'Hot Discussion',
    more: 'More',
    market: 'Market',
    traderComparison: 'Trader Comparison',
    saveFailed: 'Save failed, please try again',
    loadFailed: 'Load failed',
    secondsAgo: 'seconds ago',
    minutesAgo: 'minutes ago',
    bullish: 'Bullish',
    bearish: 'Bearish',
    wait: 'Wait',
    comment: 'Comment',
    customize: 'Customize',
    save: 'Save',
    cancel: 'Cancel',
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




