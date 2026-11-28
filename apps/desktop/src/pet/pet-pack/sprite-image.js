const fs = require('fs')
const { crc32 } = require('zlib')
const { Image } = require('@napi-rs/canvas')

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

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

const decodeSpriteSize = (imagePath) => {
  const bytes = fs.readFileSync(imagePath)
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) assertCompletePng(bytes)
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && bytes.readUInt32LE(4) + 8 > bytes.length) {
    throw new Error('Incomplete WebP image')
  }
  const image = new Image()
  image.src = bytes
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('Unsupported or corrupt image')
  return { width: image.naturalWidth, height: image.naturalHeight }
}

module.exports = { decodeSpriteSize }
