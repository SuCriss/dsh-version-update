# Changelog

All notable changes to this plugin. Versions follow semver over the plugin's own
surface: its entry config, its route family, and the settings page it renders.

## [1.1.5] - 2026-09-12

### Fixed

- **An update could be refused by the registry that had just served it.**
  `fetchPublished` tries the configured registry and, when that URL fails at the
  network layer, falls through to a mirror — and reports which one answered. Both
  readers threw that fact away, so the install passed npm the *configured* URL:
  on a machine whose registry is unreachable but mirrored, the panel offered a
  version it had read from the mirror and npm was then asked for it at the address
  that had just timed out, reporting the update as nonexistent. The answering
  registry is now remembered by the host (from both read sites) and read at spawn
  time, so the install goes where the versions came from. Only a registry the host
  itself read can ever be stored, so no request input can steer an npm argument.
- **Any unrelated repaint discarded a half-typed policy form.** The panel built
  the policy prop as a fresh object per render — the derived "next check" hint
  travelled inside it — while the form's reset effect keys on that object's
  identity. A poll landing, a notice timer, or another card's interaction therefore
  replaced whatever the user was mid-way through editing, with nothing changed on
  the host to justify it. The hint is its own prop now and the policy prop is the
  controller's own state object, which changes identity precisely when the host
  answers with a different policy: the one case the effect was meant to see.

### Tests

The suite reaches 145 cases, including a hooks-accurate React stand-in that drives
`PolicyCard` render by render — the draft's survival lives in the interaction
between a state slot and an effect dependency list, and is invisible from the
controller.

## [1.1.4] - 2026-09-12

### Fixed

- **A parked silent update could miss its window and then never wake again.** The
  window timer fired 50 ms BEFORE the opening it was waiting for, and the wake
  re-checked the window against the wall clock in whole minutes — at
  `03:59:59.950` the minute is still 239, so the wake declined the very window it
  existed for and armed nothing further. With a daily `checkAt` the finding was
  retried the next day; without one, it was simply gone. The wake now fires just
  after the boundary, and every way out of it leaves a wake armed: a window that
  moved while the timer sat armed waits for the next opening, and a slot still
  busy (a manual install, or another host holding the machine-wide lock) comes
  back in a minute instead of a day. That busy case with **no** window configured
  was worse — arming a wake for a window that does not exist arms nothing at all.
- **A slow host exit could eat the restart handoff.** The detached helper waits
  for two things in sequence — the old process gone, then the port it held
  released — and both waits shared one deadline. A host that spent most of the
  budget dying left the port wait whatever remained, and when that ran out the
  helper gave up on a handoff that was about to succeed: no replacement at all,
  and the machine stays down until someone starts it by hand. Each wait now gets
  its own budget.
- **A host bound to a wildcard address could be rolled back for being alive.** The
  restart payload carries where the host LISTENED, and `0.0.0.0` / `[::]` are not
  addresses anything can be dialled as; the helper's port probes read that as an
  idle port, so the replacement started over a live server, and with recovery
  armed a healthy new host was rolled back to the previous version for never
  answering a probe that could never connect. Probes now go to loopback whenever
  the bind address is a wildcard, and stay on the real address when it is one.
- **One dropped request ended the panel's follow-up of a running install.** A
  single refused `/status` cleared `busy`, printed the fetch failure as though the
  update itself had failed, and killed the log the user was watching mid-install.
  Misses are now counted (three in a row, reset by any answer). The absence that
  is genuinely not a hiccup — the plugin's host half never mounted — is still
  reported at once, since retrying that only hides it.
- **A restart could be asked for twice, and a request that never answered froze
  the page forever.** The countdown expiring and a click on "Restart now" are the
  same intent arriving twice; the second POST goes to a process already on its way
  out, and the watchdog loop ran twice on one page. In-flight is now state of its
  own, released only when the handoff is refused outright or the wait gives up.
  Requests also carry a deadline, and an aborted one is classified the way a
  dropped connection is — the host may have taken the hint and exited — so the
  page keeps watching instead of declaring a failure it cannot tell from a
  refusal.

### Tests

The relaunch helper has end-to-end coverage for the first time: it is run as a
real process against a real payload (with shortened budgets through a field only
tests write), covering the two budgets, a rollback that fires when a replacement
never answers, a healthy replacement left alone, and the payload being consumed so
a stale file can never relaunch anything later. Suite: 143 cases.

