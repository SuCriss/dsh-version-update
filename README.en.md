# dsh-version-update

English | [中文](README.md)

The "Version Update" settings menu for the DeepSeek Harness Web GUI — fully rewritten for v1.0. Beyond inspecting and installing any published `@deepseek-ai/dsh` version, this generation turns updating into a **manageable version policy**: silent auto-update, execution windows, a daily scheduled check, dist-tag and version-line tracking, and second-level rollback from local snapshots.

## Features

### Version management (kept, enhanced)

- A top-level "Version Update" settings section showing the installed version and install directory.
- Lists npm dist-tag channels (`latest` / `next`) plus every published version; install or downgrade any of them in one click (downgrade wording everywhere the direction matters).
- The confirm card reads the target version's GitHub release notes (`dsh-v*` tags first) with a link to the full text; failures degrade silently and never block an install.
- One click runs `npm install -g @deepseek-ai/dsh@<exact version>` in the background. Only exact versions are accepted and npm is spawned without a shell, so registry text never reaches a command line.
- **A progress bar, not an endless log.** The panel shows the phase (preparing / snapshot / download / extract / done), a percentage or the bytes seen so far, elapsed time and how long it has been stalled. A phase with no denominator is reported as unmeasurable and shows bytes only — no percentage is invented, and a phase with no signal at all never claims to be stalled. npm's own output moves behind "Show detailed log", collapsed by default.
- **The install source is a choice, and a slow one is replaceable.** The confirm card picks Auto / Official / Taobao mirror. `auto` uses whichever registry actually served the version read (a mirror that answered is remembered). A run that stops moving says so — but npm is **never killed mid-flight** (stopping reify leaves a half-committed tree); once it settles, "Retry with the Taobao mirror" re-runs the same version, which costs only the download.
- **A failed install does not damage the version you were running.** A snapshot is mandatory before npm may touch the tree (`requireSnapshot`, on by default: if the snapshot cannot be written, npm is never spawned), the failure path repairs from it, and the repair also checks that the launcher `lib/bin.js` is back. Rolling back needs neither npm nor the network.
- After a successful install **nothing restarts and no dialog opens**: a "Restart now" button appears on the panel, and only that click hands the port over. The handoff is three steps (payload file → detached relaunch helper waits for port release → replacement starts with identical argv) → the page's watchdog reloads once the replacement answers.

### Snapshot rollback (new)

- **Every install first snapshots the current version** to `~/.dsh-version-update/snapshots/<version>/`; a failed snapshot is logged, never blocking.
- Rolling back = copying a snapshot over the installation: **no npm, no network, usually seconds**. Restore renames the live tree aside first and moves it back if the copy fails midway.
- The "Snapshots & rollback" card lists every usable snapshot with one-click restore through the same confirm + restart flow.
- Snapshots are pruned automatically (5 retained by default); damaged entries are removed first and marked unusable in the list.
- Optional `recoverOnFailedRestart`: when a restarted host never becomes reachable within 60 seconds, the relaunch helper restores the previous version from its snapshot — again without npm or network.

### Policy engine (new)

Policy persists at `~/.dsh-version-update/policy.json` and hot-applies from the panel:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `off` / `notify` / `auto` | On discovery: display only / highlight / **install silently** |
| `track` | `{kind:'tag', tag}` / `{kind:'line', range}` / `{kind:'pin'}` | Follow a dist-tag (custom tags welcome) / follow a `^x.y.z` or `~x.y.z` line (stable only) / pin |
| `window` | `null` or `{start,end}` (`HH:MM`) | Execution window for `auto`; midnight wrap supported (22:00–06:00), equal bounds mean all day; findings outside the window park until it opens |
| `checkAt` | `null` or `HH:MM` | Daily scheduled check |

The scheduler is two boring timers over pure decisions (`resolveTarget` / `inWindow`), so the whole policy is exhaustively testable. Discoveries update the panel's status line; `auto` mode parks out-of-window findings instead of ever installing outside the window.

