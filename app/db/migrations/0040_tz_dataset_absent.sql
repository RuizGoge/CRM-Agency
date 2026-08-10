-- The ZIP timezone dataset is ABSENT, and this migration is what says so.
--
-- §SEC-9 puts the dataset version in `system_constant['tz_dataset_version']`
-- and has /admin/integration-health alert once it is more than twelve months
-- old. Migration 0037 shipped `ref.zip_timezone` deliberately empty -- writing
-- 41,000 rows from memory would be a plausible-but-wrong dataset feeding a hard
-- block -- but nothing anywhere RECORDED that it was empty on purpose.
--
-- That is this project's most-feared shape: a hole that closes because nobody
-- noticed it was open. An empty table looks identical to a table whose seed
-- failed, and the resolver degrades to state-level silently in both cases. The
-- row below makes the absence declared, and
-- tests/integration/tz-dataset.test.ts keeps the row and the table honest with
-- each other in BOTH directions -- seeding the table without updating the row
-- is a red build, and so is claiming a version while the table is empty.
INSERT INTO ref.system_constant (key, value, reason) VALUES
  ('tz_dataset_version', 'absent',
   'DELIBERATELY EMPTY, not a failed seed. SEC-9 rules that ref.zip_timezone may only be generated from redistributable public-domain sources -- Census ZCTA relationship files joined to IANA tzdata -- by a generator that emits its source URLs and their checksums. Until that generator runs, the resolver chain degrades to area code and then to state, and an unresolved chain fails closed. Set this to the dataset version the day the table is seeded; a test refuses to let the two disagree.')
ON CONFLICT (key) DO NOTHING;
