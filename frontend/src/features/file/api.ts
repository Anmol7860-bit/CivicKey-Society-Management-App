import { ApiError, send } from '../auth/api'

export const MAX_BYTES = 5 * 1024 * 1024
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export interface StoredImage {
  id: string
  contentType: string
  byteSize: number
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
