import { ApiError, send } from '../auth/api'

export const MAX_BYTES = 5 * 1024 * 1024
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export interface StoredImage {
  id: string
  contentType: string
  byteSize: number
}

/** The longest edge a stored photograph needs. A gate photo is looked at, never printed. */
const MAX_EDGE = 1280

/**
 * Shrinks a photo before it leaves the device.
 *
 * A phone camera writes several megabytes; the gate needs a face. Resizing here saves the guard's
 * data and the server's disk, and it happens on the device so a slow upload is short. Anything the
 * browser cannot decode is sent as it is - the server checks the bytes either way.
 */
export async function compressImage(file: File) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Already small enough and already a JPEG: nothing to gain from a re-encode
    if (scale === 1 && file.type === 'image/jpeg') return file
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    bitmap.close()
    return blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file
  }
}

/**
 * Uploads one image and returns the reference a record keeps.
 *
 * The file goes up as the request body with its own content type: there is no form to encode, and
 * the server reads the real type from the bytes anyway. The type and size are checked here too, so
 * the person is told before a 5 MB upload rather than after.
 */
export function uploadImage(token: string, file: File) {
  if (!ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
    throw new ApiError('INVALID_FILE', 'Choose a JPEG, PNG or WebP image.')
  }
  if (file.size > MAX_BYTES) throw new ApiError('INVALID_FILE', 'That image is larger than 5 MB.')

  return send<StoredImage>('/api/v1/files', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
    body: file,
  })
}

/** A stored image as a blob, since the endpoint needs the access token an <img> cannot send. */
export async function fetchImage(token: string, reference: string) {
  const res = await fetch(`/api/v1/files/${reference}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new ApiError('NOT_FOUND', 'That image is no longer available.')
  return res.blob()
}