## [1.1.3] - 2026-09-12

### Fixed

- **"Later" in the restart dialog did not defer the restart — the host restarted
  anyway.** The cancel call passed no body, so the browser sent it as a GET, the
  POST-only route answered 405, and the caller's `catch {}` read that as "there
  was nothing pending". A fallback restart the host had armed on its own (policy
  `restart: 'auto'`, or a restart requested from a second tab) stayed armed and
  fired on its own schedule: the machine went into the new version under a panel
  that had just promised it would not. The cancel is now an explicit empty POST,
  the *offered* (not armed) restart defers through the same disarm path, and the
  browser tests' fetch double records request methods — a deferral arriving as a
  GET can no longer pass for one.
- **Install progress could not move off 100 %.** The snapshot copy reported
  `{ phase, files, bytes, ...total }`, spreading the measured TOTAL over its own
  live counts: every tick's `bytes` *was* the total and `totalBytes` never
  arrived at all, so the percentage the panel renders had exactly one value it
  could ever compute. The totals now ride along as their own fields beside the
  live counts, and the contract is asserted against a fresh `measureTree` of the
  very tree being copied.
- **The panel claimed "already up to date" when it could not read the
  registry.** A degraded `/check` answers with `publishedError` and NO channels
  at all, so "nothing is ahead" was an empty list proving nothing — the one claim
  the data could not support, shown in the one sentence users act on. The verdict
  is now a named, testable function that says it cannot tell instead
  (`未能读取发布信息` / "Release information could not be read"), present in both
  dictionaries.
- **One bad `registry` value unmounted the whole plugin.** The registry is
  normalized at mount, and a value that is not an absolute http(s) URL threw out
  of `apply()`: the settings page reported "host routes are not mounted" and sent
  the user to restart a host that was otherwise fine, while the real problem was
  a typo in one field. The entry schema rejects the shape up front (the message
  attaches to the field), and a value that still escapes normalization falls back
  to the default registry with a loud `console.error`. An unwritable state
  directory degrades the same way — persistence fails, the mount survives — and a
  policy now becomes effective only after it is on disk, so memory and disk
  cannot disagree about what is running.
- **The machine-wide update lock could be deleted by a run that no longer held
  it.** Lock records named only their pid, and `release()` removed whatever was in
  the file. A fiber reload leaves the previous runner's child listeners attached,
  so the orphan's late settlement unlocked the lock the NEWER run had taken —
  after which a second host was free to run `npm install -g` against a tree two
  of them were writing. Records carry a token now, and release deletes only while
  it still owns the record; the preparation claim is a monotonic token for the
  same reason, and slot, claim, and lock all go free through one
  identity-checked path.
- **A refused start left the machine locked for an hour.** The lock was acquired
  before the npm CLI and the registry were validated, so every start that never
  spawned anything — a bad `registry`, an install already running — still left a
  lock file behind that other hosts honored until the maximum age (one hour)
  expired. Validation comes first now, and a refusal leaves nothing.
- **Killing a wedged npm freed the tree before npm had stopped writing it.** The
  hard ceiling killed the child and settled the task in the same tick, releasing
  slot and lock while the killed process was still mid-rename. The task still
  reports failed at once (the panel must not keep saying "running"), but the slot
  and the lock stay claimed until the child reports its exit, bounded by a
  five-second grace. `updater.busy()` exposes the wider question anything
  touching the tree has to answer first — a live npm, a snapshot copy not yet
  handed over, or a killed npm not yet reaped — and the post-failure repair pass
  defers on it and on the lock, so it can no longer restore the tree a second host
  is installing into.
- **A snapshot restore could overwrite the tree while an install was writing it,
  and froze the host while doing so.** The panel's restore path took no lock (it
  only checked whether *this* host had a task running) and copied the tree back
  with synchronous recursive IO, blocking the event loop — every route, the
  polling panel, any live session — for its whole duration. Restores now contend
  on the same machine-wide lock an install holds, a contended lock answers 409
  with a retry hint instead of 500, the swap itself runs off the event loop and
  leaves nothing renamed-aside on either outcome, and the route awaits it — a
  reply can no longer announce a rollback that has not happened. A restore whose
  copy fails puts the previous tree back and names the directory it could not
  clear.

