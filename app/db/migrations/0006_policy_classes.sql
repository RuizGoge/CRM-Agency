-- `policy_class` stops being an ENUM.
--
-- Not a workaround — a defect removed. `ALTER TYPE ... ADD VALUE` may run
-- inside a transaction on PostgreSQL 12+, but the new label cannot be USED
-- until that transaction commits, and drizzle-kit applies every pending
-- migration in ONE transaction. So the shape "one migration adds a class, the
-- next classifies a table with it" is unrunnable, and it fails at DEPLOY —
-- after review, on the one path nobody watches.
--
-- That is precisely the failure mode this project cannot absorb: a migration
-- written by a model, merged without a human reading the diff, that works in
-- every test and dies on the deploy that matters.
--
-- As text, adding a class is one line in harden()'s CASE and nothing else.
-- There is deliberately NO CHECK constraint listing the valid classes: that
-- would be a second list to keep in agreement with the first, and harden()
-- already raises HR002 on any class it has no generator for — at deploy time,
-- naming the class. One list, and it is the one that generates the policies.

-- Both CHECKs were compiled against the enum type and compare against enum
-- literals, so they have to come off before the column can change and go back
-- on afterwards.
ALTER TABLE security.table_registry DROP CONSTRAINT IF EXISTS reference_needs_reason;
--> statement-breakpoint
ALTER TABLE security.table_registry DROP CONSTRAINT IF EXISTS owner_scoped_needs_owner_column;
--> statement-breakpoint

ALTER TABLE security.table_registry
  ALTER COLUMN policy_class TYPE text USING policy_class::text;
--> statement-breakpoint

DROP TYPE IF EXISTS security.policy_class;
--> statement-breakpoint

ALTER TABLE security.table_registry
  ADD CONSTRAINT reference_needs_reason
  CHECK (policy_class <> 'reference' OR exception_reason IS NOT NULL);
--> statement-breakpoint

ALTER TABLE security.table_registry
  ADD CONSTRAINT owner_scoped_needs_owner_column
  CHECK (policy_class NOT IN ('owner_scoped', 'append_only_owner')
         OR owner_column IS NOT NULL);
