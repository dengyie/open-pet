const { crc32 } = require('zlib')
const sharp = require('sharp')

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_SPRITE_PIXELS = 16 * 1024 * 1024

const assertSpriteSize = (width, height) => {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Invalid sprite dimensions')
  }
  if (width * height > MAX_SPRITE_PIXELS) throw new Error(`Sprite exceeds the ${MAX_SPRITE_PIXELS}-pixel limit`)
}

const assertCompletePng = (bytes) => {
  for (let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 8 + length
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) {
      throw new Error('Incomplete or corrupt PNG chunk')
    }
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IEND' && length === 0) return
    offset = end + 4
  }
  throw new Error('Missing PNG end chunk')
}

const isBmp = (bytes) => bytes[0] === 0x42 && bytes[1] === 0x4d

const assertCompleteBmpRle = (bytes, offset, end, bitsPerPixel) => {
  while (offset + 2 <= end) {
    const count = bytes[offset++]
    const command = bytes[offset++]
    if (count || command === 0) continue
    if (command === 1) return
    if (command === 2) {
      offset += 2
    } else {
      const payloadLength = Math.ceil(command * bitsPerPixel / 8)
      offset += payloadLength + (payloadLength % 2)
    }
  }
  throw new Error('Incomplete BMP run-length data')
}

const inspectBmp = (bytes) => {
  if (bytes.length < 26) throw new Error('Incomplete BMP header')
  const fileEnd = bytes.readUInt32LE(2) || bytes.length
  const pixelOffset = bytes.readUInt32LE(10)
  const headerSize = bytes.readUInt32LE(14)
  const headerEnd = 14 + headerSize
  const coreHeader = headerSize === 12
  if ((!coreHeader && headerSize < 40) || headerEnd > pixelOffset || pixelOffset >= fileEnd || fileEnd > bytes.length) {
    throw new Error('Invalid or incomplete BMP header')
  }

  const width = coreHeader ? bytes.readUInt16LE(18) : bytes.readInt32LE(18)
  const signedHeight = coreHeader ? bytes.readUInt16LE(20) : bytes.readInt32LE(22)
  const height = Math.abs(signedHeight)
  assertSpriteSize(width, height)
  const planes = bytes.readUInt16LE(coreHeader ? 22 : 26)
  const bitsPerPixel = bytes.readUInt16LE(coreHeader ? 24 : 28)
  const compression = coreHeader ? 0 : bytes.readUInt32LE(30)
  const encodedLength = coreHeader ? 0 : bytes.readUInt32LE(34)
  const rle = (compression === 1 && bitsPerPixel === 8) || (compression === 2 && bitsPerPixel === 4)
  const bitfields = (compression === 3 || compression === 6) && (bitsPerPixel === 16 || bitsPerPixel === 32)
  if (planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)
      || (compression !== 0 && !rle && !bitfields) || (rle && signedHeight < 0)) {
    throw new Error('Unsupported BMP encoding')
  }

  const maskLength = bitfields && headerSize === 40 ? (compression === 6 ? 16 : 12) : 0
  const paletteEntries = bitsPerPixel <= 8 ? (coreHeader ? 0 : bytes.readUInt32LE(46)) || (1 << bitsPerPixel) : 0
  const rowStride = Math.ceil(width * bitsPerPixel / 32) * 4
  const requiredLength = rle ? encodedLength : Math.max(encodedLength, rowStride * height)
  if (pixelOffset < headerEnd + maskLength + paletteEntries * (coreHeader ? 3 : 4) || pixelOffset + requiredLength > fileEnd) {
    throw new Error('Incomplete BMP pixel data')
  }
  if (rle) assertCompleteBmpRle(bytes, pixelOffset, encodedLength ? pixelOffset + encodedLength : fileEnd, bitsPerPixel)
  return { width, height }
}

const assertCompleteSprite = (bytes) => {
  if (isBmp(bytes)) inspectBmp(bytes)
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) assertCompletePng(bytes)
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && bytes.readUInt32LE(4) + 8 > bytes.length) {
    throw new Error('Incomplete WebP image')
  }
}

const inspectSprite = async (bytes) => {
  if (isBmp(bytes)) return inspectBmp(bytes)
  assertCompleteSprite(bytes)
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_SPRITE_PIXELS })
  const { width, height } = await image.metadata()
  assertSpriteSize(width, height)
  return { width, height, decode: () => image.raw().toBuffer() }
}

module.exports = { assertCompleteSprite, inspectSprite }
