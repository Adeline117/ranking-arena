import { diskUsedPct, parseDiskUsedPct } from '../heartbeat'

describe('worker heartbeat disk usage', () => {
  test('parses Linux and macOS POSIX df output', () => {
    expect(
      parseDiskUsedPct(
        [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/vda1 20480000 19456000 1024000 95% /',
        ].join('\n')
      )
    ).toBe(95)

    expect(
      parseDiskUsedPct(
        [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/disk3s1 100000000 97000000 3000000 97% /System/Volumes/Data',
        ].join('\n')
      )
    ).toBe(97)
  })

  test('rejects missing and out-of-range capacity values', () => {
    expect(parseDiskUsedPct('not df output')).toBeUndefined()
    expect(parseDiskUsedPct('/dev/vda1 1 1 0 101% /')).toBeUndefined()
  })

  test('checks the filesystem containing the supplied worker directory', () => {
    const readUsage = jest.fn(() => '/dev/disk3s1 100 97 3 97% /System/Volumes/Data')

    expect(diskUsedPct('/srv/ranking-arena', readUsage)).toBe(97)
    expect(readUsage).toHaveBeenCalledWith('/srv/ranking-arena')
  })

  test('fails open when df cannot inspect the worker filesystem', () => {
    expect(
      diskUsedPct('/srv/ranking-arena', () => {
        throw new Error('df failed')
      })
    ).toBeUndefined()
  })
})
