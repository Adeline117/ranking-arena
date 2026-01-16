/**
 * Logger 工具单元测试
 */

import { Logger, createLogger, silent, logIf } from '../logger'

describe('Logger', () => {
  let consoleSpy: {
    log: jest.SpyInstance
    warn: jest.SpyInstance
    error: jest.SpyInstance
  }

  beforeEach(() => {
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
      error: jest.spyOn(console, 'error').mockImplementation(),
    }
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('基本功能', () => {
    test('创建默认 logger', () => {
      const logger = new Logger()
      expect(logger).toBeInstanceOf(Logger)
    })

    test('创建命名 logger', () => {
      const logger = new Logger('TestModule')
      expect(logger).toBeInstanceOf(Logger)
    })

    test('输出 debug 日志', () => {
      const logger = new Logger('Test', { minLevel: 'debug' })
      logger.debug('调试信息')
      expect(consoleSpy.log).toHaveBeenCalled()
    })

    test('输出 log 日志', () => {
      const logger = new Logger('Test', { minLevel: 'debug' })
      logger.log('普通日志')
      expect(consoleSpy.log).toHaveBeenCalled()
    })

    test('输出 warn 日志', () => {
      const logger = new Logger('Test')
      logger.warn('警告信息')
      expect(consoleSpy.warn).toHaveBeenCalled()
    })

    test('输出 error 日志', () => {
      const logger = new Logger('Test')
      logger.error('错误信息')
      expect(consoleSpy.error).toHaveBeenCalled()
    })
  })

  describe('日志级别控制', () => {
    test('低于最低级别的日志不输出', () => {
      const logger = new Logger('Test', { minLevel: 'warn' })
      logger.debug('不应该输出')
      logger.log('不应该输出')
      expect(consoleSpy.log).not.toHaveBeenCalled()
    })

    test('等于或高于最低级别的日志输出', () => {
      const logger = new Logger('Test', { minLevel: 'warn' })
      logger.warn('应该输出')
      expect(consoleSpy.warn).toHaveBeenCalled()
    })
  })

  describe('禁用/启用', () => {
    test('禁用后不输出日志', () => {
      const logger = new Logger('Test', { minLevel: 'debug' })
      logger.disable()
      logger.error('不应该输出')
      expect(consoleSpy.error).not.toHaveBeenCalled()
    })

    test('启用后恢复输出', () => {
      const logger = new Logger('Test', { minLevel: 'debug' })
      logger.disable()
      logger.enable()
      logger.error('应该输出')
      expect(consoleSpy.error).toHaveBeenCalled()
    })
  })

  describe('子 logger', () => {
    test('创建子 logger', () => {
      const parent = new Logger('Parent')
      const child = parent.child('Child')
      expect(child).toBeInstanceOf(Logger)
    })
  })

  describe('附加数据', () => {
    test('输出带附加数据的日志', () => {
      const logger = new Logger('Test', { minLevel: 'debug' })
      logger.log('消息', { key: 'value' })
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining('消息'),
        { key: 'value' }
      )
    })
  })
})

describe('createLogger', () => {
  test('创建命名 logger', () => {
    const logger = createLogger('MyModule')
    expect(logger).toBeInstanceOf(Logger)
  })

  test('创建带配置的 logger', () => {
    const logger = createLogger('MyModule', { minLevel: 'error' })
    expect(logger).toBeInstanceOf(Logger)
  })
})

describe('silent', () => {
  let consoleSpy: jest.SpyInstance

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('静默执行返回结果', () => {
    const result = silent(() => 42)
    expect(result).toBe(42)
  })
})

describe('logIf', () => {
  let consoleSpy: jest.SpyInstance

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('条件为真时输出', () => {
    logIf(true, 'warn', '应该输出')
    expect(consoleSpy).toHaveBeenCalled()
  })

  test('条件为假时不输出', () => {
    logIf(false, 'warn', '不应该输出')
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
