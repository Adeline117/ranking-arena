import { test, expect } from './fixtures'

// The desktop ranking table renders the header and every row as separate grids
// that only line up when they share one geometry. Earlier drift went unnoticed
// because the layout tests only checked that the columns exist:
// - the header used a smaller gap and inset, so it sat 20-24px off the data;
// - the score cell overflowed into ROI, covering its ▲;
// - the absolutely positioned expand button covered the last metric's %;
// - podium rows were narrower than ordinary rows.
// These checks measure the rendered boxes instead.

type Box = { left: number; right: number; top: number; bottom: number }
type RowGeometry = {
  cells: { name: string; left: number; right: number; overflow: number }[]
  expand: Box | null
}

async function tableGeometry(page: import('@playwright/test').Page) {
  return page.evaluate((): RowGeometry[] => {
    const grids = [
      ...document.querySelectorAll<HTMLElement>('#homepage-interactive .ranking-table-grid-custom'),
    ].filter((grid) => grid.getBoundingClientRect().height > 0)
    return grids.map((grid) => {
      const cells = [...grid.children]
        .filter((cell): cell is HTMLElement => cell instanceof HTMLElement)
        .filter((cell) => {
          const style = getComputedStyle(cell)
          return (
            style.position !== 'absolute' &&
            style.display !== 'none' &&
            cell.getBoundingClientRect().width > 0
          )
        })
        .map((cell, index) => {
          const box = cell.getBoundingClientRect()
          return {
            name: `${index}:${cell.className || cell.tagName}`,
            left: box.left,
            right: box.right,
            overflow: cell.scrollWidth - cell.clientWidth,
          }
        })
      const expandButton = grid.querySelector<HTMLElement>('.expand-btn')
      const expandBox = expandButton?.getBoundingClientRect()
      return {
        cells,
        expand: expandBox
          ? {
              left: expandBox.left,
              right: expandBox.right,
              top: expandBox.top,
              bottom: expandBox.bottom,
            }
          : null,
      }
    })
  })
}

for (const density of ['comfortable', 'compact'] as const) {
  test(`desktop ranking header and rows share one column geometry (${density})`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the grid table is desktop-only')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.addInitScript((value) => {
      window.localStorage.setItem('arena.ranking.density', value)
    }, density)
    await page.goto('/')
    await expect(
      page.locator('#homepage-interactive a[href*="/trader/"]:visible').first()
    ).toBeVisible()

    const [header, ...rows] = await tableGeometry(page)
    expect(rows.length).toBeGreaterThan(3)

    for (const [rowIndex, row] of rows.entries()) {
      // Same number of columns, each starting where its header label starts.
      expect(row.cells.length, `row ${rowIndex} column count`).toBe(header.cells.length)
      for (const [index, cell] of row.cells.entries()) {
        expect(
          Math.abs(cell.left - header.cells[index].left),
          `row ${rowIndex} ${cell.name} vs header ${header.cells[index].name}`
        ).toBeLessThanOrEqual(1)
        // Content stays inside its own track instead of spilling onto the
        // neighbouring column.
        expect(cell.overflow, `row ${rowIndex} ${cell.name} overflow`).toBeLessThanOrEqual(0)
      }
      // The expand button lives in the reserved inset, clear of the last column.
      if (row.expand) {
        const last = row.cells[row.cells.length - 1]
        expect(row.expand.left, `row ${rowIndex} expand button`).toBeGreaterThanOrEqual(last.right)
      }
    }
    for (const [index, cell] of header.cells.entries()) {
      expect(cell.overflow, `header ${cell.name} overflow`).toBeLessThanOrEqual(0)
    }
  })
}
