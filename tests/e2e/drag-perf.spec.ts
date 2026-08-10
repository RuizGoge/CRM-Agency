import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { OVERSCAN } from '~/components/board/column-window'
import { cardPitchPx } from '~/styles/tokens/geometry'

import {
  PERF_CARD_COUNT,
  PERF_OPEN_STAGES,
  PERF_SELLER_LOGIN,
  PERF_STAGES,
  readPerf500Shape,
  seedPerf500,
} from './fixtures/perf-500'
import { expectCount } from './fixtures/clock'

/**
 * Sprint-0 Gate 12 — the drag holds 60 fps with 500 cards, or the build is red.
 *
 * The drag has existed since the desktop-drag item and is bound to `>=lg` with a
 * fine pointer, with functional e2e on both profiles. What has never existed is
 * the half that gives the gate its name: the MEASUREMENT. Until now "drag at 60
 * fps with no long task over 50 ms" was a line in CLAUDE.md that nothing checked.
 *
 * Three separate failures, per `04b` §3.2 P6, and they are not one condition:
 *
 *   p95 > 20 ms          the drag is generally slow
 *   any frame > 34 ms    two dropped frames in a row — a visible jump
 *   any long task > 50 ms  the main thread stopped, which is what a seller feels
 *                          as the card sticking to the pointer
 *
 * A smooth average with one 60 ms stall passes an average and fails a seller,
 * which is why the maximum is its own assertion rather than folded into the p95.
 */

interface P6Budget {
  readonly value: number
  readonly max_frame: number
  readonly max_long_task: number
  readonly warn: number
}

const budget = (
  JSON.parse(readFileSync('perf-budgets.json', 'utf8')) as {
    budgets: readonly ({ id: string } & P6Budget)[]
  }
).budgets.find((b) => b.id === 'P6')

if (!budget) throw new Error('P6 is missing from perf-budgets.json')

