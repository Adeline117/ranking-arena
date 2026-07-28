import { NativeRegionConfigError, resolveNativeRegionConfig } from '../native-region-config'

describe('native region configuration', () => {
  it.each(['local', 'vps_sg'] as const)(
    'accepts exactly one matching %s native region',
    (region) => {
      const input = [region]
      const config = resolveNativeRegionConfig(input, region)

      expect(config).toEqual({
        consumedRegions: [region],
        executionRegion: region,
        nativeRegion: region,
      })
      expect(config.consumedRegions).not.toBe(input)
      expect(Object.isFrozen(config)).toBe(true)
      expect(Object.isFrozen(config.consumedRegions)).toBe(true)

      input[0] = region === 'local' ? 'vps_sg' : 'local'
      expect(config.nativeRegion).toBe(region)
      expect(config.consumedRegions).toEqual([region])
    }
  )

  it.each([undefined, null, 'local', [], ['local', 'vps_sg'], ['local', 'local']])(
    'rejects a non-singleton consumed-region input',
    (consumedRegions) => {
      expect(() => resolveNativeRegionConfig(consumedRegions, 'local')).toThrow(
        expect.objectContaining({
          code: 'invalid_consumed_regions',
          name: 'NativeRegionConfigError',
        })
      )
    }
  )

  it.each(['vps_jp', 'unknown', '', undefined, null])(
    'rejects unsupported native region %p',
    (region) => {
      expect(() => resolveNativeRegionConfig([region], region)).toThrow(
        expect.objectContaining({ code: 'unsupported_native_region' })
      )
    }
  )

  it.each([
    ['local', 'vps_sg'],
    ['local', 'vps_jp'],
    ['vps_sg', 'local'],
    ['vps_sg', undefined],
  ] as const)('rejects native region %p with execution region %p', (native, execution) => {
    expect(() => resolveNativeRegionConfig([native], execution)).toThrow(
      expect.objectContaining({ code: 'execution_region_mismatch' })
    )
  })

  it('sanitizes hostile values and unexpected validation failures', () => {
    const secret = 'DATABASE_URL=postgres://operator-secret'
    const forgedError = new NativeRegionConfigError('invalid_consumed_regions')
    forgedError.message = secret
    const hostile = new Proxy([secret], {
      get() {
        throw forgedError
      },
    })

    for (const attempt of [
      () => resolveNativeRegionConfig([secret], secret),
      () => resolveNativeRegionConfig(['local'], secret),
      () => resolveNativeRegionConfig(hostile, 'local'),
    ]) {
      try {
        attempt()
        throw new Error('expected configuration rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(NativeRegionConfigError)
        expect((error as Error).message).not.toContain(secret)
      }
    }
  })
})
