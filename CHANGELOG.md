# Changelog

All notable changes to this plugin. Versions follow semver over the plugin's own
surface: its entry config, its four routes, and the settings page it renders.

## [0.3.0]

Numbered above the published `0.2.1` rather than above `main`'s stale `0.1.1`
manifest, so npm and git agree from here on.

### Fixed

- **The `--port 0` restart refusal now actually fires.** The guard compared
  `webServer.port`, which is the *resolved* port — a host started with
  `--port 0` reports a real number, so the check was dead code. Under
  `--port 0` a restart therefore went ahead: the helper relaunched with the same
  argv, the replacement bound a *different* random port, and the page polled the
  old address until the 90-second timeout, with the old process already gone.
  The decision now reads the port the invocation *requested* out of
  `process.argv`. Both READMEs and the agent-facing guidance had documented this
  protection all along.
- **A completed install prompts for a restart even when the versions cannot be
  compared.** The panel keyed off `stale` (running ≠ installed), so a host whose
  installed version could not be read — an embedder, an unreadable manifest —
  updated successfully and then never asked for the restart that makes the page
  usable again. The status routes now also report `needsRestart`, which is true
  whenever an install finished in this process, because a process cannot swap
  its own module tree.
- **An install now reads the registry the panel read the versions from.** With a
  `registry` configured, the version list came from the mirror while
  `npm install` still fetched from npmjs. The install passes
  `--registry <value>`.
- **Late output from a settled install can no longer land in the next one's
  log.** The stream listeners are detached when a task settles; a killed npm
  keeps draining buffered output.
- **Oversized and malformed request bodies are reported as the client errors
  they are** — 413 and 400 respectively, instead of 500.

### Added

- **A confirmation step before every install.** The action rewrites a
  machine-wide npm package and then ends the host, taking every session,
  background job, and pooled connection with it; it is no longer one click away.
- **A `Config` schema** (`@deepseek-ai/schemastery`), so a mistyped entry field
  fails the load with a named path instead of silently disabling a feature, and
  the settings panel can render a form from it.
- **A diagnosis for the not-yet-mounted host half.** Before the first restart
  after installing this plugin, its routes 404 into the SPA fallback, which
  answers 200 with HTML. The page said `HTTP 200`; it now explains that dsh has
  to restart.
- **`npm run typecheck`** — `tsc --checkJs` over the host half, so the JSDoc the
  sources already carry is a real constraint. Nothing is emitted; there is still
  no build step.
- **CI** over Linux and Windows on Node 22.19 and 24, running the type check and
  the suite. Both platforms matter here: npm CLI discovery, the detached helper,
  and waiting for a port to be released all differ.
- Tests for the browser half (99 cases total, up from 60), reached through a new
  `createController` seam: the confirmation, the countdown, the
  reload-surviving watchdog, and the not-mounted diagnosis.

### Changed

- **The auto-restart countdown is 20 seconds, up from 5.** Five seconds was not
  enough time to read the sentence explaining that a restart ends every session
  on the host, let alone decide.
- **The restart overlay earns its `aria-modal`**: focus is trapped in the card,
  Escape runs the dismissing action when one exists, and focus returns to its
  previous owner on close. Its literal colors — unavoidable, since the theme
  plugin may be gone by then — now follow `prefers-color-scheme`.
- The install log follows its newest line, and stops following once the reader
  scrolls up. Task progress is announced via `aria-live`.
- The navigation-marker MutationObserver coalesces into one animation frame. It
  watches `document.body` in a chat application whose message stream mutates
  `characterData` per token.
- The plugin's stylesheet is removed when the fiber disposes, matching the
  reversibility the nav marker already had.
- The announcement section moved from order 215 to 195, inside the documented
  tool-guidance band (100–199).
- npm CLI discovery also probes `npm_config_prefix` and `APPDATA`, covering
  installations the node-adjacent probe cannot see (a custom `--prefix`,
  nvm-windows, a portable node).
- The installation directory is resolved once per process instead of on every
  status poll — once a second while the restart watchdog waits.

## [0.2.1] — published, untagged

Published to npm without a matching git tag or a version bump on `main`; `0.2.0`
was skipped. `main`'s manifest still read `0.1.1`, and `0.2.1`'s `gitHead`
pointed at the `0.1.1` release commit. Recorded here so the gap is not mistaken
for a lost release.

## [0.1.1] — 2025

First tagged release: the settings page, the four loopback routes, the
single-slot install task, and the port-handoff restart.
