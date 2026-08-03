-- The fixed card height stops being a number in a CSS file.
--
-- Ruling N17 fixes it at 120px desktop / 156px mobile, and it is the number
-- this document has argued about most: `04b` §3.6 P6 said 108/92, §2's mock
-- still draws 112, and §0.4 row 7 struck both because §1's row budget proves
-- the mandated anatomy does not fit the smallest proposal. Three numbers for
-- one geometry, which is exactly the class of drift a `pinned` arm exists for.
--
-- WHY IT IS LOAD-BEARING AND NOT COSMETIC. A uniform row pitch is what makes a
-- 500-card column virtualisable, and virtualisation is what makes P6's 60 fps
-- and the LCP budget reachable at all. A card that grows by one row because
-- somebody added a chip does not look broken — it silently costs the drag gate
-- its headroom, on a board a seller uses all day.
--
-- `pinned`, not `monotonic_*`: neither direction is an improvement here. The
-- number is a decision with a published derivation, so the only legitimate
-- change is a new ruling — and under this arm that means a migration that
-- restates the value, which is a diff with a number in it rather than an edit
-- to a line nobody reads.

INSERT INTO ref.ci_ratchet_name (name, direction, registered_in_migration, rationale)
VALUES
  (
    'ui.card_h_desktop',
    'pinned',
    '0024_card_height_ratchet',
    'Fixed kanban card height on desktop, ruling N17. Pinned because a uniform column pitch is what makes 500 cards virtualisable and P6 reachable; 04b carried three different numbers (108, 112, 120) before N17 struck the first two.'
  ),
  (
    'ui.card_h_mobile',
    'pinned',
    '0024_card_height_ratchet',
    'Fixed kanban card height on mobile, ruling N17. A separate name because 44px targets and mobile type need 156px for the same four rows — one name for two geometries is how the two silently converge.'
  )
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- `WHERE NOT EXISTS`, like 0023: probing an append-only table writes to it, and
-- a re-run that inserted a second row would be a second measurement nobody made.
INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT 'ui.card_h_desktop', 120, '0024_card_height_ratchet'
WHERE NOT EXISTS (SELECT 1 FROM ref.ci_ratchet WHERE name = 'ui.card_h_desktop');
--> statement-breakpoint

INSERT INTO ref.ci_ratchet (name, value_num, set_by_run)
SELECT 'ui.card_h_mobile', 156, '0024_card_height_ratchet'
WHERE NOT EXISTS (SELECT 1 FROM ref.ci_ratchet WHERE name = 'ui.card_h_mobile');
