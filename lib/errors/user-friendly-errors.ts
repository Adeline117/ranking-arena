/**
 * User-Friendly Error Mapping
 * 
 * 将技术错误翻译为用户友好的消息
 * 支持中英双语
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface UserFriendlyError {
  code: string
  titleEn: string
  titleZh: string
  messageEn: string
  messageZh: string
  actionEn?: string
  actionZh?: string
  retryAfterMs?: number
  severity: ErrorSeverity
  icon?: string
}

/**
 * 错误代码映射表
 */
export const ERROR_MAP: Record<string, UserFriendlyError> = {
  // ===== 数据库错误 =====
  'PGRST301': {
    code: 'DB_CONNECTION',
    titleEn: 'High Traffic',
    titleZh: '高并发维护中',
    messageEn: 'Our systems are experiencing high demand. Please try again shortly.',
    messageZh: '系统正处于高并发维护，请 30 秒后重试。',
    actionEn: 'Retry',
    actionZh: '重试',
    retryAfterMs: 30000,
    severity: 'warning',
    icon: '',
  },
  'CONNECTION_REFUSED': {
    code: 'DB_CONNECTION',
    titleEn: 'High Traffic',
    titleZh: '高并发维护中',
    messageEn: 'Our systems are experiencing high demand. Please try again shortly.',
    messageZh: '系统正处于高并发维护，请 30 秒后重试。',
    retryAfterMs: 30000,
    severity: 'warning',
    icon: '',
  },
  'ECONNREFUSED': {
    code: 'DB_CONNECTION',
    titleEn: 'High Traffic',
    titleZh: '高并发维护中',
    messageEn: 'Our systems are experiencing high demand. Please try again shortly.',
    messageZh: '系统正处于高并发维护，请 30 秒后重试。',
    retryAfterMs: 30000,
    severity: 'warning',
    icon: '',
  },

  // ===== 交易所 API 错误 =====
  'EXCHANGE_502': {
    code: 'EXCHANGE_MAINTENANCE',
    titleEn: 'Exchange Maintenance',
    titleZh: '交易所维护中',
    messageEn: 'The exchange is temporarily under maintenance. Rankings will update shortly.',
    messageZh: '交易所正在进行临时维护，排行榜数据将在维护结束后更新。',
    actionEn: 'View Cached Data',
    actionZh: '查看缓存数据',
    retryAfterMs: 60000,
    severity: 'info',
    icon: '',
  },
  'EXCHANGE_503': {
    code: 'EXCHANGE_OVERLOADED',
    titleEn: 'Exchange Busy',
    titleZh: '交易所繁忙',
    messageEn: 'The exchange is experiencing high traffic. Data may be slightly delayed.',
    messageZh: '交易所当前访问量较大，数据可能略有延迟。',
    retryAfterMs: 30000,
    severity: 'info',
    icon: '',
  },
  'EXCHANGE_429': {
    code: 'RATE_LIMITED',
    titleEn: 'Rate Limited',
    titleZh: '请求过于频繁',
    messageEn: 'Too many requests. Please wait a moment before refreshing.',
    messageZh: '请求过于频繁，请稍后再刷新。',
    retryAfterMs: 60000,
    severity: 'warning',
    icon: '',
  },
  'EXCHANGE_TIMEOUT': {
    code: 'EXCHANGE_TIMEOUT',
    titleEn: 'Slow Response',
    titleZh: '响应缓慢',
    messageEn: 'The exchange is responding slowly. Showing cached rankings.',
    messageZh: '交易所响应缓慢，当前显示缓存排行榜数据。',
    severity: 'info',
    icon: '',
  },

  // ===== 认证错误 =====
  'AUTH_EXPIRED': {
    code: 'AUTH_EXPIRED',
    titleEn: 'Session Expired',
    titleZh: '会话已过期',
    messageEn: 'Your session has expired. Please sign in again.',
    messageZh: '您的登录已过期，请重新登录。',
    actionEn: 'Sign In',
    actionZh: '登录',
    severity: 'warning',
    icon: '',
  },
  'AUTH_INVALID': {
    code: 'AUTH_INVALID',
    titleEn: 'Authentication Failed',
    titleZh: '认证失败',
    messageEn: 'Unable to verify your identity. Please sign in again.',
    messageZh: '无法验证您的身份，请重新登录。',
    actionEn: 'Sign In',
    actionZh: '登录',
    severity: 'error',
    icon: '',
  },

  // ===== 网络错误 =====
  'NETWORK_OFFLINE': {
    code: 'NETWORK_OFFLINE',
    titleEn: 'You\'re Offline',
    titleZh: '网络已断开',
    messageEn: 'Please check your internet connection and try again.',
    messageZh: '请检查您的网络连接后重试。',
    actionEn: 'Retry',
    actionZh: '重试',
    severity: 'error',
    icon: '',
  },
  'FETCH_FAILED': {
    code: 'NETWORK_ERROR',
    titleEn: 'Connection Issue',
    titleZh: '连接问题',
    messageEn: 'Unable to connect to our servers. Please try again.',
    messageZh: '无法连接到服务器，请稍后重试。',
    retryAfterMs: 5000,
    severity: 'warning',
    icon: '',
  },

  // ===== 数据错误 =====
  'DATA_NOT_FOUND': {
    code: 'DATA_NOT_FOUND',
    titleEn: 'Not Found',
    titleZh: '未找到',
    messageEn: 'The requested data could not be found.',
    messageZh: '未找到请求的数据。',
    severity: 'info',
    icon: '',
  },
  'DATA_STALE': {
    code: 'DATA_STALE',
    titleEn: 'Data May Be Outdated',
    titleZh: '数据可能过期',
    messageEn: 'This data hasn\'t been updated recently. Refresh for latest.',
    messageZh: '此数据近期未更新，刷新获取最新数据。',
    actionEn: 'Refresh',
    actionZh: '刷新',
    severity: 'info',
    icon: '',
  },

  // ===== Web3 错误 =====
  'WALLET_REJECTED': {
    code: 'WALLET_REJECTED',
    titleEn: 'Transaction Rejected',
    titleZh: '交易被拒绝',
    messageEn: 'You rejected the transaction in your wallet.',
    messageZh: '您在钱包中拒绝了此交易。',
    severity: 'info',
    icon: '',
  },
  'WALLET_NOT_CONNECTED': {
    code: 'WALLET_NOT_CONNECTED',
    titleEn: 'Wallet Not Connected',
    titleZh: '钱包未连接',
    messageEn: 'Please connect your wallet to continue.',
    messageZh: '请先连接钱包以继续操作。',
    actionEn: 'Connect Wallet',
    actionZh: '连接钱包',
    severity: 'warning',
    icon: '',
  },
  'INSUFFICIENT_FUNDS': {
    code: 'INSUFFICIENT_FUNDS',
    titleEn: 'Insufficient Balance',
    titleZh: '余额不足',
    messageEn: 'You don\'t have enough funds for this transaction.',
    messageZh: '您的余额不足以完成此交易。',
    severity: 'error',
    icon: '',
  },
  'CHAIN_MISMATCH': {
    code: 'CHAIN_MISMATCH',
    titleEn: 'Wrong Network',
    titleZh: '网络错误',
    messageEn: 'Please switch to Base network in your wallet.',
    messageZh: '请在钱包中切换到 Base 网络。',
    actionEn: 'Switch Network',
    actionZh: '切换网络',
    severity: 'warning',
    icon: '',
  },

  // ===== 防刷榜错误 =====
  'MANIPULATION_DETECTED': {
    code: 'MANIPULATION_DETECTED',
    titleEn: 'Unusual Activity',
    titleZh: '异常行为',
    messageEn: 'Unusual trading activity detected. Account under review.',
    messageZh: '检测到异常交易行为，账户正在审核中。',
    severity: 'critical',
    icon: '',
  },
  'RATE_ABUSE': {
    code: 'RATE_ABUSE',
    titleEn: 'Too Many Requests',
    titleZh: '请求过多',
    messageEn: 'You\'ve made too many requests. Please wait before trying again.',
    messageZh: '您的请求过于频繁，请稍后再试。',
    retryAfterMs: 60000,
    severity: 'warning',
    icon: '',
  },

  // ===== 通用错误 =====
  'UNKNOWN': {
    code: 'UNKNOWN',
    titleEn: 'Something Went Wrong',
    titleZh: '出错了',
    messageEn: 'An unexpected error occurred. Our team has been notified.',
    messageZh: '发生了意外错误，我们的团队已收到通知。',
    actionEn: 'Report Issue',
    actionZh: '报告问题',
    severity: 'error',
    icon: 'X',
  },
}

