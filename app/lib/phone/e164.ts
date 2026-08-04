/**
 * Phone normalisation, US-only, in a module with no server dependencies.
 *
 * §7's recovery flow turns on this working: a 937 number rings a seller's
 * handset, she types it however she reads it off the screen — `937-555-0142`,
 * `(937) 555-0142`, `9375550142` — and the search has to find the one contact
 * whose `phone_e164` is `+19375550142`. A search that matched the typed text
 * would find nothing while the phone was still ringing.
 *
 * NORMALISATION IS NOT VALIDATION and the two are separated on purpose. This
 * answers "what E.164 number could the seller have meant"; the database's
 * `contact_phone_is_e164` CHECK is what decides whether a number is storable.
 * A search that refused a malformed query would be a search that punished a
 * typo instead of returning nothing.
 *
 * US-only, stated rather than assumed: every lead in this product is a US
 * consumer sold as a Final Expense lead, the calling-window rules are US
 * state rules, and 10DLC is a US registration. The day that stops being true,
 * this function is where it stops.
 */

/** `+1` and ten digits — the only shape `contact_phone` stores today. */
const US_NATIONAL_DIGITS = 10

/**
 * The E.164 form of what a seller typed, or `null` if it cannot be one.
 *
 * `null` is a real answer and not a failure: it means "this query is not a
 * phone number", which is how the caller knows to search names and emails
 * instead of returning nothing.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  // A leading `+` is the seller pasting something already normalised. Keep the
  // digits after it and trust the shape check below.
  const explicit = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')

  if (digits === '') return null

  if (explicit) {
    // Already international. Nothing to infer, so the only question is whether
    // it is long enough to be a number at all.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  }

  if (digits.length === US_NATIONAL_DIGITS) return `+1${digits}`

  // `1` plus ten digits — how a US number is read aloud and how it arrives
  // from a dialler's history.
  if (digits.length === US_NATIONAL_DIGITS + 1 && digits.startsWith('1')) return `+${digits}`

  return null
}

/**
 * Does this query look like the seller is reaching for a phone at all?
 *
 * Used to decide whether a PARTIAL number is worth matching as a suffix. Four
 * digits is the shortest thing anybody types meaning a phone — the last four
 * of a number they half-remember — and below that "555" is far more likely to
 * be part of a name or a street.
 */
export function looksNumeric(input: string): boolean {
  const digits = input.replace(/\D/g, '')
  return digits.length >= 4 && digits.length / input.trim().length > 0.5
}
