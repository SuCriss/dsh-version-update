# dsh-version-update

English | [中文](README.md)

A **版本更新 / Version update** page for the DeepSeek Harness Web GUI settings panel: it adds a first-level entry to the settings navigation that reports the installed `@deepseek-ai/dsh` version, reads the release channels from the npm registry, installs a chosen version with one click, and then restarts the host process and reloads the page automatically.

## Features

- A first-level settings entry, 版本更新 (`settings.section` slot, order 140), with an update glyph in the navigation rail.
- Shows the installed version and the installation directory; checks once when the page opens, and on demand via **检查更新**.
- Lists the npm dist-tag channels (`latest` for stable, `next` for pre-releases) with their versions, marking a channel that is ahead of what is installed.
- Lists every published version, any of which can be picked as the update target.
- One-click update: a confirmation card first states that the action rewrites this machine's global package and then ends the host; on confirmation the host runs `npm install -g @deepseek-ai/dsh@<version>` in the background while the page polls the task every 1.5 s and streams the install log (pinned to the newest line until you scroll up).
- **Release notes on the card**: the confirmation reads the target version's GitHub release notes (dsh publishes bilingual bodies under `dsh-v*` tags) with a link to the full text — decide against what changed, not a bare number. A version without a release, a disabled config, or any fetch failure renders as nothing and never gates the install.
- Downgrades are one click away too: picking a version older than the installed one labels the button and the confirmation card as a **downgrade**, never as an update, so a rollback cannot masquerade as an upgrade.
- **One-click rollback**: every settled install appends to `~/.dsh-version-update/history.json` (capped at 50 entries). When the newest successful entry is exactly the one that produced the on-disk version, the panel offers *Roll back to x.y.z*; whenever history stops being unambiguous the offer withdraws rather than pointing somewhere wrong. A rollback flows through the ordinary confirmation, where its older target reads as a downgrade.
- Graceful degradation when the registry is unreachable: `check` still answers 200 with the local facts (installed version, install path, task view) and carries the failure reason in `publishedError`; the panel shows a warning beside them. An offline machine no longer blanks the panel.
- **Periodic auto-check** (optional): on the configured hourly cadence (floored at 1 hour) the host re-reads the registry, exposes the verdict through `/check` and `/status`, and — on a discovery — registers a pending announcement so the model can surface the finding proactively.
- Automatic restart on success: a 20-second countdown (cancellable) hands the port over to a replacement process, and the page reloads once that replacement answers.

## Why a restart is required, not just a reload

`npm install -g` overwrites the very package directory the running `dsh web` serves its frontend assets from:

- An open page holds content-addressed URLs like `/assets/index-<hash>.js`. The new version's hashes differ, the old files no longer exist on disk, and the SPA fallback answers those requests as a route miss — HTTP 200 with `text/html`. The browser parses HTML as a JS module and fails outright.
- The host's bundle watcher notices that dozens of client bundles changed, emits `rebuilt` frames over `/plugins/events`, and the browser's hot-swap chain tears down and rebuilds those plugin fibers — including the theme plugin that defines every `--dsw-*` token and the renderer that draws React components.
- The result is a blank page while the host process still executes the old code: a plain reload would fetch the new assets, but the running service would remain the old version.

So the host records the version it loaded at boot (`running`) alongside the version now on disk (`installed`). When they disagree, `stale` is `true` — which is exactly the window in which the open page's assets have ceased to exist.

The page acts on the wider `needsRestart`: `stale`, **or** an install that finished in this process. A process cannot swap its own module tree, so a completed install is itself proof that the running code has been superseded — even when `installed` cannot be read (an embedder, an unreadable manifest). Keying off `stale` alone would leave such a host silently broken after a successful update, with no prompt to restart.

## Composition

Three halves ship in one package:

- The **host half** (`lib/index.js`, exports `.`) registers four core routes plus one conditionally mounted notes route:
  - `GET /api/dsh-version-update/check` — installed version + registry channels + every version + the task view (carrying `running` / `stale` / `needsRestart` / `restartable`), plus the auto-check verdict and the rollback offer. A failed registry read is not an error: the response stays 200 with the local facts and a `publishedError`, omitting `channels` / `versions`.
  - `POST /api/dsh-version-update/update` — start one install with `{ "version": "0.1.0-rc.8" }`. A body over 4 KiB answers 413; malformed JSON answers 400.
  - `GET /api/dsh-version-update/status` — read the current (or last) task state, its log, the staleness facts, and the same ambient fields.
  - `POST /api/dsh-version-update/restart` — hand the port over and restart the host process.
  - `GET /api/dsh-version-update/notes?version=…` — the GitHub release notes of one exact version (cached per version for an hour, misses included). Mounted only when `releaseNotes` is on AND the installed manifest resolves to a GitHub repository; an upstream failure answers 502.