- **Pending auto-install management**: the panel shows the waiting target version and when it was queued, with a cancel action that disarms its window wake / busy retry. It does not stop an install already running or change the policy or daily check; later automatic checks may schedule an update again.

### Removed

- The v0.x agent-announcement machinery (`announceToAgent`, prompt injection, pending notices) is gone entirely — this plugin is now a purely user-facing panel facility that injects nothing into the model's context.

## Why a restart, not just a reload

`npm install -g` (and snapshot restore) overwrite exactly the package directory the running `dsh web` serves frontend assets from:

- Open pages hold `/assets/index-<hash>.js` URLs that no longer exist on disk; the SPA fallback answers HTML and browser module parsing fails.
- The bundle watcher triggers hot-swaps that tear down theme tokens and possibly the React renderer itself.

The host therefore records the booted `running` version against the on-disk `installed`; they differ exactly while a completed task awaits a restart. `needsRestart` is deliberately wider than `stale`: a finished task proves this process executes superseded code even when versions cannot be compared. The restart overlay is bare DOM + literal colors (theme via the `prefers-color-scheme` media query) so it stays legible after such a teardown.

## Composition

Three halves in one package:

- **Host half** (`lib/`, exports `.`) mounts the loopback-only route family:
  - `GET /check` — local facts + registry channels/versions + task view + ambient (last check verdict, next scheduled run, parked target, recent activity); degrades to `publishedError` when the registry is unreachable
  - `POST /update` — `{version, source?}` starts one install (trigger always recorded as manual; `source` accepts only the identifiers `auto`/`official`/`mirror` and **never a URL** — registry addresses stay in host config, anything else is a 400)
  - `GET /status` — task view (`running`/`stale`/`needsRestart`/`restartable`) + ambient
  - `POST /restart` — three-step handoff, called by the panel's "Restart now" button
  - `GET /notes?version=` — GitHub release notes (mounted when enabled and a repo is known)
  - `POST /pending/cancel` — cancel waiting automatic work and its wake / retry timer, keeping the daily check; returns `{result:{cancelled:true}}`. Loopback-only and POST-only (405 otherwise); omitted in bare route compositions without a cancellation operation.
  - `GET|POST /policy` — read / patch the policy; every rejected field is named in a 400
  - `GET /snapshots`, `POST /restore`, `POST /snapshots/delete` — list, restore, and discard one snapshot; a restore contends for the same machine-wide lock an install holds, so a busy tree in this host or another answers 409. Deleting takes that lock too without ever writing the tree (a failed install looks for exactly that directory), answers with the surviving list, and arms on the first click in the panel to delete on the second.
- **Browser half** (`lib/client.js`, exports `./client`): dictionaries, the settings page (status / policy form / versions / **install progress bar and source picker** / collapsible log / snapshots / history / installation-tree health), nav glyph marker, restart watchdog. The install card exists only while there is a task, and the log is rendered only once asked for.
- **Detached relaunch helper** (`lib/relaunch.js`): waits for pid exit + port release, starts the replacement verbatim; optionally stays alive to snapshot-recover an unreachable replacement.

## Install

```sh
dsh plugin --profile web add dsh-version-update
```

or from source:

```sh
dsh plugin --profile web add github:SuCriss/dsh-version-update
```

Restart `dsh web` once so the host half mounts; until then the panel says so explicitly instead of showing a mysterious HTTP status.

## Configuration (cordis entry config)

