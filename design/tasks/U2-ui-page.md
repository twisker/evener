# U2 — The Evener web panel page (`core/ui/index.html`)

You are designing and building the single-file web page for **Evener (匀杆)**, a routing plugin that sends delegated coding tasks from a host AI harness (Claude Code) to the cheapest capable target harness (Codex CLI, DeepSeek Harness `dsh`, or the host itself), records cost/time/quality per task, and compares routing policies. Read `design/spec-v1.md` §13 (the page's contract: routes and JSON shapes) and §9 (what the report measures), `README.md` for the product framing, and `adapters/claude-code/.claude-plugin/icon.svg` for the existing visual identity (whiffletree mark).

## Deliverable

One file: `core/ui/index.html`. Nothing else may be created or modified. No external resources of any kind (no CDN, no web fonts, no images other than inline SVG). Vanilla HTML/CSS/JS; no framework, no build step. Must open directly from a server that serves it at `/` with the API under `/api/*` on the same origin.

Because the server task is built in parallel, the page must also run standalone: when the URL has `?mock=1`, use built-in mock data shaped exactly like spec §13 (include at least: 3 open tasks, one of them `dispatching` for 20 minutes to show the orphan highlight, 12 closed tasks across `dsh`/`codex`/`host`, two arms `A`/`B` with one `insufficient` stratum, 2 sessions) and a mock `change` tick every 5 s. Reviewers will open `file:///…/core/ui/index.html?mock=1` first.

## Views (tabs in a top bar; the hash `#live|#task/<id>|#compare|#sessions` selects the view and survives reload)

1. **Live · 实时** — table of open tasks from `/api/tasks?state=open`: label chip, target, model (short id), round, running time (live-ticking from `started_ts` when `state == dispatching`), state dot. A row is flagged *orphan* (amber) when `running_ms` exceeds 900 000 ms. Clicking a row opens the Task view; the selected task's output tail (`/api/task/:id/output?round=<current>&tail=4096`) is shown in a monospace pane that refreshes on each `change` event, scrolled to the bottom unless the user scrolled up.
2. **Task · 回放** — header (label, language, time bucket, has_repro, cross_file, arm, policy version, totals), then one card per round: ✓ accepted / ! error, timeout, rejected / · otherwise; inside: target → decision (`decided_by`, `rule_id`, rationale), cost with `pricing_period` badge (peak/off/flat), wall with a two-segment bar model vs tool time when both non-null, usage (input / cached / output / reasoning), verdict + reject reason + checks as small pills, `self_accepted` badge when true, buttons for output and stderr (fetched on demand into a drawer). Events list collapsed at the bottom (type, ts).
3. **Compare · 对比** — from `/api/report?since=&by=`: controls for `since` (7d / 14d / 30d / all) and `by` (label / language / time_bucket / has_repro / cross_file). Arms table (n, accepted, CPAT, quality, 性价比, mean cost, mean wall, insufficient). Comparison line (ratio, CI, p, MDD) when two arms exist. Strata as grouped horizontal bars (hand-drawn SVG, one group per stratum key, one bar per arm, value = CPAT; `insufficient` cells drawn hatched with the label "样本不足 / insufficient"). Target profiles table. Alerts and suggestions lists.
4. **Sessions · 会话** — from `/api/sessions`: one row per session: id (short), host, first/last time, tasks/accepted/open, a stacked bar delegated / host rounds / acceptance / overhead (four colours, legend once), peak vs off share as a thin second bar, targets used as chips. Clicking filters the Live/Task lists to that session (`host_session=`).

## Behaviour

- Connect `EventSource('/api/stream')`; on `change`, refetch the current view's data. If the stream errors, fall back to polling every 5 s and show a small "polling" indicator.
- Numbers come only from the API. The page never computes CPAT, means or statistics; it may compute percentages for bar widths and format units.
- Formatting: USD with 4 decimals below $0.01, else 2 (`$0.0008`, `$1.25`); durations as `42 s`, `3 m 12 s`, `1 h 04 m`; tokens with thousands separators; timestamps in the browser's local time, relative ("3 m ago") in Live.
- Bilingual labels in the form "Live · 实时", like the markdown report.
- Light/dark via `prefers-color-scheme`, colours as CSS custom properties on `:root`. Works at 390 px width (tabs scroll, tables become cards or scroll horizontally). Respect `prefers-reduced-motion`.
- Keyboard: tabs reachable by Tab, rows are buttons, `Esc` closes the output drawer.
- Errors from the API render inline in the affected panel, never as `alert()`.

## Visual direction

Calm instrument panel, not a marketing page. One accent colour drawn from the icon; state colours: accepted green, running blue, orphan amber, error red, insufficient hatched grey. Dense but legible: 13–14 px body, tabular numerals for money and time. Keep total file size under 120 KB.

## Done means

Open with `?mock=1` and every view renders without console errors; resize to 390 px and nothing overflows horizontally; toggle OS dark mode and contrast stays readable. Report what you built in a short plain-text summary (sections, any contract field you could not render and why). Do not run `npm test`, do not touch any other file.