- The **browser half** (`lib/client.js`, exports `./client`) registers the dictionaries, the 版本更新 page, and a restart watchdog that does not depend on React.
- The **detached restart helper** (`lib/relaunch.js`) is spawned by the host at restart time.

### How the restart works

A process cannot exit and hand its listening port to its own successor at the same time, so the restart is a three-step handoff:

1. The host writes its command line to a payload file in a temporary directory (a file rather than argv, which sidesteps Windows quoting), spawns the detached `lib/relaunch.js`, and calls `process.exit(0)` 300 ms later — the response goes out first, so the browser actually sees the result.
2. The helper deletes the payload immediately (a command line left on disk should not remain replayable), then polls until the old pid is gone and the port stops accepting connections, waiting at most 30 seconds.
3. Once the port is free it waits another 400 ms, then starts the replacement with the identical `execPath` and `argv` (`--profile`, `--port`, and `--patch` all preserved) in the original cwd, redirecting output to `restart.log`.

The replacement's launcher comes from `process.argv[1]` — after an update that same path already holds the new code. It falls back to joining `lib/bin.js` onto the installation directory only when argv[1] is not a dsh launcher (an embedder, or a test harness).

The browser-side watchdog belongs to the plugin fiber rather than the settings page component: a hot swap tears the settings page down, and the watchdog has to outlive it. It writes the target version to `sessionStorage`, so the wait survives even a page reload during the handoff; it resumes when the same-origin `status` route reports `needsRestart !== true` (the replacement is a fresh process: its task is idle and its versions agree), then calls `location.reload()`. The waiting overlay is built from bare DOM with literal colors — the `--dsw-*` tokens and the React renderer may both be gone by then; the colors still follow `prefers-color-scheme`, which needs no stylesheet to survive. The overlay claims `aria-modal`, so it also earns it: focus is trapped inside the card, Escape runs the dismissing action when one exists, and focus returns to its previous owner on close.

### Why the restart judges the *requested* port

`webServer.port` is the **resolved** port: a host started with `--port 0` is listening on a real number right now. Allowing a restart on that basis would relaunch with the same argv, have the replacement bind a *different* random port, and leave the page polling an address nothing answers on — with the old process already gone, ending in the 90-second timeout. So the plugin parses the port this invocation *asked for* out of `process.argv` (`--port 0` / `--port=0`) and refuses only when that value is 0.

### How the navigation icon is replaced

A `settings.section` registration only projects `id`, `order`, and `label`, and the settings panel picks its glyphs from a closed list of built-in ids, so an external plugin's entry always gets the fallback gear. Until that contract grows an icon field, the plugin identifies **only its own row** after the dialog mounts — matched by its current localized label — marks it with `data-dsh-version-update-settings-nav`, and its own stylesheet hides the gear and paints a `currentColor` mask glyph via `::before` (a circular refresh arrow over a downward install arrow).

That way the icon inherits the native navigation's hover and active colors and keeps the shell's 16 px rhythm without hardcoding any color. The marker owns no part of the panel's structure and the attribute is removed when the plugin unloads, so the adaptation is HMR-safe.

## Install

From npm (recommended — a prebuilt install skips the build-approval step):

```sh
dsh plugin --profile web add dsh-version-update
```

Or from source:

```sh
dsh plugin --profile web add github:SuCriss/dsh-version-update
```

Restart `dsh web` and the entry appears (the host half only mounts its routes on a restart). Opening the panel before that restart reports "the host routes are not mounted yet" rather than an opaque HTTP status.

## Configuration

The composition-layer entry config is validated by a `Config` schema (`@deepseek-ai/schemastery`), so a mistyped field fails the load with a named path instead of silently disabling a feature:

- `announceToAgent` (default `true`) — whether to inject this plugin's guidance section for the agent.
- `registry` (default `https://registry.npmjs.org`) — the registry base URL. **Both the version read and the install use it**: the install passes `--registry <value>`, because otherwise a mirror-configured deployment would list a version from the mirror and then download it from npmjs. It must be an absolute http(s) URL or the mount fails — the value reaches an npm command line.
- `allowRestart` (default `true`) — set to `false` to omit the restart route; the page then only says a manual restart is needed.
- `releaseNotes` (default `true`) — read and show the target version's GitHub release notes on the confirmation card; also controls whether the notes route mounts.
- `autoCheckIntervalHours` (default `0`, off) — hours between automatic registry checks (floored at 1 hour so a typo cannot hammer the registry). A discovery updates the ambient fields on `/check` and `/status` and registers a pending agent announcement.
- `autoRollbackOnFailedRestart` (default `false`) — when a replacement never becomes reachable within 60 s, the relaunch helper reinstalls the previous version and starts over, logging every step to `restart.log`. Off by default: the recovery reinstall runs while the broken replacement may still hold files — most relevant on Windows.

