/**
 * Drizzle wraps a driver error as "Failed query: ..." and keeps the PostgreSQL
 * one on `cause`. A naive `rejects.toThrow(/SM003/)` therefore passes for the
 * wrong reason on a rejection that never contained SM003 at all.
 *
 * Worth knowing beyond the tests: the route boundary that maps SQLSTATE to an
 * HTTP status has to walk this same chain, or a 42501 — the supervisor's 403 —
 * arrives looking like an unclassified 500.
 */
export async function rejectionChain(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return '<resolved>'
  } catch (err: unknown) {
    const parts: string[] = []
    let current: unknown = err
    while (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    }
    return parts.join(' | ')
  }
}
