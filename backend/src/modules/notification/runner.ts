import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { runDispatcherOnce } from './dispatcher.js'
import { runJobsOnce } from './jobs.js'

/**
 * Runs a pass repeatedly, never two at once.
 *
 * setInterval would start a second pass while the first is still going if a pass ever takes
 * longer than the interval, and under load that is exactly when it would. Each pass instead
 * schedules the next one when it finishes.
 */
function loop(name: string, intervalSeconds: number, pass: () => Promise<unknown>) {
  if (intervalSeconds <= 0) {
    logger.info({ loop: name }, 'Loop is switched off')
    return () => {}
  }
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async () => {
    try {
      await pass()
    } catch (error) {
      logger.error({ err: error, loop: name }, 'A loop pass failed')
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalSeconds * 1000)
      // Never hold the process open: a shutdown should not wait out the interval
      timer.unref()
    }
  }
  void tick()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/**
 * Starts the dispatcher and the scheduled jobs.
 *
 * Both are safe to run in more than one process: the dispatcher claims rows with SKIP LOCKED, and
 * each job claims its work with the same update that marks it done.
 */
export function startBackgroundWork() {
  const stops = [
    loop('dispatcher', env.DISPATCHER_INTERVAL_SECONDS, runDispatcherOnce),
    loop('jobs', env.JOB_INTERVAL_SECONDS, runJobsOnce),
  ]
  return () => stops.forEach((stop) => stop())
}
