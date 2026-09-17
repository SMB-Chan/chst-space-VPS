# Chat-Space Human Interface

Visual language follows Apple Human Interface Guidelines: Clarity, Deference, Depth. `--m3-*` names are compatibility aliases.

## Rules

1. Content is the subject. Chrome (nav, composer, sheets) supports it and does not compete.
2. Glass and blur belong on chrome only, never on message bodies or content cards.
3. Primary controls are at least 44×44 pt (`--hig-touch`).
4. Motion explains hierarchy. No overshoot, bounce, or decorative scale. Honor `prefers-reduced-motion`.
5. Prefer hairline separators over elevation. Shadows do not replace structure.
6. Copy is plain, active, and specific. Buttons are verbs. Errors say how to fix. Empty states say what to do next.
7. Use `Button`, `Input`, `Surface`, `Chip`, and Radix primitives before adding local styling.
8. Do not mix Material FAB, equal-weight card dashboards, or display-serif branding into product chrome.
9. Accessibility is a requirement: Dynamic Type via relative units, focus rings, labels on icon buttons, Light/Dark contrast.

## Tokens

- `--m3-surface*`: grouped backgrounds
- `--m3-primary*`: the one primary action
- `--m3-outline*`: hairlines
- `--m3-shape-*`: continuous corners
- `--hig-touch`: 44pt minimum control size
- `--app-status-*`: success / info / warning — never color alone

When proposing UI, name the purpose, the standard control, what you will not build, and how a person cancels.
