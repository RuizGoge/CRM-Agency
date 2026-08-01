---
name: new-component
description: Build a UI component that conforms to the design system with all of its required states. Use whenever a new component is added to app/components or a module's UI. Prevents the two defects that make a CRM feel cheap — missing states and off-system colour.
---

# Building a component

## 1 · Check it does not already exist

`docs/04b-design-system.md` has the ratified component inventory. If the design system names it, build **that**, not a variant. Two buttons that differ by three pixels is how a product starts to feel unmade.

## 2 · The four states are the component, not decoration

Empty · loading · error · no-permission. A component that renders only its happy path is not done. The empty state teaches the first action; it does not apologise.

## 3 · Tokens only

- Read the **semantic** layer: `--color-*`, `--space-*`, `--type-*`, `--radius-*`. A `--p-*` primitive outside `app/styles/tokens/` is a defect.
- No hex, no magic number, no hardcoded breakpoint or duration.
- Money figures carry the money type style — tabular figures, always.
- Amber 400 is fill only. Violet is the celebration and nothing else.

## 4 · Interaction

Optimistic where it is safe, with undo instead of a confirmation dialog — and **a visible message when the server disagrees**. Skeletons after the delay threshold, never a spinner. Autosave debounced and hard-flushed on blur, close, route change and page hide.

## 5 · Accessibility is a gate, not a polish pass

Semantic elements before ARIA · focus visible and replaced rather than removed · operable by keyboard alone · 44px targets below the density boundary · contrast from the published matrix · motion reduced under the OS preference **without removing feedback** — a seller who asked for less motion still needs to know the card moved.

## 6 · Test

Render each of the four states · keyboard path · the money format if it displays money · no `--p-*` reference.

## Done when

`npm run verify` green · `i18n-checker` passes · `ux-reviewer` passes.