The suite covers each of the above (130 cases), and no longer acquires — or is
refused by — the machine-wide lock real hosts share: the updater tests contend on
a temporary file of their own, and the composition tests name their own.

## [1.1.2] - 2026-09-11

### Fixed

- **Silent auto-update (`mode: 'auto'`) now actually fires on its own.** Two
  wiring gaps made the policy unreachable in practice, so every update had to
  be triggered by hand:
  - The scheduler's daily check was a ONE-SHOT timer that never re-armed: even
    with a configured `checkAt`, the scheduled check ran exactly once per host
    process lifetime and then fell silent — the panel kept showing a "next
    check" time that had already passed and would never fire. The timer now
    re-arms itself after every fired cycle, and the fired handle is dropped
    immediately so `nextCheckAt` stays honest while a cycle runs.
  - Every panel check (page load or the check button) bypassed the scheduler
    entirely: the `/check` route read the registry itself and never consulted
    the auto-update decision. With `checkAt` left empty — the default — the
    scheduler literally never ran, so `mode: 'auto'` could not install
    anything, ever. A successful registry read is now handed to the scheduler
    (`consider`), so an `auto` policy decides on every check: it installs
    immediately when no window is configured, or parks the finding for the
    execution window when one is. The composition wires this through; the
    decision failing can never fail the panel's own read.

## [1.1.1] - 2026-09-11

### Fixed

- **Restarting no longer leaves the host console-less, which popped black
  "node.exe" windows around every operation (Windows).** The relauncher used
  `detached: true` for the replacement, which starts it under DETACHED_PROCESS
  — a process with NO console. Everything was fine while that host only
  served pages, but every descendant spawned later without console flags —
  dsh's own subprocess runner per tool call, plugin code, `stdio: 'inherit'`
  spawns — made Windows allocate a fresh console for it, and from a
  console-less parent those allocations surface as visible black windows on
  the desktop, one per operation, until the host was started by hand again.
  The replacement is now spawned with plain `windowsHide` (CREATE_NO_WINDOW):
  it owns a real but hidden console that its whole descendant tree inherits,
  so nothing downstream ever allocates a visible one — the same console state
  a launcher-started host already had. The price is lifetime: Node terminates
  non-detached children when their parent exits, so the relaunch helper now
  stays alive as the replacement's supervisor for the host's whole lifetime
  (invisible, zero-cost) and goes away only when the host exits; POSIX keeps
  the old setsid-and-exit contract. Verified end to end: a restart hands the
  port over, the replacement keeps running under its supervisor, both piped
  and inherit-stdio descendants allocate no console of their own, and killing
  the host takes the supervisor down with it.

## [1.1.0] - 2026-09-10

### Added

- **A machine-wide update lock** (`lib/updatelock.js`). The install slot was
  process-wide but not machine-wide: a desktop shell's host and a terminal
  `dsh web` could run `npm install -g` against the same global tree at once.
  `start()` now acquires a lock file (`%TEMP%\dsh-version-update.lock`) before
  claiming the slot and `settle()` releases it. A lock whose holder is dead,
  older than the hard-timeout ceiling, or unreadable is stolen — a leaked lock
  never blocks updates forever; a live foreign holder turns the second install
  into a clean refusal naming the holding pid.
- **Post-install validation.** `npm exit 0` proves npm finished, not that dsh
  can start. When the install directory is known, the runner now verifies the
  manifest parses, reports the requested version, and `lib/bin.js` exists
  before settling done; a broken tree settles failed so the host wiring
  restores the pre-install snapshot instead of restarting into a dead install.
- **An explicit restart command** for embedders. `createRestarter` accepts
  `restartCommand: { execPath, args, cwd }`, which replaces the inherited
  command line verbatim in the handoff payload — the recommended integration
  for desktop wrappers whose argv is not a plain node invocation. The port
  still comes from the listening address, so the replacement rebinds the
  handed-over port even when the command predates this boot.

## [1.0.8]

### Fixed

- **A slow install is no longer killed into a half-committed global tree.**
  The old 10-minute wall-clock cap stopped npm wherever it happened to be —
  and npm mid-reify holds every replaced package under a retired temporary
  name (`.name-hash`) that is only deleted when the run finishes. A kill at
  that moment left the global installation half-committed (222 retired
  folders under `@deepseek-ai/`, dsh itself possibly renamed away), which
  broke the Web GUI until it was repaired by hand. The 10-minute mark is now
  a SOFT deadline: the log notes the slowness and npm keeps running. Only a
  hard ceiling (`INSTALL_HARD_TIMEOUT_MS`, one hour) stops a run that is
  assumed wedged rather than working.

