/**
 * The worker process, standalone.
 *
 * This is the SPLIT half of the foldable topology: the same code the web
 * process would run in-process when `PROCESS_ROLES` includes `worker`, started
 * on its own here. Nothing about the dispatcher knows which of the two it is
 * in, which is what makes the split a deployment decision rather than a
 * rewrite.
 */
async function main(): Promise<void> {
  // Imported dynamically so the G4(a) boot assertion in `~/db` runs inside this
  // process's error handling rather than at module load, where a refusal to
  // start would surface as an unhandled rejection instead of the message that
  // says which credential is wrong.
  const { startWorker, stopWorker, workerEnabled } = await import('../app/jobs/worker')

  if (!workerEnabled()) {
    console.log('PROCESS_ROLES does not include "worker". Nothing to run.')
    return
  }

  await startWorker()
  console.log('Worker started. Dispatching scheduled jobs every minute.')

  const shutdown = (signal: string): void => {
    console.log(`\n${signal}: stopping.`)
    void stopWorker().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
