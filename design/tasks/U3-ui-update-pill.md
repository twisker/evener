# U3 — Update pill in the Evener web panel + sub-second durations

You are editing one file: `core/ui/index.html`, the single-file page of **Evener (匀杆)**. Read `design/spec-v1.md` §13 first (the contract) and the existing page (its mock mode `?mock=1`, the top bar, `formatDuration` or equivalent, the CSS custom properties).

Nothing else may be created or modified. No external resources. Keep the file under 120 KB. Do not run `npm test`.

## 1. Update pill

`GET /api/overview` now returns `update: {current: string, latest: string|null, available: bool, checked_at: string|null}` (the server reads a cache; the page never calls any registry). Render in the top bar, right of the policy/version info:

- Always: the current version as muted text `v0.1.0` (tooltip: `checked_at` in local time, or "未检查 / never checked").
- When `available` is true: a small pill in the accent colour, `↑ v0.2.0 · 可更新 / update`, keyboard-focusable (it is a `<button>`), whose click opens a tiny inline popover (not `alert()`) with the two commands, each on its own line, copyable by selection:
  ```
  claude plugin update evener@evener
  /plugin → Marketplaces → evener → Enable auto-update
  ```
  `Esc` or clicking outside closes it. `prefers-reduced-motion` respected (no animation).
- When `update` is absent or malformed (older server): render nothing new and log nothing.
- Mock mode: `update: {current: "0.1.0", latest: "0.2.0", available: true, checked_at: <now − 3 h>}`.
- Refetch overview on each `change` event as today; the pill updates accordingly.

## 2. Durations below one second

Durations under 1 000 ms currently render as `0 s`. Render `< 1 s` for 0 < ms < 1000, `0 s` only for exactly 0, and keep the existing `42 s` / `3 m 12 s` / `1 h 04 m` forms above one second. Apply everywhere the duration formatter is used (round cards, live table, session rows, bar labels).

## Done means

Open with `?mock=1`: the pill shows, popover opens and closes by keyboard; a round with `wall_ms: 400` in mock data shows `< 1 s`; no console errors; nothing overflows at 390 px; light and dark both readable. Report in a short plain-text summary: what you changed, the final file size.
