/**
 * Worker 专用日志模块
 * 简化版，不依赖 Sentry（在独立 worker 中运行）
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface LogContext {
    [key: string]: unknown;
}
export declare const logger: {
    debug: (message: string, context?: LogContext) => void;
    info: (message: string, context?: LogContext) => void;
    warn: (message: string, context?: LogContext) => void;
    error: (message: string, error: Error, context?: LogContext) => void;
    withContext: (baseContext: LogContext) => {
        debug: (message: string, context?: LogContext) => void;
        info: (message: string, context?: LogContext) => void;
        warn: (message: string, context?: LogContext) => void;
        error: (message: string, error: Error, context?: LogContext) => void;
    };
};
/**
 * 带重试机制的异步函数执行器
 */
export declare function withRetry<T>(fn: () => Promise<T>, options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    context?: string;
    onRetry?: (attempt: number, error: Error) => void;
}): Promise<T>;
export declare function sleep(ms: number): Promise<void>;
export default logger;
//# sourceMappingURL=logger.d.ts.map