/**
 * The endpoint factory.
 *
 * 🔴 WRITTEN BECAUSE `CLAUDE.md` AND `app/routes.ts` BOTH DESCRIBED IT AS
 * ALREADY EXISTING. "Every file goes through the endpoint factory so the
 * generated registry can drive the cache, silo, auth and topology suites" was
 * in the constitution and `grep defineEndpoint` over the whole tree returned
 * nothing. `contracts/protected-list.json` confessed it for DEMO-04 —
 * "The route registry that would drive it does not exist yet" — while the same
 * sentence read, everywhere else, like a mechanism in force.
 *
 * WHAT THIS BUYS, and it is one thing: a route cannot exist without SAYING what
 * it is. Fourteen resource routes each re-derive their own scoping, their own
 * denial shape and their own cache header today, and the only thing standing
 * between a fifteenth and a silo leak is whoever writes it remembering. The
 * audit found the cost already: `my-book.ts` ships a seller's whole book with
 * no `cache-control` at all, and nothing anywhere noticed.
 *
 * THE BRAND IS THE POINT. `descriptor` carries a module-private `unique symbol`
 * that nothing outside this file can produce, so an object that merely LOOKS
 * like a descriptor is not one — the generator's check is identity, not shape.
 *
 * ⚠️ WHAT THIS IS NOT, YET. §964's full form declares fifteen fields and four
 * sibling factories, and rules that the framework's route table is generated
 * FROM the registry rather than scanned alongside it. This is the first: the
 * declaration, the brand, the generated registry, and the build gate. The
 * handlers are NOT wrapped — a descriptor sits beside `loader`/`action` rather
 * than around them — so this cannot yet refuse a bare handler, and the suites
 * check what a route DECLARES against what it DOES rather than enforcing it in
 * the call path. Named here rather than left to be discovered.
 */

/**
 * Nothing outside this module can produce this. That is the whole mechanism.
 *
 * A REAL SYMBOL AND NOT A PHANTOM TYPE, deliberately. A type-only brand makes
 * an unfactored object fail to COMPILE, which is worth having and is not
 * enough: the registry gate has to answer "did this module go through the
 * factory" at runtime, over modules it imports, and a phantom brand is invisible
 * there. Module-private and never exported, so `isEndpoint` is checking
 * identity rather than shape — an object that merely looks like a descriptor
 * cannot pass.
 */
const BRAND: unique symbol = Symbol('endpoint.factory')

declare const brand: unique symbol

/** Which process role serves this. A folded deployment runs all three. */
export type EndpointRole = 'web' | 'ingest' | 'both'

/**
 * Who the response is for, and it is what picks the cache header rather than
 * each route choosing one.
 *
 * `owner` — one seller's rows. `tenant` — agency-wide but still authenticated.
 * `public-ingress` — a provider POST with no session at all.
 */
export type EndpointAudience = 'owner' | 'tenant' | 'public-ingress'

/**
 * The scope the handler runs under. NOT a scope the handler may choose —
 * `app.begin_request` derives the real one from `app_user.role` — this is the
 * scope the endpoint DECLARES it needs, so the suites can tell the two apart.
 */
export type EndpointScope = 'owner' | 'tenant_read' | 'tenant_admin' | 'token' | 'provider'

export type EndpointSurface = 'json' | 'document' | 'stream' | 'ingress' | 'health'

/**
 * How a conditional GET decides it has nothing new to send.
 *
 * NOT OPTIONAL ON A GET, and that is a type-level rule rather than a review
 * comment: the polling floor is the product's only realtime transport, and a
 * GET with no watermark is one that ships a full body every five seconds
 * forever. `none` is available and takes a REASON, which lands in a list a
 * human reads.
 */
export type EtagPolicy =
  | { readonly kind: 'watermark'; readonly channel: string; readonly key: string }
  | { readonly kind: 'custom'; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string }

/**
 * How a repeated non-GET is made to happen once.
 *
 * NOT OPTIONAL ON A NON-GET. The sendBeacon-on-tab-close double delivery is
 * real in this product and already cost a double credit once; a mutation with
 * no answer here is one that has not been asked the question.
 */
export type IdempotencyPolicy =
  | { readonly kind: 'client_key'; readonly field: string; readonly constraint: string }
  | { readonly kind: 'natural'; readonly constraint: string }
  | { readonly kind: 'none'; readonly reason: string }

/**
 * How the silo suite proves this endpoint cannot be read across the wall.
 *
 * ADR-073 makes silo testability a DECLARED, NON-OPTIONAL property of every
 * endpoint rather than a test somebody wrote for the ones they thought of.
 * `none` takes a reason and the reason is read.
 */
