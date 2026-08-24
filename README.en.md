# dsh-version-update

English | [中文](README.md)

The "Version Update" settings menu for the DeepSeek Harness Web GUI — fully rewritten for v1.0. Beyond inspecting and installing any published `@deepseek-ai/dsh` version, this generation turns updating into a **manageable version policy**: silent auto-update, execution windows, a daily scheduled check, dist-tag and version-line tracking, and second-level rollback from local snapshots.

## Features

### Version management (kept, enhanced)

- A top-level "Version Update" settings section showing the installed version and install directory.
- Lists npm dist-tag channels (`latest` / `next`) plus every published version; install or downgrade any of them in one click (downgrade wording everywhere the direction matters).
- The confirm card reads the target version's GitHub release notes (`dsh-v*` tags first) with a link to the full text; failures degrade silently and never block an install.
- One click runs `npm install -g @deepseek-ai/dsh@<exact version>` in the background while the panel follows the log live (scrolling up pauses following). Only exact versions are accepted and npm is spawned without a shell.
- After a successful install: a 20-second cancellable countdown → three-step host handoff (payload file → detached relaunch helper waits for port release → replacement starts with identical argv) → the page's watchdog reloads once the replacement answers.

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
| `restart` | `ask` / `auto` | After install: cancellable countdown / unattended restart after ~10 s |
| `checkAt` | `null` or `HH:MM` | Daily scheduled check |

The scheduler is two boring timers over pure decisions (`resolveTarget` / `inWindow`), so the whole policy is exhaustively testable. Discoveries update the panel's status line; `auto` mode parks out-of-window findings instead of ever installing outside the window.

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
  - `POST /update` — `{version}` starts one install (trigger always recorded as manual)
  - `GET /status` — task view (`running`/`stale`/`needsRestart`/`restartable`) + ambient
  - `POST /restart` — three-step handoff
  - `GET /notes?version=` — GitHub release notes (mounted when enabled and a repo is known)
  - `GET|POST /policy` — read / patch the policy; every rejected field is named in a 400
  - `GET /snapshots`, `POST /restore` — list & restore (refused while an install runs)
- **Browser half** (`lib/client.js`, exports `./client`): dictionaries, the settings page (status / policy form / versions / task log / snapshots / history), nav glyph marker, restart watchdog.
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

- `registry` (default `https://registry.npmjs.org`) — absolute http(s) URL used for BOTH reads and installs.
- `allowRestart` (default true) — false removes the restart route.
- `releaseNotes` (default true).
- `snapshotKeep` (default 5, clamped 1–10).
- `recoverOnFailedRestart` (default false).
- `dataDir` (default empty = `~/.dsh-version-update`) — relocates policy/history/snapshots for portable setups.

Runtime behavior (mode, tracking, window, schedule) lives in the policy file edited from the panel, not entry config.

## Development

```sh
npm test          # node:test — 83 cases across protocol/domain/routes/composition/browser controller
npm run typecheck # tsc --checkJs strict — type safety without a build step
```

The suite deliberately covers the contracts most likely to rot: agreement between the browser semver mirror and the host ranking, per-field fallback in policy normalization, snapshot metadata validation and prune ordering, process-wide single-slot exclusivity across fiber reloads, and the countdown/watchdog chain under mocked clocks.
