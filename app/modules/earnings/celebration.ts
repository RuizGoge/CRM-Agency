/**
 * The celebration token, and why it is a class rather than an object.
 *
 * Ruling P2.5: "once per opportunity, forever" and "not replayed if the tab
 * closed" are a database predicate and a NON-SERIALIZABLE TYPE, not client
 * discipline. `app.celebrate_once` is the predicate. This is the type.
 *
 * It crosses the wire once, as a plain payload, and is WRAPPED in this class on
 * arrival. From that point it cannot be put in a persisted cache, a cookie,
 * `localStorage` or a client-side store, because `JSON.stringify` on it THROWS
 * rather than quietly producing `{}` — which is what a plain object would do,
 * and a silently-empty token is how a reload three hours later fires confetti
 * for a sale nobody just made. The constraint is on PERSISTING it, not on
 * transmitting it.
 *
 * `toJSON` is the hook `JSON.stringify` calls; throwing from it is the only way
 * to make serialisation a runtime failure rather than a lossy success. The
 * assertion that it throws lives in the test suite, so this is a mechanism and
 * not a comment.
 */
export class CelebrationToken {
  readonly opportunityId: string
  readonly contactName: string
  /** Whole cents, as a string, like every other money value crossing a boundary. */
  readonly annualCents: string

  constructor(opportunityId: string, contactName: string, annualCents: string) {
    this.opportunityId = opportunityId
    this.contactName = contactName
    this.annualCents = annualCents
  }

  toJSON(): never {
    throw new TypeError(
      'CB002: a CelebrationToken is not serialisable. It lives in the memory of the page that won, and nowhere else.',
    )
  }
}
