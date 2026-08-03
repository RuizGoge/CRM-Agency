-- The UI-loader whitelist becomes a one-way list at the engine.
--
-- `05-architecture.md` §1.2 sanctions exactly ONE loader in the UI tree and says
-- adding an entry is "a PR that touches that file and nothing else, in the same
-- style as the RLS exception list". §11.3 of 05c then reclassifies every list of
-- that style as `shrink_only`, and gives the reason plainly: ADDING an exemption
-- is the loosening, and `frozen_set` had the arm backwards.
--
-- So the set is registered here with the arm that refuses growth. Removing a
-- loader — which is the direction this list is supposed to move — stays free.
--
-- The value is the set of routes with a DATA loader today: three, where the
-- ruling sanctions one. That is recorded rather than corrected, because which of
-- the two over-budget loaders to drop is a product decision with a visible cost
-- (the leaderboard's first paint is the demo's opening moment). The engine's job
-- here is only to guarantee the number cannot quietly become four.

INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
VALUES (
  'ui.loader_whitelist',
  'shrink_only',
  '0023_ui_loader_ratchet',
  'UI routes carrying a data loader. 05-architecture.md 1.2 sanctions exactly one (the pipeline); three exist. shrink_only because adding a route is the loosening and removing one is the intended direction of travel.'
)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

INSERT INTO ref.ci_ratchet (name, value_set, set_by_run)
SELECT 'ui.loader_whitelist',
       ARRAY[
         'app/routes/ui/board.tsx',
         'app/routes/ui/leaderboard.tsx',
         'app/routes/ui/my-day.tsx'
       ],
       '0023_ui_loader_ratchet'
WHERE NOT EXISTS (
  SELECT 1 FROM ref.ci_ratchet WHERE name = 'ui.loader_whitelist'
);