test.describe('P6 · the drag holds 60 fps on a 500-card board', () => {
  test.beforeAll(async () => {
    await seedPerf500()
  })

  test('stays inside the frame budget across a scripted three-column drag', async ({
    page,
    context,
  }) => {
    // THE FIXTURE IS ASSERTED BEFORE ANYTHING IS MEASURED (04b §3.6). A drag is
    // fast on 200 cards and the budget would pass for the wrong reason — "an
    // improvement caused by a smaller fixture fails" is the rule, so a short
    // fixture is a red build and not a fast one.
    const shape = await readPerf500Shape()
    expect(shape.cards, 'perf-500 must hold exactly 500 cards').toBe(PERF_CARD_COUNT)
    expect(shape.stages, 'perf-500 is defined as six stages').toBe(PERF_STAGES.length)
    expect(shape.openStages).toBe(PERF_OPEN_STAGES.length)

    // 2x CPU slowdown — the whole definition of the dnd-ci profile. Applied over
    // CDP because Playwright has no declarative option, and applied BEFORE the
    // navigation so the board renders under the same throttle it is measured at.
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 })

    await page.goto('/sign-in')
    await page.getByLabel('Email').fill(PERF_SELLER_LOGIN.email)
    await page.getByLabel('Password').fill(PERF_SELLER_LOGIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expectCount(page.getByRole('navigation', { name: 'Main' }), 1)

    await page.goto('/board')

    // Drag is armed by an effect, so it has to be waited for rather than
    // assumed — dragging before it arms is a no-op that fails much later and
    // somewhere else.
    await expect(page.locator('main [data-drag]')).toHaveAttribute('data-drag', 'on')

    // 🔴 THIS ASSERTION USED TO READ `500 cards are mounted`, AND THE COLUMN
    // VIRTUALIZER MADE IT FALSE ON PURPOSE. It was written against the most
    // expensive kind of passing test — a green frame rate measured while nothing
    // was on screen — so it cannot simply be deleted; the property it protects
    // has to be re-obtained from what is now true.
    //
    // It splits in two, and BOTH halves are needed. The board must DECLARE five
    // hundred cards, which is the fixture assertion above reaching the screen
    // rather than stopping at the database. And the DOM must hold far fewer than
    // five hundred, which is the assertion that virtualization is actually on —
    // without it, a regression that disabled the window would restore the old
    // 500-node board and this gate would go quietly back to measuring it.
    const declared = await page
      .locator('main [data-cards]')
      .evaluateAll((els) =>
        els.reduce((n, el) => n + Number(el.getAttribute('data-cards') ?? '0'), 0),
      )
    expect(declared, 'the board must be showing the whole 500-card book').toBe(PERF_CARD_COUNT)

    const viewport = page.viewportSize()
    expect(viewport, 'dnd-ci has a fixed viewport and the cap is derived from it').not.toBeNull()
    const pitch = cardPitchPx(false)
    const perColumn = Math.ceil((viewport?.height ?? 0) / pitch) + OVERSCAN * 2 + 1
    const cap = perColumn * PERF_OPEN_STAGES.length
    const mounted = await page.locator('main article[draggable="true"]').count()
    console.log(`[P6] ${mounted} card nodes mounted of ${PERF_CARD_COUNT} declared (cap ${cap})`)
    expect(mounted, 'the window is not bounded — virtualization is off').toBeLessThanOrEqual(cap)
    expect(mounted, 'the window is empty, so nothing is being dragged over').toBeGreaterThanOrEqual(
      PERF_OPEN_STAGES.length * 4,
    )

    // THREE RUNS, MEDIAN REPORTED — the profile definition, not a workaround.
    //
    // `04b` §3.1 defines every profile as "3 runs, median reported" and the first
    // version of this spec reported a single run. That single run failed about
    // one time in three on a max frame of 50 ms, always with ZERO long tasks and
    // a p95 pinned at 16.8 ms — a lone frame the headless compositor did not
    // schedule, not work the product did.
    //
    // The distinction matters because the two available shortcuts are both
    // forbidden: raising max_frame would be weakening a budget to make a build
    // pass, and leaving it flaky produces a gate that gets deleted rather than
    // fixed. Applying the measurement protocol the spec already prescribes is
    // neither. A REAL regression is present in all three runs, so the median
    // moves with it; a scheduling artefact is not, so the median ignores it.
    const runs: { p95: number; worst: number; worstLongTask: number }[] = []
    let firstSample: Awaited<ReturnType<typeof runDrag>> | null = null

    async function runDrag() {
      return page.evaluate(
        async ({ stageNames, durationMs }) => {
          const zoneFor = (name: string): Element | null =>
            document.querySelector(`section[aria-label="${name}"]`)?.lastElementChild ?? null

          const zones = stageNames.map(zoneFor)
          if (zones.some((z) => z === null)) return null
          const card = document.querySelector('main article[draggable="true"]')
          if (!card) return null

          const longTasks: number[] = []
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration)
          })
          try {
            observer.observe({ entryTypes: ['longtask'] })
          } catch {
            // Reported below as an empty list; the test decides, not this block.
          }

          const stamps: number[] = []
          let running = true
          const tick = (t: number): void => {
            stamps.push(t)
            if (running) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)

          const dataTransfer = new DataTransfer()
          const fire = (el: Element, type: string): void => {
            el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
          }

          let ringSeen = false
          let entered = 0
          let dragoverCount = 0
          let ringCheckAt: number | null = null
          // When each column transition happened, so a dropped frame can be
          // attributed instead of guessed at. The first version of this spec
          // reported a 66 ms frame with no long task and no way to tell whether it
          // was the board re-rendering or the machine breathing.
          const enterTimes: number[] = []

          // Events rather than the mouse, for the reason the functional drag spec
          // already documents: the layer under test is the React handlers, and a
          // driver-side drag cannot hold the pointer over a column on a schedule.
          fire(card, 'dragstart')

          const start = performance.now()
          const third = durationMs / stageNames.length
          let current = -1

          while (performance.now() - start < durationMs) {
            const elapsed = performance.now() - start
            const index = Math.min(stageNames.length - 1, Math.floor(elapsed / third))
            const zone = zones[index]
            if (!zone) break

            if (index !== current) {
              const previous = current >= 0 ? zones[current] : null
              if (previous) fire(previous, 'dragleave')
              fire(zone, 'dragenter')
              enterTimes.push(performance.now())
              entered += 1
              // Three iterations (~24 ms) later, so React has flushed.
              ringCheckAt = dragoverCount + 3
              current = index
            }

            // dragover fires continuously in a real drag. This is the event the
            // board deliberately does NOT re-render on, so a regression that moves
            // state into it lands here.
            fire(zone, 'dragover')
            dragoverCount += 1

            // ONCE PER COLUMN, never per iteration, and never in the same tick as
            // the dragenter that caused it.
            //
            // Two defects live in these four lines, both found by running it.
            // `getComputedStyle` forces a synchronous style flush, and calling it
            // seventy times over a 500-card board made the HARNESS drop frames —
            // the first version failed on 50 and 67 ms frames that were mine, not
            // the product's. Then, sampling it in the same iteration as the
            // dragenter read the ring before React had re-rendered, so it reported
            // a drag that never lit. Instrumentation that costs more than what it
            // measures reports its own weight; instrumentation that reads too
            // early reports a product that did nothing.
            if (ringCheckAt !== null && dragoverCount >= ringCheckAt) {
              if (getComputedStyle(zone).boxShadow.includes('inset')) ringSeen = true
              ringCheckAt = null
            }

            await new Promise((r) => setTimeout(r, 8))
          }

          fire(card, 'dragend')
          running = false
          await new Promise((r) => setTimeout(r, 120))
          observer.disconnect()

          const frames: number[] = []
          for (let i = 1; i < stamps.length; i += 1) {
            const a = stamps[i - 1]
            const b = stamps[i]
            if (a !== undefined && b !== undefined) frames.push(b - a)
          }

          return {
            frames,
            frameStamps: stamps,
            enterTimes,
            longTasks,
            entered,
            ringSeen,
            rendered: document.querySelectorAll('main article[draggable="true"]').length,
            dragoverCount,
          }
        },
        { stageNames: PERF_OPEN_STAGES.slice(0, 3), durationMs: 1200 },
      )
    }

    for (let run = 0; run < 3; run += 1) {
      const sample = await runDrag()
      expect(sample, 'the scripted drag could not find its board').not.toBeNull()
      if (!sample) return
      if (run === 0) firstSample = sample

      // ENGAGEMENT FIRST, on EVERY run. Without these a green P6 could mean "the
      // frame rate was fine while nothing happened" — the most expensive kind of
      // passing test, because it reports the very property it was written to
      // protect.
      // The window has to still be on screen while the frames are being counted.
      // A board that unmounted its cards mid-drag would report a beautiful frame
      // rate for an empty column, which is the same false pass the 500-card
      // assertion used to guard against, one virtualizer later.
      expect(
        sample.rendered,
        'the board emptied while it was being measured',
      ).toBeGreaterThanOrEqual(PERF_OPEN_STAGES.length * 4)
      expect(sample.rendered, 'the window grew past its cap during the drag').toBeLessThanOrEqual(
        cap,
      )
      expect(sample.entered, 'the drag must cross three columns').toBe(3)
      expect(sample.ringSeen, 'the drop target never lit, so no drag was in progress').toBe(true)
      expect(sample.dragoverCount).toBeGreaterThan(30)
      expect(sample.frames.length, 'no frames were sampled').toBeGreaterThan(20)

      const sorted = [...sample.frames].sort((a, b) => a - b)
      runs.push({
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity,
        worst: sorted[sorted.length - 1] ?? Infinity,
        worstLongTask: sample.longTasks.length > 0 ? Math.max(...sample.longTasks) : 0,
      })
    }

    const median = (pick: (r: (typeof runs)[number]) => number): number =>
      [...runs].map(pick).sort((a, b) => a - b)[1] ?? Infinity

    const p95 = median((r) => r.p95)
    const worst = median((r) => r.worst)
    const worstLongTask = median((r) => r.worstLongTask)

    // Attribution for the first run, so a red build says WHERE the frame went
    // rather than only that one did.
    if (firstSample) {
      const sample = firstSample
      const worstFrames = sample.frames
        .map((ms, i) => ({ ms, at: sample.frameStamps[i + 1] ?? 0 }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 3)
        .map((f) => {
          const gap = Math.min(...sample.enterTimes.map((t) => Math.abs(f.at - t)))
          return `${f.ms.toFixed(1)}ms@${gap.toFixed(0)}ms-from-dragenter`
        })
        .join(' ')
      console.log(`[P6] run 1 worst frames: ${worstFrames}`)
    }

    console.log(
      `[P6] medians of 3 runs — p95=${p95.toFixed(1)}ms max=${worst.toFixed(1)}ms ` +
        `worstLongTask=${worstLongTask.toFixed(1)}ms ` +
        `(all runs max: ${runs.map((r) => r.worst.toFixed(1)).join(', ')}) ` +
        `(budget p95<=${budget.value}, frame<=${budget.max_frame}, longTask<=${budget.max_long_task})`,
    )

    expect(p95, `p95 frame time over ${budget.value}ms`).toBeLessThanOrEqual(budget.value)
    expect(worst, `a frame over ${budget.max_frame}ms is a visible jump`).toBeLessThanOrEqual(
      budget.max_frame,
    )
    expect(
      worstLongTask,
      `a long task over ${budget.max_long_task}ms is the card sticking to the pointer`,
    ).toBeLessThanOrEqual(budget.max_long_task)
  })
})
