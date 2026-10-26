/**
 * Removes the metadata a camera or phone leaves in an image, keeping the picture.
 *
 * A photo taken at the gate carries the location, the device and the time it was taken, and a
 * staff photograph is kept for years. Nothing in CivicKey reads that metadata, so it is dropped
 * on the way in rather than guarded afterwards. The parsers here only walk the container: the
 * compressed image data is copied through untouched.
 */

/** JPEG application and comment segments hold EXIF, the thumbnail, XMP, IPTC and ICC. */
function stripJpeg(input: Buffer): Buffer {
  const keep: Buffer[] = [input.subarray(0, 2)] // SOI
  let at = 2
  while (at + 4 <= input.length) {
    if (input[at] !== 0xff) break
    const marker = input[at + 1]!
    // Start of scan: the entropy-coded data runs to the end and is never parsed further
    if (marker === 0xda) {
      keep.push(input.subarray(at))
      return Buffer.concat(keep)
    }
    const length = input.readUInt16BE(at + 2)
    if (length < 2 || at + 2 + length > input.length) break
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
    if (!isMetadata) keep.push(input.subarray(at, at + 2 + length))
    at += 2 + length
  }
  // Anything unparseable is returned as it came: a malformed file is rejected by the sniff, and
  // a file this walk cannot follow is not one to rewrite blindly.
  return input
}

const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'iCCP'])

function stripPng(input: Buffer): Buffer {
  const keep: Buffer[] = [input.subarray(0, 8)] // signature
  let at = 8
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at)
    const type = input.toString('latin1', at + 4, at + 8)
    const end = at + 12 + length
    if (end > input.length) return input
    if (!PNG_METADATA.has(type)) keep.push(input.subarray(at, end))
    at = end
    if (type === 'IEND') break
  }
  return Buffer.concat(keep)
}

const WEBP_METADATA = new Set(['EXIF', 'XMP '])

function stripWebp(input: Buffer): Buffer {
  const keep: Buffer[] = []
  let at = 12 // 'RIFF' + size + 'WEBP'
  while (at + 8 <= input.length) {
    const type = input.toString('latin1', at, at + 4)
    const length = input.readUInt32LE(at + 4)
    const end = at + 8 + length + (length % 2) // chunks are padded to an even length
    if (at + 8 + length > input.length) return input
    if (!WEBP_METADATA.has(type)) keep.push(input.subarray(at, Math.min(end, input.length)))
    at = end
  }
  const body = Buffer.concat(keep)
  const header = Buffer.from(input.subarray(0, 12))
  header.writeUInt32LE(4 + body.length, 4)
  return Buffer.concat([header, body])
}

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp'

/** The real type of the bytes, not what the request claimed, or null when they are not an image. */
export function sniff(input: Buffer): ImageType | null {
  if (input.length < 12) return null
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'image/jpeg'
  if (input.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function stripMetadata(input: Buffer, type: ImageType): Buffer {
  if (type === 'image/jpeg') return stripJpeg(input)
  if (type === 'image/png') return stripPng(input)
  return stripWebp(input)
}

export const EXTENSIONS: Record<ImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
