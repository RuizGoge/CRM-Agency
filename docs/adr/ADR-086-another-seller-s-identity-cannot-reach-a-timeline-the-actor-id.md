# ADR-086 — ADR-G8 — Another seller's identity cannot reach a timeline: the actor id is a column, is revoked, and free-form JSON cannot carry it

**Status:** accepted (Phase 5, pending GATE 5)

## Context

R3.5 forbids rendering another seller's identity in a seller-facing timeline. After an ownership repair the timeline rows legitimately belong to the new owner, so RLS passes and the owner-scoped not-found machinery never engages — the leak renders as a name on the screen with a perfectly healthy-looking system. Worse, timeline_entry has no actor column at all; it has render_payload jsonb, and a name inside free-form JSON cannot be classified, revoked or seen by any catalog gate.

## Options considered

_(see Context; the rejected alternative is named inline)_

## Decision

Promote the identity to a real actor_user_id column and add CHECK (NOT render_payload ?| ARRAY['actor_name','actor_display_name','actor_initials','actor_avatar_url','actor_user_id']) so the engine refuses the jsonb form. timeline_entry_live omits the column and new gate S17 asserts crm_app holds no column privilege on it. app.timeline_read() returns actor_label_key, with 'timeline.actor.previous_owner' mapped to the locked catalog string 'Handled before this record moved to you'. Assertion R2-7 checks the network response body, not only the DOM.

## Consequences

Positive: 'you cannot leak a column the view does not contain' is applied to the second place it is needed; the supervisor path still works through the definer and still writes book.viewed. Negative: render_payload becomes a schema-validated structure per timeline kind rather than a free-form bag, which is more generator work and less room for a quick UI addition.
