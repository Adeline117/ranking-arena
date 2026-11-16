/**
 * The box-local worker/.env is the runtime authority for a worker release.
 * Startup and release preflights refuse to run when it cannot be loaded, so
 * inherited PM2/shell state can never stand in for a missing file.
 */
export function assertWorkerEnvironmentFileLoaded(loaded: {
  error?: Error
  parsed?: Record<string, string>
}): void {
  if (loaded.error !== undefined || loaded.parsed === undefined) {
    throw new Error('[ingest-worker] startup gate failed closed: worker/.env is unavailable')
  }
}
