/**
 * Worker 专用日志模块
 * 简化版，不依赖 Sentry（在独立 worker 中运行）
 */
function formatLogEntry(entry) {
    return JSON.stringify(entry);
}
function createLogEntry(level, message, context, error) {
    const entry = {
        level,
        message,
        timestamp: new Date().toISOString(),
    };
    if (context && Object.keys(context).length > 0) {
        entry.context = context;
    }
    if (error) {
        entry.error = {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return entry;
}
export const logger = {
    debug: (message, context) => {
        if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            const entry = createLogEntry('debug', message, context);
            console.debug(formatLogEntry(entry));
        }
    },
    info: (message, context) => {
        const entry = createLogEntry('info', message, context);
        console.log(formatLogEntry(entry));
    },
    warn: (message, context) => {
        const entry = createLogEntry('warn', message, context);
        console.warn(formatLogEntry(entry));
    },
    error: (message, error, context) => {
        const entry = createLogEntry('error', message, context, error);
        console.error(formatLogEntry(entry));
    },
    withContext: (baseContext) => ({
        debug: (message, context) => logger.debug(message, { ...baseContext, ...context }),
        info: (message, context) => logger.info(message, { ...baseContext, ...context }),
        warn: (message, context) => logger.warn(message, { ...baseContext, ...context }),
        error: (message, error, context) => logger.error(message, error, { ...baseContext, ...context }),
    }),
};
/**
 * 带重试机制的异步函数执行器
 */
export async function withRetry(fn, options = {}) {
    const { maxRetries = 3, baseDelayMs = 2000, context = 'operation', onRetry } = options;
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxRetries) {
                const delay = baseDelayMs * attempt;
                logger.warn(`${context} failed, retrying in ${delay}ms`, {
                    attempt,
                    maxRetries,
                    error: lastError.message,
                });
                onRetry?.(attempt, lastError);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    logger.error(`${context} failed after ${maxRetries} attempts`, lastError, {
        maxRetries,
        context,
    });
    throw lastError;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export default logger;
//# sourceMappingURL=logger.js.map