## Development

```sh
npm test          # 127 node:test cases
npm run typecheck # tsc --checkJs, no build output
```

None of the cases need the network or a real install: version ranking and install-target validation, registry-URL normalization, the loopback fence, the npm install task (asserting the shell-free command line and the `--registry` passthrough through a fake spawn, plus the process-wide install slot across fibers and the exactly-once settlement observer), install history and rollback-target derivation, repository-slug parsing and release-notes fetching (tag fallback and caching), the restart handoff's payload and its port refusals, the route family exercised over a real HTTP server (including the degraded registry-failure response and the conditional notes mount), the plugin entry's schema and wiring, and the browser-side controller (confirmation, countdown, the reload-surviving watchdog, the not-mounted diagnosis — reached through `createController` with a fake overlay and reload). The browser half's mirrored version ranking is pinned by a test that walks both implementations through the same version matrix.

`tsconfig.json` type-checks only and emits nothing: `checkJs` makes the JSDoc the sources already carry into real constraints. `lib/client.js` and the tests are out of scope (the former's `require` belongs to `window.__ModuleLoader__` rather than Node; the latter are built almost entirely from deliberately partial fakes).

## Security model

- All four core routes and the conditionally mounted notes route sit behind a loopback fence: a loopback socket address, a loopback `Host` header, and a non-cross-site origin (`sec-fetch-site` / `Origin`). A remote or LAN browser gets 403 — these routes reach the network, write a global npm package on this machine, and can end the host process.
- The install target accepts one exact published version only (`major.minor.patch` plus an optional pre-release segment); ranges, dist-tags, paths, and any value carrying a shell metacharacter are rejected.
- npm is spawned without a shell on every platform: the runner resolves npm's own `npm-cli.js` next to the running node binary and runs `node npm-cli.js install -g …`, so the version argument never reaches a command-line parser.
- The configured `registry` is validated as an absolute http(s) URL at mount time before it may appear on that command line, so a value posing as another flag (`--proxy=…`) never gets there.
- Request bodies are capped at 4 KiB (the update body is one small JSON object).
- The update button is never one click: the panel shows a confirmation card stating the impact first — and when the target is older than what is installed, the card and the button both say *downgrade*.
- The restart only replays the host's own `process.argv`; no command, argument, or path from a request body is accepted.
- One install task at a time, enforced PROCESS-WIDE: after a config change hot-reloads the plugin's fiber, the replacement runner still refuses to start while the previous fiber's npm writes the global tree — until that run settles on its own (409 rather than queued; two concurrent global installs would race over the same directory).
- A single install times out after 10 minutes; unloading the plugin does not interrupt an install in progress (killing npm midway can leave a half-written global package directory).

## Known limitations

- An instance started with `--port 0` (listening on an OS-assigned port) gets no automatic restart: the replacement would bind a different port and the page could never find it again. The page says a manual restart is needed instead. The decision reads the port requested on the command line, not the resolved one.
- A restart interrupts everything on this host process: running sessions, background jobs, the SSH connection pool, and task-board execution all end with it, and any unpersisted state is lost. The pre-update confirmation says so, and **稍后** during the 20-second countdown defers it.
- The helper waits at most 30 seconds for the old process to exit and the port to free; on timeout it starts nothing and records the reason in `restart.log`, and the page reports a wait timeout after 90 seconds.
- Only the single global `@deepseek-ai/dsh` package is updated; plugin dependencies inside a profile are out of scope.
- Version ranking covers the semver subset dsh actually publishes; an unparsable version sorts below every parsable one, so one malformed registry entry cannot hide the whole list.
- The install log retains only its trailing 64 KiB.
- The host needs to be able to find npm's CLI next to the running node binary; when it cannot, the page reports the error and suggests updating from a terminal instead.
- The navigation icon relies on matching its own row by visible label: should another plugin ever ship a settings entry with exactly the same text, both rows would get this plugin's icon. Once the settings panel offers an icon field, this adaptation should be deleted wholesale. The MutationObserver it needs watches `document.body`, so its callback is coalesced into one animation frame — otherwise a chat stream's per-token `characterData` mutations would make an idle plugin expensive.
- On Windows npm often cannot clean up the old directory because files are in use (`EPERM ... koffi.node`), leaving a residual `@deepseek-ai\.dsh-<random suffix>` directory behind. The install itself still succeeds, and the leftover can be deleted manually after a restart.
- `autoRollbackOnFailedRestart`'s recovery reinstall is subject to the same Windows file-locking: if the broken replacement still holds files, the rollback install may fail (the helper logs it and gives up without making anything worse). That is one more reason it defaults to off.

## License

Apache-2.0
