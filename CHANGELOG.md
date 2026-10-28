# Changes

## 2026-10-28

- Refresh the README with one animated demo and a grouped feature guide; keep the page compact and easy to scan.
- Add a shared model center, Magpie catalog discovery, Agent model routes and saved assignment profiles. Keep credentials in their existing encrypted stores.
- Preserve native Claude, Codex and ZCode session protocols, cancellation and startup feedback. Recover failed SSH sends and retain unconfirmed drafts.
- Add target-side workspace operations, accurate Git change counts and immutable turn diffs, with explicit unknown/binary states.
- Add local and SSH resource monitoring with demand-driven sampling, per-host baselines, measured initial CPU/network samples and a two-second update interval. Keep backend RSS and page JS heap explicitly local.
- Unify navigation and control icons, menus, typography and responsive layouts. Make current-session statistics and context capacity easier to reach.
- Separate ordinary input, output, cache reads and cache writes. Preserve standard nested cache-write fields across Chat, Responses and Messages; count observed attempts and retries without replacing missing historical metadata with invented values.
- Support CommonMark parsing, nested/task lists, table escapes, footnotes and relative Markdown document images. Render four TeX delimiter forms locally, preserve code/currency text and batch formula rendering. Keep diagram source, syntax highlighting and exact code copying available.
- Add durable task queues, templates, handoff, event triggers, Git/PR workflows, shared browser controls, speech input and structured Office tools.
- Add a portable Windows launcher, `start-server.cmd`, with runtime/port checks, readiness reporting and console/log output.
- Extend isolated API, SSH, launcher, protocol and UI regression coverage. The registered suite contains 95 scripts; targeted verification does not imply every external provider or CLI has been tested.

### Accounting and measurement limits

Cache hit rate is cache-read tokens divided by all input tokens, including cache writes. Historical calls without usage or cache metadata remain visibly incomplete. Fee estimates use configured model prices and default cache multipliers; they are not provider invoices. Measured stream speed is distinct from a whole-turn estimate and from provider-internal decoder speed.

GPU counters depend on the target's drivers and supported interfaces. Page JS heap is only part of browser memory. Missing counters remain unknown rather than becoming zero.
