# dsh-version-update

English | [中文](README.md)

A **版本更新 / Version update** page for the DeepSeek Harness Web GUI settings panel: it adds a first-level entry to the settings navigation that reports the installed `@deepseek-ai/dsh` version, reads the release channels from the npm registry, installs a chosen version with one click, and then restarts the host process and reloads the page automatically.

## Features

- A first-level settings entry, 版本更新 (`settings.section` slot, order 140), with an update glyph in the navigation rail.
- Shows the installed version and the installation directory; checks once when the page opens, and on demand via **检查更新**.
- Lists the npm dist-tag channels (`latest` for stable, `next` for pre-releases) with their versions, marking a channel that is ahead of what is installed.
- Lists every published version, any of which can be picked as the update target.
- One-click update: the host runs `npm install -g @deepseek-ai/dsh@<version>` in the background while the page polls the task every 1.5 s and streams the install log.
- Automatic restart on success: a 5-second countdown (cancellable) hands the port over to a replacement process, and the page reloads once that replacement answers.

## Why a restart is required, not just a reload

`npm install -g` overwrites the very package directory the running `dsh web` serves its frontend assets from:

- An open page holds content-addressed URLs like `/assets/index-<hash>.js`. The new version's hashes differ, the old files no longer exist on disk, and the SPA fallback answers those requests as a route miss — HTTP 200 with `text/html`. The browser parses HTML as a JS module and fails outright.
- The host's bundle watcher notices that dozens of client bundles changed, emits `rebuilt` frames over `/plugins/events`, and the browser's hot-swap chain tears down and rebuilds those plugin fibers — including the theme plugin that defines every `--dsw-*` token and the renderer that draws React components.
- The result is a blank page while the host process still executes the old code: a plain reload would fetch the new assets, but the running service would remain the old version.

So the host records the version it loaded at boot (`running`) alongside the version now on disk (`installed`). When they disagree, `stale` is `true` — which is exactly the window in which the open page's assets have ceased to exist.

## Composition

Three halves ship in one package:

- The **host half** (`lib/index.js`, exports `.`) registers four routes:
  - `GET /api/dsh-version-update/check` — installed version + registry channels + every version + the task view (carrying `running` / `stale` / `restartable`).
  - `POST /api/dsh-version-update/update` — start one install with `{ "version": "0.1.0-rc.8" }`.
  - `GET /api/dsh-version-update/status` — read the current (or last) task state, its log, and the staleness facts.
  - `POST /api/dsh-version-update/restart` — hand the port over and restart the host process.
- The **browser half** (`lib/client.js`, exports `./client`) registers the dictionaries, the 版本更新 page, and a restart watchdog that does not depend on React.
- The **detached restart helper** (`lib/relaunch.js`) is spawned by the host at restart time.

### How the restart works

A process cannot exit and hand its listening port to its own successor at the same time, so the restart is a three-step handoff:

1. The host writes its command line to a payload file in a temporary directory (a file rather than argv, which sidesteps Windows quoting), spawns the detached `lib/relaunch.js`, and calls `process.exit(0)` 300 ms later — the response goes out first, so the browser actually sees the result.
2. The helper deletes the payload immediately (a command line left on disk should not remain replayable), then polls until the old pid is gone and the port stops accepting connections, waiting at most 30 seconds.
3. Once the port is free it waits another 400 ms, then starts the replacement with the identical `execPath` and `argv` (`--profile`, `--port`, and `--patch` all preserved) in the original cwd, redirecting output to `restart.log`.

The replacement's launcher comes from `process.argv[1]` — after an update that same path already holds the new code. It falls back to joining `lib/bin.js` onto the installation directory only when argv[1] is not a dsh launcher (an embedder, or a test harness).

The browser-side watchdog belongs to the plugin fiber rather than the settings page component: a hot swap tears the settings page down, and the watchdog has to outlive it. It writes the target version to `sessionStorage`, so the wait survives even a page reload during the handoff; it resumes when the same-origin `status` route reports `stale !== true`, then calls `location.reload()`. The waiting overlay is built from bare DOM with literal colors — the `--dsw-*` tokens and the React renderer may both be gone by then.

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

Restart `dsh web` and the entry appears (the host half only mounts its routes on a restart).

## Configuration

The composition-layer entry config accepts three fields:

- `announceToAgent` (default `true`) — whether to inject this plugin's guidance section for the agent.
- `registry` (default `https://registry.npmjs.org`) — the registry base URL version information is read from.
- `allowRestart` (default `true`) — set to `false` to omit the restart route; the page then only says a manual restart is needed.

## Development

```sh
npm test
```

60 `node:test` cases, none of which need the network or a real install: version ranking and install-target validation, the loopback fence, the npm install task (asserting the shell-free command line through a fake spawn), the restart handoff's payload and its three refusals, and the four routes exercised over a real HTTP server.

## Security model

- All four routes sit behind a loopback fence: a loopback socket address, a loopback `Host` header, and a non-cross-site origin (`sec-fetch-site` / `Origin`). A remote or LAN browser gets 403 — these routes reach the network, write a global npm package on this machine, and can end the host process.
- The install target accepts one exact published version only (`major.minor.patch` plus an optional pre-release segment); ranges, dist-tags, paths, and any value carrying a shell metacharacter are rejected.
- npm is spawned without a shell on every platform: the runner resolves npm's own `npm-cli.js` next to the running node binary and runs `node npm-cli.js install -g …`, so the version argument never reaches a command-line parser.
- The restart only replays the host's own `process.argv`; no command, argument, or path from a request body is accepted.
- One install task at a time; a second request while one runs returns 409 rather than queueing (two concurrent global installs would race over the same directory).
- A single install times out after 10 minutes; unloading the plugin does not interrupt an install in progress (killing npm midway can leave a half-written global package directory).

## Known limitations

- An instance listening on an OS-assigned port (`--port 0`) gets no automatic restart: the replacement would bind a different port and the page could never find it again. The page says a manual restart is needed instead.
- A restart interrupts everything on this host process: running sessions, background jobs, the SSH connection pool, and task-board execution all end with it, and any unpersisted state is lost. **稍后** during the countdown defers it.
- The helper waits at most 30 seconds for the old process to exit and the port to free; on timeout it starts nothing and records the reason in `restart.log`, and the page reports a wait timeout after 90 seconds.
- Only the single global `@deepseek-ai/dsh` package is updated; plugin dependencies inside a profile are out of scope.
- Version ranking covers the semver subset dsh actually publishes; an unparsable version sorts below every parsable one, so one malformed registry entry cannot hide the whole list.
- The install log retains only its trailing 64 KiB.
- The host needs to be able to find npm's CLI next to the running node binary; when it cannot, the page reports the error and suggests updating from a terminal instead.
- The navigation icon relies on matching its own row by visible label: should another plugin ever ship a settings entry with exactly the same text, both rows would get this plugin's icon. Once the settings panel offers an icon field, this adaptation should be deleted wholesale.
- On Windows npm often cannot clean up the old directory because files are in use (`EPERM ... koffi.node`), leaving a residual `@deepseek-ai\.dsh-<random suffix>` directory behind. The install itself still succeeds, and the leftover can be deleted manually after a restart.

## License

Apache-2.0
