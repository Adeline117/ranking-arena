/**
 * Ethereum Blockie Avatar Generator
 *
 * Generates deterministic 8×8 pixel-art avatars from Ethereum addresses.
 * Same algorithm as MetaMask / Etherscan blockies.
 *
 * Usage: /api/avatar/blockie?address=0x1234...abcd&size=64
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const CACHE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days - blockies are deterministic

// ── Blockie generation (pure server-side, no canvas needed) ──

function createColor(): [number, number, number] {
  const h = Math.floor(randseed() * 360)
  const s = randseed() * 60 + 40
  const l = (randseed() + randseed() + randseed() + randseed()) * 25
  return hsl2rgb(h, s / 100, l / 100)
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
  }
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

let seedArr: number[] = []

function seedRand(seed: string) {
  seedArr = new Array(4).fill(0)
  for (let i = 0; i < seed.length; i++) {
    seedArr[i % 4] = (seedArr[i % 4] << 5) - seedArr[i % 4] + seed.charCodeAt(i)
  }
}

function randseed(): number {
  const t = seedArr[0] ^ (seedArr[0] << 11)
  seedArr[0] = seedArr[1]
  seedArr[1] = seedArr[2]
  seedArr[2] = seedArr[3]
  seedArr[3] = seedArr[3] ^ (seedArr[3] >> 19) ^ t ^ (t >> 8)
  return (seedArr[3] >>> 0) / ((1 << 31) >>> 0)
}

function createImageData(size: number): number[] {
  const width = size
  const height = size
  const dataWidth = Math.ceil(width / 2)
  const mirrorWidth = width - dataWidth
  const data: number[] = []

  for (let y = 0; y < height; y++) {
    let row: number[] = []
    for (let x = 0; x < dataWidth; x++) {
      row.push(Math.floor(randseed() * 2.3))
    }
    // Mirror
    const r = row.slice(0, mirrorWidth).reverse()
    row = row.concat(r)
    for (let i = 0; i < row.length; i++) {
      data.push(row[i])
    }
  }
  return data
}

function generateBlockieSVG(address: string, pixelSize: number = 8): string {
  const seed = address.toLowerCase()
  seedRand(seed)

  const color = createColor()
  const bgcolor = createColor()
  const spotcolor = createColor()

  const size = 8
  const imageData = createImageData(size)
  const scale = pixelSize

  const toHex = (c: [number, number, number]) =>
    `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`

  let rects = ''
  for (let i = 0; i < imageData.length; i++) {
    const x = (i % size) * scale
    const y = Math.floor(i / size) * scale
    let fill: string
    if (imageData[i] === 0) {
      fill = toHex(bgcolor)
    } else if (imageData[i] === 1) {
      fill = toHex(color)
    } else {
      fill = toHex(spotcolor)
    }
    rects += `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" fill="${fill}"/>`
  }

  const totalSize = size * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalSize}" height="${totalSize}" viewBox="0 0 ${totalSize} ${totalSize}">${rects}</svg>`
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const address = searchParams.get('address')
  const size = Math.min(Math.max(parseInt(searchParams.get('size') || '8'), 1), 32)

  if (!address) {
    return new NextResponse('Missing address parameter', { status: 400 })
  }

  const svg = generateBlockieSVG(address, size)

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
      'Access-Control-Allow-Origin': '*',
    },
  })
}
