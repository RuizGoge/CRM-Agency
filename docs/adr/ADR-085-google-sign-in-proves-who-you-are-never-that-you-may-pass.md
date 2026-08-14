# ADR-085 — Google sign-in proves who you are, never that you may pass

**Status:** proposed (2026-08-13). Reverses part of `05-architecture.md` §1273's cut, on Jorge's decision of the same day. **Not built** — blocked on the Google Cloud OAuth client, which only Jorge can create.

## Context

The product cannot onboard anybody. `app_user` has writers for role and access (0072) but none for creation, because a signable-in account needs `auth.api.signUpEmail` and, with transactional email out of the MVP, there is no invitation to send.

Jorge's ruling of 2026-08-13: **Google login first, transactional email after.** With Google there is nothing to send — the admin records who may enter, and Google proves the person is who they claim.

`05-architecture.md` §1273 cut "no self-signup, no SSO, no OAuth". The SSO half of that is what this reverses. **Self-signup is not reversed and must not become reachable as a side effect** — which is the entire subject of this ADR.

## What already holds, and it is more than expected

`app.resolve_identity(auth_user_id)` — the bridge from a better-auth session to a tenant and an `app_user` — already requires:

```sql
WHERE u.auth_user_id = p_auth_user_id
  AND u.deactivated_at IS NULL
```

So a Google user with no `app_user` row resolves to **nothing**: no tenant, no scope, no session context, and every RLS policy in the schema answers zero rows. **The fail-closed direction is already the default.** Adding Google does not open a door; it adds a way to arrive at one that is already locked.

## The decision

**Google authenticates. The `app_user` row authorises. They are separate facts and the second one is never derived from the first.**

1. **The admin creates the `app_user` row first**, carrying the person's email and `auth_user_id IS NULL`. This is the existing onboarding act, and it stays an admin act.
2. **On first Google sign-in**, a linking step binds the new better-auth user id to the waiting row — and only if a row is waiting.
3. **If no row is waiting, the sign-in resolves to nothing.** The person is authenticated and unauthorised, which is correct and must also be *legible*: the screen says access has not been set up, rather than failing blank.

### The linking step is the whole security surface

🔴 **The link MUST be a SECURITY DEFINER, and `crm_app` must not be able to choose its arguments freely.** If a route can point any `auth_user_id` at any `app_user` row, that is an account-takeover primitive: sign in with your own Google account, link yourself to the admin's row, inherit the surfaces that correct the earnings board. The definer must derive both sides rather than accept them:

- the **auth user id** from the established better-auth session, never a parameter the caller supplies;
- the **`app_user` row** by matching the email Google asserts, never an id the caller names.

### Four conditions on the match, and each closes something specific

- **The Google email must be verified.** Google reports `email_verified`; an unverified address is a claim about an address, not proof of it, and matching on it would let somebody register an unverified Gmail bearing a seller's address.
- **Exactly one waiting row**, and it must have `auth_user_id IS NULL`. A row already linked is not re-claimable — otherwise a second Google account matching the same address takes the seat.
- **Not deactivated.** `resolve_identity` already refuses these; refusing at link time too means a departed seller cannot quietly re-link.
- **One shot.** Once `auth_user_id` is set, that row is spoken for. Re-linking is an admin act with an audit row, not a login side effect.

### What must NOT be built

- **No row creation on sign-in.** A `signIn` that creates the `app_user` row when none matches is self-signup through the back door, which is exactly what §1273 cut. The absence of a row is the refusal.
- **No domain allow-list as the primary gate.** "Anybody at `@theagency.com` may enter" is a rule about an email provider, not about this tenant's roster, and it grants access to people the admin never recorded. The roster is the gate; a domain check would at best be a second, weaker one.
- **No linking by name, and no fuzzy match.** Exact, case-folded email or nothing. `app_user.email` is already `citext` with a unique index per tenant.

## Consequences

- **Password sign-in stays.** Both paths land on the same `resolve_identity`, so the authorisation story is one story. Nobody who already signs in loses anything.
- **The orphan case is real and needs a screen.** A person who signs in with Google and has no row leaves a better-auth user behind with nothing attached. That is harmless — it grants nothing — but the screen must say so plainly, and the orphan should be cleanable.
- ~~**`app_user.auth_user_id` must be nullable**~~ — **wrong, and corrected on 2026-08-13**: it was already nullable. Checked against the engine rather than assumed.
- ✅ **The admin create-user surface exists (0073).** It writes the row with `auth_user_id` NULL, and `user-create.test.ts` asserts against the real `resolve_identity` that such a row answers no session. The reservation half of this ADR is built; the claiming half is what waits on the OAuth client.
- **MFA is untouched.** `05c` C11's ruling rests on transactional email, not on SSO, and email is not arriving in this step. It is revisited when email lands, not here.
- **Google outages become sign-in outages** for whoever uses Google. Password sign-in remaining available is the mitigation, and it is a reason not to migrate everybody off passwords.

## Blocked on

The OAuth client in Google Cloud and a verified domain. **Claude does not create accounts or handle credentials**: the Client ID is configuration and can be shared, the Client Secret goes into `.env` by Jorge's hand and is never pasted into a conversation.
