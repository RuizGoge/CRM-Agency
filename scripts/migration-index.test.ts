import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Two migrations cannot share a number.
 *
 * `guard-db-generate.ts` refuses to GENERATE a number another worktree or
 * branch already claimed, which is the cheap moment to catch it. This is the
 * other end: the moment two branches MERGE and both files land in one tree.
 *
 * Neither is redundant. The guard runs only when somebody generates, so it
 * cannot see a hand-written migration — and migrations 0019 through 0025 and
 * 0035 onward were largely written by hand, because functions, triggers,
 * policies and grants are not things Drizzle can express. This one runs on
 * every commit and asks a question that needs no database, no git and no
 * network: are these files numbered uniquely?
 *
 * WHAT IT WOULD HAVE CAUGHT. Three worktrees each read their own tree, each saw
 * 0034 as the newest, and each wrote an 0035. The collision surfaced only when
 * all three were applied to one shared development database and `harden()`
 * raised HR002 for a policy class the other branch had never taught it —
 * a symptom four steps removed from its cause, in a command that swallows its
 * own errors.
 */

const MIGRATIONS = 'app/db/migrations'
const JOURNAL = `${MIGRATIONS}/meta/_journal.json`

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[]
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
const journal = JSON.parse(readFileSync(JOURNAL, 'utf8')) as Journal

/** `0043_event_store.sql` → 43. */
function indexOf(name: string): number | null {
  const match = /^(\d{4})_.*\.sql$/.exec(name)
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

describe('every migration has its own number', () => {
  it('is reading a real set of migrations', () => {
    // The mutation guard: an empty scan is the cheapest way to make a
    // uniqueness check pass forever.
    expect(files.length).toBeGreaterThan(30)
  })

  it('never gives two files the same index', () => {
    const seen = new Map<number, string[]>()
    for (const file of files) {
      const idx = indexOf(file)
      if (idx === null) continue
      seen.set(idx, [...(seen.get(idx) ?? []), file])
    }

    const clashes = [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([idx, names]) => `${String(idx).padStart(4, '0')}: ${names.join(' · ')}`)

    expect(
      clashes,
      `two migrations share a number:\n  ${clashes.join('\n  ')}\n\n` +
        'This is what a merge between two branches that each numbered from the same\n' +
        'starting point looks like. Renumber the LATER one and its journal entry —\n' +
        'migrations are never renumbered after they are merged, so the window to fix\n' +
        'it is now.',
    ).toEqual([])
  })

  it('never journals the same index twice', () => {
    // The journal is what the migrator actually reads, so a duplicate here is
    // the failure the filenames only hint at: two entries with one idx means
    // one of them is applied and the other silently is not.
    const indices = journal.entries.map((e) => e.idx)
    expect(new Set(indices).size, 'the journal repeats an idx').toBe(indices.length)
  })

  it('journals exactly the files on disk, by index', () => {
    const onDisk = files
      .map(indexOf)
      .filter((i): i is number => i !== null)
      .sort((a, b) => a - b)
    expect(journal.entries.map((e) => e.idx).sort((a, b) => a - b)).toEqual(onDisk)
  })
})
