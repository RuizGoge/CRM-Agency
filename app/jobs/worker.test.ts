import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { workerEnabled } from './worker'

/**
 * `PROCESS_ROLES` is the ENTIRE fold/split mechanism (ADR-01 / ADR-S1): the
 * three processes are one image, and this variable is what decides whether the
 * worker runs inside the web process or beside it. Nothing else in the tree
 * changes between the two topologies, so the parsing of this one string carries
 * the whole ruling that the topology is deployment configuration rather than an
 * architectural assumption.
 */

const KEY = 'PROCESS_ROLES'
const original = process.env[KEY]

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe('which processes carry the worker role', () => {
  it('runs the worker when the variable is unset', () => {
    // The default is deliberately ON. A deployment that forgets the variable
    // should run the reminders rather than silently not run them: the failure
    // of a missing config must be a NOISIER process, never a quieter one.
    delete process.env[KEY]
    expect(workerEnabled()).toBe(true)
  })

  it('runs the worker when the variable is empty', () => {
    process.env[KEY] = '   '
    expect(workerEnabled()).toBe(true)
  })

  it('runs the worker in the folded topology', () => {
    process.env[KEY] = 'web,worker,ingest'
    expect(workerEnabled()).toBe(true)
  })

  it('does not run the worker in a web-only process', () => {
    // The split half of the topology, and also the documented escape hatch the
    // JOBS002 refusal points at.
    process.env[KEY] = 'web,ingest'
    expect(workerEnabled()).toBe(false)
  })

  it('tolerates the spaces a human writes into an env file', () => {
    process.env[KEY] = 'web , worker , ingest'
    expect(workerEnabled()).toBe(true)
  })

  it('matches the role exactly, so a near miss does not silently enable it', () => {
    // `includes` on the raw string would make "workers" — or "no-worker" —
    // start a dispatcher nobody asked for, and a second dispatcher against the
    // same queue is the concurrency the claim's lease exists to survive rather
    // than something to invite.
    process.env[KEY] = 'web,workers'
    expect(workerEnabled()).toBe(false)
  })
})

describe('the fold is actually wired into the web process', () => {
  it('has entry.server.tsx call bootFoldedWorker at module scope', () => {
    // A TEXT assertion, and weak on purpose about what it proves: it cannot show
    // that the worker starts — that is verified by running the process and
    // watching it write terminal rows. What it does catch is the one silent
    // regression available here. Deleting this call leaves typecheck, lint and
    // every other test green while the topology quietly goes back to being
    // declared and not wired, which is the exact state this item existed to end.
    const source = readFileSync(join(process.cwd(), 'app', 'entry.server.tsx'), 'utf8')

    expect(source).toContain("import { bootFoldedWorker } from './jobs/boot'")
    expect(source).toMatch(/^bootFoldedWorker\(\)$/m)
  })
})
