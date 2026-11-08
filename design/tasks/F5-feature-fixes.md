# F5 — Feature extraction fixes

Read `core/src/features.ts` and `core/test/features.test.ts`.

1. `files_mentioned` must be the size of the **union** of normalised `--files` entries and path-like tokens found in the description (normalise: trim, strip leading `./`). Observed: `--files src/a.ts,src/b.ts` with a description naming the same two paths yields 4, which pushes `time_bucket` up a bucket. Add a test for exactly that case (expect 2) and one where the description adds a third distinct path (expect 3).
2. `has_repro` negation guard: a keyword match does not count when, within the 24 characters before it (same line), there is one of `no`, `not`, `without`, `unavailable`, `missing`, `lacks`, `can't`, `cannot`, `没有`, `无`, `缺`, `不能`. Observed false positive: "No reproduction yet, stack trace unavailable" → true. Note `unavailable` comes *after* "stack trace" in that sentence, so also treat a negation word within 16 characters *after* the match as negating. Add tests: that sentence → false; "Steps to reproduce: run x" → true; "复现步骤：…" → true; "没有复现步骤" → false.
3. `npm test` green.
