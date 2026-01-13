/**
 * 格式化工具函数
 */

/**
 * 格式化数字（添加千分位分隔符）
 * @param num 数字
 * @param decimals 小数位数
 */
export function formatNumber(num: number | string, decimals = 0): string {
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (isNaN(n)) return '0'
  
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * 格式化百分比
 * @param value 小数值（如 0.1234 表示 12.34%）
 * @param decimals 小数位数
 * @param multiply 是否需要乘以100
 */
export function formatPercent(value: number | string, decimals = 2, multiply = true): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(n)) return '0%'
  
  const percent = multiply ? n * 100 : n
  const sign = percent >= 0 ? '+' : ''
  
  return `${sign}${percent.toFixed(decimals)}%`
}

/**
 * 格式化货币
 * @param amount 金额
 * @param currency 货币符号
 * @param decimals 小数位数
 */
export function formatCurrency(
  amount: number | string,
  currency: string = '$',
  decimals = 2
): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(n)) return `${currency}0`
  
  return `${currency}${formatNumber(n, decimals)}`
}

/**
 * 格式化大数字（如 1.2K, 3.4M）
 * @param num 数字
 * @param decimals 小数位数
 */
export function formatCompact(num: number | string, decimals = 1): string {
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (isNaN(n)) return '0'
  
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(decimals)}K`
  
  return `${sign}${abs.toFixed(decimals)}`
}

/**
 * 截断文本
 * @param text 文本
 * @param maxLength 最大长度
 * @param suffix 后缀
 */
export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - suffix.length) + suffix
}

/**
 * 首字母大写
 */
export function capitalize(text: string): string {
  if (!text) return ''
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}

