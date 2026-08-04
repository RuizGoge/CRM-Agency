import { chromium } from '@playwright/test'
import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'

import { PERF_SELLER_LOGIN } from './perf-500'

/**
 * P20 — mobile time-to-interactive, measured by Lighthouse itself.
 *
 * THE ALGORITHM IS NOT REIMPLEMENTED HERE, and that is the whole point of the
 * dependency. TTI is "the first five-second window after FCP with no long task
 * and at most two in-flight requests, walked backwards from the end of the
 * trace" — subtle enough that a hand-rolled version would be *plausibly* wrong,
 * and a plausibly wrong number is worse than no number once it is ratcheted.
 * `perf-budgets.json` names the metric `lighthouse_tti_ms`; this is that.
 *
 * Lighthouse's default mobile preset is used unmodified: 4x CPU slowdown, a
 * simulated slow-4G link, and a phone viewport. Overriding any of it would
 * produce a second, easier P20 — the same trap `dnd-ci` exists to avoid for the
 * drag budget.
 *
 * SIMULATED, not applied (`throttlingMethod: 'simulate'`, Lighthouse's default).
 * The observed trace is replayed over a modelled network and CPU graph, which is
 * why the spread across runs is tens of milliseconds rather than hundreds. It
 * does NOT make the number machine-independent: the observed task durations are
 * this machine's, multiplied by four. See the note on the P20 row.
 */

/** What the spec asserts against. Lighthouse reports far more; these are the three §8.1 cares about. */
export interface TtiSample {
  readonly ttiMs: number
  readonly fcpMs: number
  readonly tbtMs: number
}

/**
 * A session cookie, obtained the way a seller obtains one.
 *
 * Lighthouse drives a browser that has never signed in, and `/board` behind the
 * shell redirects without a session — so an unauthenticated run would measure
 * the login screen and report a beautiful number for the wrong page. The spec
 * asserts the final URL for exactly that reason.
 */
export async function perfSellerCookie(baseURL: string): Promise<string> {
  const body = new URLSearchParams({
    email: PERF_SELLER_LOGIN.email,
    password: PERF_SELLER_LOGIN.password,
  })

  const response = await fetch(`${baseURL}/sign-in`, { method: 'POST', body, redirect: 'manual' })
  const cookies = response.headers.getSetCookie()

  if (cookies.length === 0) {
    throw new Error(
      `perf-500 sign-in returned ${response.status} with no cookie. The fixture seller ` +
        `${PERF_SELLER_LOGIN.email} exists only after the dnd-ci profile has run once.`,
    )
  }

  return cookies.map((c) => c.split(';')[0]).join('; ')
}

export interface TtiRun {
  readonly samples: readonly TtiSample[]
  readonly finalUrl: string
}

/**
 * Runs Lighthouse `times` over the same Chrome and returns every sample.
 *
 * ONE Chrome for all runs: launching it is seconds of the budget's wall clock
 * and Lighthouse clears state between runs anyway. The MEDIAN is taken by the
 * caller — never the mean, which one slow run drags, and never the best, which
 * is how a budget quietly stops being a budget.
 */
export async function measureTti(url: string, cookie: string, times: number): Promise<TtiRun> {
  const chrome = await launch({
    // Playwright's Chromium rather than whatever this machine has installed.
    // The e2e suite is already pinned to it, and a budget measured against two
    // different browser builds on two different machines is two budgets.
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox'],
  })

  try {
    const samples: TtiSample[] = []
    let finalUrl = ''

    for (let i = 0; i < times; i++) {
      const result = await lighthouse(
        url,
        { port: chrome.port, output: 'json', logLevel: 'error' },
        {
          extends: 'lighthouse:default',
          settings: {
            onlyAudits: ['interactive', 'first-contentful-paint', 'total-blocking-time'],
            extraHeaders: { Cookie: cookie },
          },
        },
      )

      if (result === undefined) throw new Error('lighthouse returned no result')
      const audits = result.lhr.audits
      finalUrl = result.lhr.finalDisplayedUrl

      samples.push({
        ttiMs: numeric(audits, 'interactive'),
        fcpMs: numeric(audits, 'first-contentful-paint'),
        tbtMs: numeric(audits, 'total-blocking-time'),
      })
    }

    return { samples, finalUrl }
  } finally {
    // Windows holds the profile directory open often enough that this throws
    // EPERM while the measurement itself succeeded. Killing the browser is
    // cleanup; letting it fail the run would turn a temp-directory quirk into a
    // red performance gate, which is how a gate gets deleted.
    try {
      // Not awaited: chrome-launcher's kill is synchronous and returns void.
      chrome.kill()
    } catch {
      /* the process is gone either way */
    }
  }
}

/** The median. Even counts take the lower middle, which is the pessimistic half. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted[Math.floor((sorted.length - 1) / 2)]
  if (middle === undefined) throw new Error('median of nothing')
  return middle
}

function numeric(audits: Record<string, { numericValue?: number }>, id: string): number {
  const value = audits[id]?.numericValue
  // A missing audit is Lighthouse having moved, not a fast page. `interactive`
  // stopped counting toward the performance score in Lighthouse 10 and still
  // exists as an audit; if a future major finally removes it, this refuses
  // instead of measuring `undefined` and passing.
  if (typeof value !== 'number') {
    throw new Error(
      `lighthouse reported no numeric value for "${id}". The audit was removed or renamed; ` +
        `P20 names this metric explicitly and must be re-defined rather than skipped.`,
    )
  }
  return value
}
