# Changelog

All notable changes to this plugin. Versions follow semver over the plugin's own
surface: its entry config, its route family, and the settings page it renders.

## [1.0.4]

### Added

- **Check now asks before installing.** Clicking the check button, when the
  check finds a newer version than the installed one, opens the install
  confirmation right away instead of leaving the user to spot the update row.
  The silent page-load check is unaffected.
- **Policy saves report their outcome.** Saving the policy shows a transient
  success or failure notice under the form (dismissed automatically after a
  few seconds), so the user always knows whether the policy was persisted.

## [1.0.3]

### Changed

- **Recent activity no longer stretches the settings page.** The activity card
  caps its list at 260 px and scrolls internally, matching the task log — the
  page layout stays stable however many install records accumulate over months
  of updates, instead of pushing the whole panel past one screen.

## [1.0.2]

### Fixed

- **A manual install whose page died mid-countdown never restarted the host.**
  The handoff to the replacement process was browser-driven end to end: the
  panel polled the settled install, ran its 20-second countdown, and only then
  sent `POST /restart`. But the install had just replaced the very files the
  browser is serving from — npm rewrites `@deepseek-ai/dsh` in place, and the
  hashed asset URLs the open page references disappear with the old tree — so
  the page could go blank (or a refresh 404) before the countdown finished,
  the restart request was never sent, and the host kept running superseded
  code with nobody left to hand the port over. The host now arms its own
  fallback when an install settles under `restart: 'auto'`: the interactive
  countdown gets a 30-second grace (the `MANUAL_RESTART_GRACE_MS` window),
  then the host restarts itself even with no live page. A live panel still
  wins — its `POST /restart` cancels the fallback and hands over immediately —
  and arming is idempotent, so the two paths can never spawn a second detached
  helper that would fight over the port.
- **"稍后 / Later" now actually defers.** Previously the button only hid the
  overlay; the host's unattended restart timer (10 s for policy-driven
  installs) kept running and restarted the host anyway. A new
  `POST /api/dsh-version-update/restart/cancel` route disarms the pending
  fallback, and the panel calls it when the user dismisses an offer or cancels
  a countdown — the update stays installed and waits for a manual restart.

## [1.0.1]

First published 1.x release. 1.0.0 was tagged in the source tree but never
released, so this is the first artifact carrying the rewrite.

### Fixed

- **The settings panel rendered raw dictionary keys** — `policy.title`,
  `badge.current`, `confirm.impact` and their neighbours appeared as literal
  text instead of prose. The host locale runtime resolves a key as one whole
  string (`dict[key]`) and never expands dotted paths, but most `zh`/`en`
  entries were nested objects, so those lookups missed and the runtime fell
  back — by design — to echoing the key. Both dictionaries are now flat dotted
  keys, 105 each with identical key sets. `installDowngrade` and
  `installDowngradeTo` are renamed to `install.downgrade` and
  `install.downgradeTo`, matching what the panel has always requested.
- **Unknown dist-tags and history triggers showed their key**, because
  `t(key, { defaultValue })` is not a form the host runtime understands — its
  `translate` interpolates `{name}` and nothing else. A small `orElse` helper
  now supplies the fallback by comparing against the key the runtime echoes.
- A guard test walks every key the panel asks for — literal calls plus
  interpolated prefixes — against both dictionaries, so a re-nested entry or a
  one-sided addition fails the suite instead of reaching a user.
- CI's Linux legs failed on `resolveNpmCli`'s test, which passed no `env` and so
  read the runner's ambient `npm_config_prefix` — a root the function probes by
  design. The case now passes an explicit `env`.

## [1.0.0]

A ground-up rewrite. Same plugin identity and host/browser shape, a different
product: version management with automation and instant rollback instead of a
manual update button.

### Added

- **Local snapshot rollback.** Every install snapshots the running tree to
  `~/.dsh-version-update/snapshots/<version>/` (metadata-stamped, validated on
  every read) before npm touches anything; restoring is a pure filesystem copy
  that needs neither npm nor network and completes in seconds. Snapshots are
  pruned to `snapshotKeep` (default 5), damaged entries first. Restore rides
  the same confirm + restart flow as an install.