/**
 * 获取用户友好的错误信息
 */
export function getUserFriendlyError(
  error: unknown,
  language: 'en' | 'zh' = 'en'
): UserFriendlyError {
  // 提取错误代码
  const errorCode = extractErrorCode(error)
  
  // 查找映射
  const mapped = ERROR_MAP[errorCode] || ERROR_MAP['UNKNOWN']
  
  return mapped
}

/**
 * 从各种错误格式提取代码
 */
function extractErrorCode(error: unknown): string {
  if (!error) return 'UNKNOWN'
  
  // 字符串错误
  if (typeof error === 'string') {
    if (error.includes('Connection refused')) return 'CONNECTION_REFUSED'
    if (error.includes('ECONNREFUSED')) return 'ECONNREFUSED'
    if (error.includes('502')) return 'EXCHANGE_502'
    if (error.includes('503')) return 'EXCHANGE_503'
    if (error.includes('429')) return 'EXCHANGE_429'
    if (error.includes('timeout')) return 'EXCHANGE_TIMEOUT'
    return 'UNKNOWN'
  }
  
  // Error 对象
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('connection refused')) return 'CONNECTION_REFUSED'
    if (msg.includes('econnrefused')) return 'ECONNREFUSED'
    if (msg.includes('network')) return 'NETWORK_OFFLINE'
    if (msg.includes('fetch')) return 'FETCH_FAILED'
    if (msg.includes('rejected')) return 'WALLET_REJECTED'
    if (msg.includes('insufficient')) return 'INSUFFICIENT_FUNDS'
  }
  
  // 带 code 的对象
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    if (obj.code && typeof obj.code === 'string') {
      if (ERROR_MAP[obj.code]) return obj.code
    }
    if (obj.status === 502) return 'EXCHANGE_502'
    if (obj.status === 503) return 'EXCHANGE_503'
    if (obj.status === 429) return 'EXCHANGE_429'
  }
  
  return 'UNKNOWN'
}

/**
 * 格式化错误用于显示
 */
export function formatError(
  error: unknown,
  language: 'en' | 'zh' = 'en'
): {
  title: string
  message: string
  action?: string
  icon: string
  severity: ErrorSeverity
  retryAfterMs?: number
} {
  const friendly = getUserFriendlyError(error, language)
  
  return {
    title: language === 'zh' ? friendly.titleZh : friendly.titleEn,
    message: language === 'zh' ? friendly.messageZh : friendly.messageEn,
    action: language === 'zh' ? friendly.actionZh : friendly.actionEn,
    icon: friendly.icon || 'X',
    severity: friendly.severity,
    retryAfterMs: friendly.retryAfterMs,
  }
}

export default ERROR_MAP
