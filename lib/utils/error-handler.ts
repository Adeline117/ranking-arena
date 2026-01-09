/**
 * 统一错误处理工具
 */

export class AppError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function handleError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error
  }

  if (error instanceof Error) {
    return new AppError(error.message, 'UNKNOWN_ERROR', 500, error)
  }

  return new AppError('An unknown error occurred', 'UNKNOWN_ERROR', 500, error)
}

export function logError(error: unknown, context?: string): void {
  const appError = handleError(error)
  const prefix = context ? `[${context}]` : '[Error]'
  
  console.error(`${prefix} ${appError.message}`, {
    code: appError.code,
    statusCode: appError.statusCode,
    details: appError.details,
  })
}

