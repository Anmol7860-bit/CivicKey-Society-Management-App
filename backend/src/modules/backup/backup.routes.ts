import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import * as service from './backup.service.js'

/**
 * The encrypted local backup export. Every route re-checks BACKUP_EXPORT, including the download:
 * holding a link is not permission, and the permission may have been revoked since.
 */
export function createBackupRouter() {
  const router = Router()
  const exportBackup = [requireAuth, requirePermission('BACKUP_EXPORT')]

  router.get('/societies/:societyId/backups', ...exportBackup, async (req, res) => {
    res.json({ data: await service.listBackups(req.ctx!, req.params.societyId as string) })
  })

  router.post('/societies/:societyId/backups', ...exportBackup, async (req, res) => {
    res.status(202).json({ data: await service.requestBackup(req.ctx!, req.params.societyId as string) })
  })

  router.get('/backups/:jobId', ...exportBackup, async (req, res) => {
    res.json({ data: await service.backupStatus(req.ctx!, req.params.jobId as string) })
  })

  router.get('/backups/:jobId/download', ...exportBackup, async (req, res) => {
    const { fileName, bytes } = await service.downloadBackup(req.ctx!, req.params.jobId as string)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.send(bytes)
  })

  return router
}
