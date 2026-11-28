const { crc32 } = require('zlib')
const sharp = require('sharp')

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_SPRITE_PIXELS = 16 * 1024 * 1024

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

const assertCompleteSprite = (bytes) => {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) assertCompletePng(bytes)
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && bytes.readUInt32LE(4) + 8 > bytes.length) {
    throw new Error('Incomplete WebP image')
  }
}

const inspectSprite = async (bytes) => {
  assertCompleteSprite(bytes)
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_SPRITE_PIXELS })
  const { width, height } = await image.metadata()
  if (!width || !height || width * height > MAX_SPRITE_PIXELS) {
    throw new Error(`Sprite exceeds the ${MAX_SPRITE_PIXELS}-pixel limit`)
  }
  return { width, height, decode: () => image.raw().toBuffer() }
}

module.exports = { assertCompleteSprite, inspectSprite }
