# Chat-Space Material 3 Expressive design system

This directory is the styling boundary between product features and the visual language.

## Rules

1. Feature components should use semantic color roles (`--m3-*`) rather than hard-coded palette colors for ordinary surfaces and actions.
2. Use the shared `Button`, `Input`, `Textarea`, `Card`, `Surface`, `Chip`, menu, popover, and dialog primitives before adding local styling.
3. New radii should come from the M3 shape scale. Avoid new arbitrary `rounded-*` values unless the shape communicates a unique product state.
4. Motion uses the standard/emphasized/expressive curves in `tokens.css`. Respect `prefers-reduced-motion`.
5. Prefer tonal surface separation over heavy shadows. Elevation 3 is reserved for transient/floating UI.
6. Liquid glass is an accent, not the base language. It is intentionally retained for the composer and transient floating surfaces only.
7. Navigation is adaptive: compact screens use a modal drawer; desktop can collapse to a navigation rail and expand to a permanent drawer.
8. Preserve Radix primitives for keyboard behavior, focus management, and accessibility. M3E is the presentation/system layer above them.
9. Reusable product states (success, info, warning, accent) use `--app-status-*` roles. Feature code must not introduce direct `emerald-*`, `sky-*`, `amber-*`, or `violet-*` palettes for shared states.
10. Composer controls use shared `Chip`/button semantics and `data-testid` hooks only as a migration bridge. New controls should consume the design-system primitives directly.

## Stable semantic roles

- `--m3-surface*`: application and container surfaces
- `--m3-primary*`: primary actions and selected states
- `--m3-on-surface*`: text/icon roles
- `--m3-outline*`: separators and outlines
- `--m3-shape-*`: expressive shape scale
- `--m3-motion-*` / `--m3-duration-*`: transition system
- `--m3-elevation-*`: shared elevation scale
- `--app-status-*`: reusable non-Material product statuses such as success/warning/info

When adding a new feature, extend a semantic role here only if the role is reusable across the product. Do not add one-off design tokens for a single component.

## Migration order

1. shared primitives and tokens
2. adaptive navigation shell
3. composer controls and transient tool surfaces
4. message/status/artifact cards
5. feature pages and empty states
6. remove legacy glass/palette utilities that no longer have consumers

The goal is not merely to resemble Material 3 Expressive. The goal is to make the visual language enforceable at component boundaries so future feature work does not reintroduce layout and styling drift.
