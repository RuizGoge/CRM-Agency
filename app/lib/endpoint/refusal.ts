/**
 * Matching a database refusal code against the error a query actually throws.
 *
 * 🔴 THE NAIVE VERSION IS WRONG AND LOOKS RIGHT. Our definers raise coded
 * exceptions — `UR003`, `LA004`, `WE005` — and a route turns the code into a
 * sentence a person can act on. But drizzle does not rethrow the Postgres
 * error: it wraps it in a `DrizzleQueryError` whose own `message` is
 * *"Failed query: SELECT app.app_user_set_role(…)"*. The code lives one level
 * down, on `cause`.
 *
 * So `error.message.includes('UR003')` never matches, every refusal falls
 * through to the generic rethrow, and the seller or admin gets **500 Unexpected
 * Server Error** instead of "say why the role is changing". The route looks
 * correct, the definer is correct, and the only thing that is wrong is the
 * sentence nobody receives.
 *
 * ⚠️ IT WAS SHIPPED TWICE BEFORE BEING FOUND, and the reason is worth keeping:
 * the tests for both surfaces call the DEFINER directly, where the raise
 * arrives unwrapped and every assertion passes. Only driving the real HTTP
 * route surfaces it. That is the same shape as 0069's STOP chain — proved, and
 * never proved along the path a person actually takes.
 */

/** Every message in the `cause` chain, joined. Bounded so a cycle cannot hang. */
function messageChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error

  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    // A non-Error link in the chain. Only strings can carry a code, and
    // stringifying an object here would append "[object Object]" — noise that
    // could never match and that the linter is right to refuse.
    if (typeof current === 'string') parts.push(current)
    break
  }

  return parts.join(' | ')
}

/**
 * The first refusal code present anywhere in the error chain, mapped to its
 * sentence. `null` means this was not a refusal we named — which the caller
 * must rethrow rather than report as the user's mistake.
 */
export function refusalSentence(
  error: unknown,
  refusals: ReadonlyMap<string, string>,
): string | null {
  const chain = messageChain(error)
  for (const [code, sentence] of refusals) {
    if (chain.includes(code)) return sentence
  }
  return null
}
