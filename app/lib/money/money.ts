/**
 * MONEY — the branded type, and the only place in the codebase allowed to do
 * arithmetic on it.
 *
 * Why this file exists at all (docs/05-architecture.md §0.2 and Part I):
 * TypeScript has no native exact decimal. That is the single real structural
 * disadvantage of the signed stack against the runner-up, and it was accepted
 * on the condition that four mechanical layers replace what the language does
 * not give:
 *
 *   (a) money is `bigint` CENTS, never a float, never a `number`;
 *   (b) an ESLint rule breaks the build on `Number(`, `parseFloat(` or
 *       `Math.round(` anywhere outside this directory (see eslint.config.js);
 *   (c) the database column type is `numeric`/`bigint` and the app role has no
 *       UPDATE privilege on the premium columns — edits go through a definer
 *       that appends to the ledger in the same transaction;
 *   (d) a CI test fails if any monetary field is typed as a plain `number`.
 *
 * The failure this prevents is specific and silent: a float multiplication in
 * the annualisation path puts $2,999.88 on a public leaderboard instead of
 * $3,000, every test stays green, and nobody notices until a seller argues
 * about their commission.
 */

declare const brand: unique symbol

/** Cents. Always an integer. Never a float, never a `number`. */
export type Money = bigint & { readonly [brand]: 'Money' }

export class MoneyError extends Error {
  override readonly name = 'MoneyError'
}

/** The product's guard rails, in cents: $1 to $100,000. */
const MIN_CENTS = 100n
const MAX_CENTS = 10_000_000n

function brandCents(cents: bigint): Money {
  return cents as Money
}

/** Strip the brand for arithmetic. Private to this module by design: the brand
 *  exists precisely so no other file can reach the raw value. */
function raw(value: Money): bigint {
  return value
}

/** Build Money from whole cents. The only constructor that touches a bigint. */
export function fromCents(cents: bigint): Money {
  return brandCents(cents)
}

/**
 * Parse user input — the ONLY entry point from the outside world.
 * Accepts `1200`, `1,200`, `$1,200.50`. Rejects anything with sub-cent
 * precision rather than rounding it: rounding money is a domain decision and
 * this function is not authorised to make one.
 */
export function parseUserAmount(input: string): Money {
  const cleaned = input.trim().replace(/[$,\s]/g, '')
  if (cleaned === '') throw new MoneyError('Enter an amount.')

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) throw new MoneyError(`Not a valid amount: "${input}"`)

  const [, sign, whole, frac = ''] = match
  const cents = BigInt(whole ?? '0') * 100n + BigInt(frac.padEnd(2, '0'))
  return brandCents(sign === '-' ? -cents : cents)
}

/** Read a Postgres `numeric` — which the driver hands back as a string. */
export function fromNumericString(value: string): Money {
  return parseUserAmount(value)
}

/**
 * Cross the JSON seam. Money leaves the server as a STRING of whole cents and
 * is never a JS `number` on the wire: `JSON.parse` would silently widen a large
 * bigint into a lossy double.
 */
export function toWireString(value: Money): string {
  return value.toString()
}

export function fromWireString(value: string): Money {
  if (!/^-?\d+$/.test(value)) throw new MoneyError(`Not a wire amount: "${value}"`)
  return brandCents(BigInt(value))
}

/**
 * Monthly premium to annual. This is the D2 gate's whole reason for existing:
 * Final Expense is sold monthly, Earnings are annual, and without the ×12 the
 * public board is wrong by a factor of twelve.
 *
 * Exact by construction — integer cents times 12 cannot drift.
 */
export function annualize(monthly: Money): Money {
  return brandCents(monthly * 12n)
}

export function add(a: Money, b: Money): Money {
  return brandCents(a + b)
}

export function subtract(a: Money, b: Money): Money {
  return brandCents(a - b)
}

export function negate(value: Money): Money {
  return brandCents(-raw(value))
}

export function sum(values: readonly Money[]): Money {
  return brandCents(values.reduce<bigint>((acc, v) => acc + v, 0n))
}

export function isZero(value: Money): boolean {
  return value === 0n
}

/** Deal-value guard rail. Enforced again by a CHECK constraint in the schema —
 *  this is the friendly copy, not the guarantee. */
export function assertWithinDealRange(value: Money): void {
  const magnitude = value < 0n ? -raw(value) : raw(value)
  if (magnitude < MIN_CENTS) throw new MoneyError('Deal value must be at least $1.')
  if (magnitude > MAX_CENTS) throw new MoneyError('Deal value must be $100,000 or less.')
}

/** en-US display. Grouping and the decimal point are produced here, from
 *  integers — never by handing a float to a formatter. */
export function format(value: Money, options?: { showCents?: boolean }): string {
  const showCents = options?.showCents ?? false
  const negative = value < 0n
  const magnitude = negative ? -raw(value) : raw(value)

  const dollars = magnitude / 100n
  const cents = magnitude % 100n

  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body =
    showCents || cents !== 0n ? `${grouped}.${cents.toString().padStart(2, '0')}` : grouped

  return `${negative ? '-' : ''}$${body}`
}
