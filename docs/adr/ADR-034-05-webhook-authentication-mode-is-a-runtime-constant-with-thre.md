# ADR-034 — ADR-SEC-05 · Webhook authentication mode is a runtime constant with three modes, and a signature failure returns 204 with quarantine rather than 401

**Status:** accepted (Phase 5, pending GATE 5)

## Context

ARR-INT-02 states that the corpus never establishes whether Aloware signs its webhooks, retries them, or preserves order, and that the architecture must assume the weakest case until the Sprint-0 spike (Puerta 7) says otherwise. inbound_webhook_event.signature_valid is deliberately nullable and signature_scheme records what was checked. The signed data model has no column for the mode.

## Options considered

(a) Branch on a compile-time environment variable. (b) Add a typed column to tenant. (c) Store the mode in system_constant. Orthogonally, on signature failure: return 401 (provider retries), return 400 (provider may drop), or return 204 and quarantine.

## Decision

Option (c) — system_constant['webhook_auth_mode'].value_text in {'hmac','path_secret','unauthenticated'}, reusing the table whose stated purpose is to hold values that must not drift, with zero schema change and admin visibility. The HMAC, when present, is computed over the RAW REQUEST BYTES with a timing-safe compare and a timestamp replay window, never over a re-serialized object. On signature failure the endpoint returns 204: the payload is vaulted verbatim, inbound_webhook_event.status is set to 'quarantined', a dead_letter row is written and an admin_alert fires, and the payload never reaches the domain. Independently and in every mode, a webhook whose to_number does not match a VERIFIED aloware_number_mapping row is quarantined and therefore can never reach the STOP chain.

## Consequences

POSITIVE: 401 would teach a retrying provider to hammer us for hours, and a signature failure is far more likely to mean our key is stale than that an attacker is present; accepting into the vault while refusing entry to the domain loses nothing (ARR-INT-07) and trusts nothing; the DLQ depth counter on /admin/integration-health makes the condition visible on a screen. The worst case under the weakest posture is bounded by database constraints rather than by the provider's security choices: a forged webhook can fabricate a call or message row on a contact whose number the attacker already knows and can trigger a STOP for such a number, but cannot credit money (CHECK to_stage_type <> 'earning' OR actor_type = 'human'), cannot read anything, and cannot escape the tenant. NEGATIVE: 204 on an invalid signature will look wrong to any reader who does not read the quarantine rule with it, so it must be documented at the endpoint; a forged STOP is a denial-of-service against a seller's book, mitigated but not eliminated by the verified-mapping requirement and by consent_ledger being append-only, so the forgery is provable and reversible by a START row.
