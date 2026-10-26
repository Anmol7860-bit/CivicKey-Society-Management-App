import { Router, raw } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { AppError } from '../../lib/errors.js'
import { MAX_BYTES, readImage, saveImage } from './file.service.js'

/**
 * Private image storage: the raw bytes go up, a reference comes back, and the only way to see the
 * image again is this router, with a session for the same society.
 *
 * There is no multipart form here on purpose. The browser sends the chosen File as the request
 * body with its own content type, which removes a parser and a dependency from the trust boundary.
 */
export function createFileRouter() {
  const router = Router()

  router.post(
    '/files',
    requireAuth,
    raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(400, 'INVALID_FILE', 'Send the image as the request body, typed image/jpeg, png or webp.')
      }
      res.status(201).json({ data: await saveImage(req.ctx!, req.body) })
    },
  )

  router.get('/files/:id', requireAuth, async (req, res) => {
    const { contentType, bytes } = await readImage(req.ctx!.societyId, req.params.id as string)
    res.setHeader('Content-Type', contentType)
    // The image is one person's photograph: a shared cache must never keep it
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(bytes)
  })

  return router
}