export type SiloProbe =
  | { readonly kind: 'foreign-id'; readonly param: string }
  | { readonly kind: 'listing'; readonly canary: true }
  | { readonly kind: 'none'; readonly reason: string }

interface Common {
  readonly path: string
  readonly role: EndpointRole
  readonly audience: EndpointAudience
  readonly scope: EndpointScope
  readonly surface: EndpointSurface
  readonly siloProbe: SiloProbe
  /** Free text, read by a human in the registry dump. */
  readonly summary: string
}

/**
 * A GET. `etag` is required and `idempotency` is meaningless, so the type does
 * not offer it — the shape of the argument is the rule.
 */
interface GetSpec extends Common {
  readonly method: 'GET'
  readonly etag: EtagPolicy
}

/** A mutation. `idempotency` is required; `etag` does not apply. */
interface MutationSpec extends Common {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly idempotency: IdempotencyPolicy
}

/**
 * MFA is required whenever the scope is `tenant_admin`, expressed as a type so
 * that omitting it does not compile.
 *
 * ⚠️ ADR-084 rules MFA is NOT required on admin money endpoints in the MVP, so
 * every admin endpoint today declares `mfa: false` WITH the ruling named. The
 * field exists so that the day the ruling changes, the compiler finds every
 * site instead of somebody grepping for them.
 */
type AdminGuard<S> = S extends { readonly scope: 'tenant_admin' }
  ? { readonly mfa: boolean; readonly mfaReason: string }
  : { readonly mfa?: never; readonly mfaReason?: never }

export type EndpointSpec = (GetSpec | MutationSpec) & { readonly scope: EndpointScope }

/** What `defineEndpoint` hands back. Unforgeable, and inert at runtime. */
export type Endpoint<S extends EndpointSpec = EndpointSpec> = S & {
  readonly [brand]: true
}

/**
 * Declares one resource route.
 *
 * Returns its argument with a brand attached. It does nothing at runtime on
 * purpose: the value of this call is that it HAPPENED and that the argument
 * type-checked. Wrapping the handler would make the factory load-bearing at
 * request time, which is a cost with no matching benefit while the suites can
 * read the declaration directly.
 */
export function defineEndpoint<const S extends EndpointSpec>(spec: S & AdminGuard<S>): Endpoint<S> {
  return { ...spec, [BRAND]: true } as unknown as Endpoint<S>
}

/**
 * Did this value come out of the factory?
 *
 * Identity, not shape. The symbol is module-private, so a hand-rolled object
 * carrying every field with the right types still answers false — which is the
 * difference between a gate and a checklist.
 */
export function isEndpoint(value: unknown): value is Endpoint {
  return typeof value === 'object' && value !== null && BRAND in value
}

/**
 * The cache header an endpoint must send, decided by its declaration rather
 * than by each route.
 *
 * `private, no-store` for everything, and this is the value the tree actually
 * ships: `app/lib/http/conditional.ts:63` argues it "on every one of these,
 * without exception", because these bodies are per-seller by construction and a
 * shared cache serving one seller's book to another is the silo failing outside
 * the database, where no policy can see it.
 *
 * ⚠️ AND IT CONTRADICTS ADR-011, WHICH IS UNRESOLVED AND NOT RESOLVED HERE.
 * The ADR rules a pollable GET is `private, max-age=0, must-revalidate` and
 * NEVER `no-store`, on the grounds that `private` already forbids the shared
 * cache the comment above is worried about, while `no-store` forbids storing
 * the response a 304 exists to avoid re-sending. On the merits the ADR looks
 * right. It is left alone anyway for two reasons: the three polling surfaces
 * demonstrably answer 304s today (`conditional-get.spec.ts`), and the polling
 * floor is what Gate 6 measures — changing the header on every polled surface
 * moves a measured number, which is a ruling and not a refactor.
 *
 * `route-registry.test.ts` counts the divergence instead of hiding it.
 *
 * The audit found `my-book.ts` sending NEITHER value, which is the defect this
 * function exists to make impossible.
 */
export const POLLABLE_CACHE_CONTROL = 'private, no-store'
export const UNCACHEABLE = 'private, no-store'

export function cacheControlFor(spec: EndpointSpec): string {
  if (spec.method !== 'GET') return UNCACHEABLE
  if (spec.surface === 'ingress') return UNCACHEABLE
  return spec.etag.kind === 'none' ? UNCACHEABLE : POLLABLE_CACHE_CONTROL
}