### Added

- **Half-committed trees are detected and repaired automatically.** A new
  tree-health module scans the installation for npm's retired temporary
  folders and for a damaged dsh manifest. At host mount a damaged tree is
  restored from the newest usable local snapshot (no npm, no network) and
  stale retirements are cleared; retirements younger than ten minutes are
  left alone because they may belong to an npm orphaned by the previous host
  and still reifying. After any FAILED install settles, the same repair runs
  with no age threshold (skipped if a new install has already started). The
  polling routes now carry a `tree` object (`healthy`, `manifestOk`,
  `leftovers`, plus `restored`/`removed`/`errors` after a repair) so the
  panel and diagnostics can see the state.

## [1.0.7]

### Fixed

- **A slow install is no longer killed into a half-committed global tree.**
  The old 10-minute wall-clock cap stopped npm wherever it happened to be —
  and npm mid-reify holds every replaced package under a retired temporary
  name (`.name-hash`) that is only deleted when the run finishes. A kill at
  that moment left the global installation half-committed (222 retired
  folders under `@deepseek-ai/`, dsh itself possibly renamed away), which
  broke the Web GUI until it was repaired by hand. The 10-minute mark is now
  a SOFT deadline: the log notes the slowness and npm keeps running. Only a
  hard ceiling (`INSTALL_HARD_TIMEOUT_MS`, one hour) stops a run that is
  assumed wedged rather than working.
- **The install log appears the moment the install starts.** `start()` used to
  run the rollback snapshot inline: a synchronous full copy of the installation
  (dsh ships tens of thousands of files) blocked the host's event loop, so the
  install route answered only after the copy — often tens of seconds of a
  frozen panel with an empty log. The snapshot and the npm spawn now run in an
  async pipeline after `start()` answers; the single process-wide slot is held
  across the whole preparation window, so a second install still cannot race
  the first. The `beforeSpawn` hook becomes async (`(version, report) =>
  Promise<void>`) and reports progress lines straight into the task log.
- **The rollback snapshot works again.** Snapshots were keyed by the install
  TARGET version while validity, restore, and the recovery path all re-read the
  copied manifest and compare it with the directory name — so every fresh
  snapshot read as damaged and was pruned immediately, leaving the snapshot
  store empty and rollback silently unavailable. Snapshots are now keyed by the
  version of the tree they copy (the running version).
- **npm's quiet stretches no longer read as a hang.** While npm runs, the
  runner measures the installation directory every few seconds and reports the
  extraction climb (`[installing] 42s elapsed · 96.3 MB extracted`), re-arming
  its baseline when the mid-reify reset shrinks the tree.

### Changed

- The snapshot copy moved from blocking `cpSync` to `fs/promises` with a
  progress callback (`createSnapshotAsync` in `lib/snapshot.js`); the
  synchronous `createSnapshot` remains for callers that want the old shape.
- The panel polls a running install every 800 ms (was 1500 ms) and shows a live
  elapsed clock next to the log toggle, so a silent npm phase still visibly
  moves.

## [1.0.6]

### Changed

- **Recent activity shows the three most recent records.** The panel keeps the
  activity list deliberately short — the newest three installs/restores — so
  the card stays compact without an internal scrollbar. The full 50-entry
  audit trail still lives in `history.json`; only the on-page view is trimmed.

## [1.0.5]

### Fixed

- **A dead primary registry no longer blanks the version list.** The registry
  read now falls back to a mirror (`registry.npmmirror.com`) when the primary
  registry fails at the network layer (DNS, connect, TLS, timeout), so a flaky
  or blocked `registry.npmjs.org` behind a slow link still yields the published
  versions instead of degrading the panel to a local-only view. A registry that
  answers with an HTTP error is treated as a real answer and is not bypassed.
- **The check button no longer shows "checking…" twice.** The loading state now
  shows one label on the button plus a small spinner, instead of duplicating
  the text in a second element.

### Changed

- The `check` response now carries `publishedError` as
  `registry unreachable (tried <registries>): <cause>` when every registry
  fails, naming each attempted source.

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