- `registry` (default `https://registry.npmjs.org`) — absolute http(s) URL used for BOTH reads and installs. When that URL fails at the network layer the read falls through to a built-in mirror and the host remembers it: the install then goes to the registry the versions were actually read from, not back to the address that just timed out.
- `mirrorRegistry` (default `https://registry.npmmirror.com`) — the fallback source address. Used by the panel's "Taobao mirror" choice and by "Retry with the Taobao mirror"; `auto` is unaffected.
- `requireSnapshot` (default true) — an install must have written its snapshot before npm may run. With it on, a failed snapshot aborts the run outright (`FatalPreparationError`) and npm is never spawned, because an install with no rollback point is exactly the kind that damages a working version. Turn it off for the old behaviour: log the failure and install anyway.
- `allowRestart` (default true) — false removes the restart route.
- `releaseNotes` (default true).
- `snapshotKeep` (default 5, clamped 1–10).
- `snapshotMaxBytes` (default 0 = unlimited) — total snapshot payload-byte quota, excluding metadata and symlink targets. After successful creation, damaged/count-expired snapshots are pruned first, then the oldest usable snapshots are removed until the store fits. The just-created snapshot always survives, even if it alone exceeds the quota. Legacy snapshots without stored sizes are measured on demand.
- `recoverOnFailedRestart` (default false).
- `dataDir` (default empty = `~/.dsh-version-update`) — relocates policy/history/snapshots for portable setups.

Runtime behavior (mode, tracking, window, schedule) lives in the policy file edited from the panel, not entry config.

## Management and diagnostics additions

- Activity timeline: retains the latest 200 install outcomes, snapshot restore and tree repair events in memory; refreshed on checks, settlement, or demand. Loopback-only `GET /api/dsh-version-update/operations?since=N` returns `{result:{events,cursor}}` after that monotonic sequence. The log resets on host reload; installs record settlements only, never invented starts.

- Install preflight: the install confirmation card uses loopback-only `GET /api/dsh-version-update/preflight` to check npm, install-parent writes, free disk space and snapshot storage (`dataDir` aware). Failures become advisory warnings, unknown space is `null`; no npm execution or network calls.

- New snapshots show payload size and support confirmed deletion. Deletion is refused while an install is running — the snapshot taken moments ago is the runner's own way out of a failure — and the discard itself only renames the directory, so the panel never waits on the unlink.
- New inventories verify file paths, sizes and symlink targets before restoration. This is not content hashing. Legacy snapshots remain metadata-validated, explicitly labelled, and may have unknown size.
- The check button uses `POST /check/run` to record a policy-aware verdict. Manual checks never install or create parked automatic jobs, even in auto mode.
- Restart diagnostics read the fixed state-directory `restart.log` on demand, limited to a 16 KiB / 100-line tail with common credential patterns redacted. Review local paths and other details before sharing.
- Missing npm and EACCES/EPERM failures offer terminal, prefix, cache-permission and file-lock guidance without automatic elevation.
- New loopback-only endpoints under `/api/dsh-version-update`: `POST /snapshots/delete` (`{version}`), `POST /check/run`, `GET /restart/diagnostics`.
- Snapshot deletion now **renames to a `.trash-*` tombstone and unlinks in the background**. A recursive delete of a 200 MB snapshot measures in the seconds on Windows — long enough to freeze the whole host and to outlive the panel's 15 s request timeout, which is exactly why the button looked dead. The version leaves the list immediately and the bytes are reclaimed off the event loop; `.tmp-*` / `.trash-*` directories left by a killed process are swept at host start.

## Development

```sh
npm test          # node:test — 165 cases across protocol/domain/routes/composition/browser controller/relaunch helper
npm run typecheck # tsc --checkJs strict — type safety without a build step
```

The suite deliberately covers the contracts most likely to rot: agreement between the browser semver mirror and the host ranking, per-field fallback in policy normalization, snapshot metadata validation and prune ordering, process-wide single-slot exclusivity across fiber reloads, the countdown/watchdog chain under mocked clocks, machine-lock ownership (a release may only remove the record it still holds), the invariant that a parked auto update always has a next wake armed, the relaunch helper's two independent budgets and its dialable probe address, and the rule that a degraded read may never be presented as a conclusion.

This round's contracts were chosen the same way — by asking which step degrades quietly: **the progress model may not invent numbers** (a phase with no denominator must be `indeterminate`, a phase with no signal may not report itself stalled), `source` accepts identifiers only and answers 400 otherwise (no URL may enter from the browser), npm must not be spawned even once when the snapshot cannot be written, and a readable manifest with a missing launcher must still be repaired from the snapshot.