- **Policy engine** persisted at `~/.dsh-version-update/policy.json`, edited
  from the panel via the new `GET|POST /api/dsh-version-update/policy`:
  - `mode: off | notify | auto` — silent auto-update with no human in the loop.
  - `track: {kind:'tag'} | {kind:'line'} | {kind:'pin'}` — follow any dist-tag
    or a caret/tilde version line (stable releases only); pin tracks nothing.
  - `window` — an HH:MM execution window for auto installs; midnight wrap
    supported, out-of-window findings park and install when it opens.
  - `restart: ask | auto` — cancellable countdown vs unattended ~10 s restart.
  - `checkAt` — a daily scheduled check replacing `autoCheckIntervalHours`.
- **Snapshot center routes**: `GET /snapshots` and `POST /restore`
  (`409` while an install runs, `409` naming any unusable target).
- **dataDir entry config** relocating policy/history/snapshots.
- **recoverOnFailedRestart** (default off): when a restarted host never becomes
  reachable, the relaunch helper restores the previous version from its local
  snapshot — replacing v0.x's npm-based rollback, which needed the registry.

### Changed

- The panel is rebuilt around six cards: installation facts, policy form,
  versions, task log, snapshot center, recent activity; history entries now
  record who triggered them (`manual|auto|scheduled`) and restores are marked.
- History no longer derives rollback offers — the snapshot store answers that
  far more reliably; entries stay valid for readers of old files.

### Removed

- **Agent announcements.** `announceToAgent`, the injected capability section,
  and pending-update notices in the model's system prompt are gone; the plugin
  no longer writes anything into agent context.

## [0.4.0]

### Added

- **Release notes on the confirmation card.** Confirming an install now shows
  the target version's GitHub release notes (dsh publishes bilingual bodies
  under `dsh-v*` tags) with a link to the full text, so the decision is made
  against what changed rather than a bare version number. The repository is
  derived from the installed manifest; a version without a release, a disabled
  config (`releaseNotes: false`, the default is on), or any fetch failure all
  render as nothing — the card annotates the decision, it never gates it. The
  new `GET /api/dsh-version-update/notes` route serves this, cached per
  version for an hour, misses included, behind the same loopback fence.
- **Rollback from recorded history.** Every settled install appends one line
  to `~/.dsh-version-update/history.json` (capped at 50 entries); when the
  newest successful entry is exactly the one that produced the on-disk
  version, the panel offers 回滚到 *that origin*. Anything else — a failed
  install in between, another update since — withdraws the offer instead of
  pointing somewhere wrong. A rollback flows through the ordinary confirm
  card, where its older target reads as a downgrade.
- **Opt-in automatic rollback when a restart goes bad**
  (`autoRollbackOnFailedRestart`, default **off**). With it armed, the
  detached relaunch helper waits up to 60 s for the replacement to become
  reachable; if it never does, the helper reinstalls the version the exiting
  process was running and starts a replacement on that, logging every step to
  `restart.log`. Off by default because the recovery reinstall runs while the
  broken replacement may still hold files — most relevant on Windows.
- **Periodic auto-check** (`autoCheckIntervalHours`, default `0` = off). When
  enabled the host polls the registry on that cadence (floored at hourly),
  exposes the verdict through `/check` and `/status`, and — on a discovery —
  registers a pending announcement so the model can surface the finding
  proactively. A fresh process after the update re-evaluates from scratch.
- Also fixed on the way: the "全部已发布版本" card's primary button referenced
  an undefined dictionary key (`updateTo`) and rendered that literal string;
  both dictionaries now carry proper copy (`更新到 {version}` / *Update to
  {version}*).

### Fixed

- **The single install slot is now process-wide.** A config change reloads
  this plugin's fiber, and disposal deliberately leaves a running npm alive —
  but the replacement runner used to see only its own fresh idle state, so a
  second click after a reload would spawn a second npm while the first still
  wrote the global tree. The slot now lives in module state: every runner in
  this process refuses until the orphaned run settles, which its surviving
  close listener still reports.
- **A downgrade is named a downgrade.** The version list always allowed
  installing an older release (that is what a rollback is), but the button and
  the confirmation card called it an update like any other. When the target
  ranks below the installed version, the channel row, the target button, and
  all three parts of the confirmation card now say 降级 / *downgrade*. The
  browser half ranks versions through its own mirror of the host's comparator,
  and a test walks both implementations through the same version matrix so the
  two copies cannot silently disagree.
- **`check` degrades to local facts when the registry read fails.** The route
  used to fail outright (HTTP 500) when npm's registry was unreachable,
  hiding the installed version and install path behind what is a network
  problem. It now answers 200 with those local facts plus a `publishedError`
  reason and no `channels` / `versions`; the panel shows a warning beside them
  instead of flipping into its error state.

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
