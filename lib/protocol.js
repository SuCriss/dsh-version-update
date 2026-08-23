/**
 * Wire contract shared by the version-update host routes and the browser
 * panel: route paths, the npm package this plugin updates, and the release
 * channels it reads from the registry.
 * @module dsh-version-update/protocol
 */

/** The npm package whose installed version this plugin reports and updates. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Route family of the version-update host API. */
export const VERSION_API = {
  /** Read the installed version and the registry's published versions. */
  check: '/api/dsh-version-update/check',
  /** Start a background update to one explicit version. */
  update: '/api/dsh-version-update/update',
  /** Read the current (or last) update task state and its output log. */
  status: '/api/dsh-version-update/status',
  /** Relaunch the running host with the same command line and exit this one. */
  restart: '/api/dsh-version-update/restart',
  /**
   * Read the release notes for one exact published version. Served only when
   * the `releaseNotes` config is enabled (the default).
   */
  notes: '/api/dsh-version-update/notes',
}

/**
 * The GitHub release tags tried, in order, for one dsh version.
 * @param {string} version - the exact published version.
 * @returns {string[]} tag candidates, most specific first.
 */
export function releaseTagCandidates(version) {
  return [`dsh-v${version}`, `v${version}`]
}

/**
 * Release channels the panel offers: npm dist-tags of the dsh package.
 * `latest` is the stable tag, `next` the pre-release tag.
 */
export const CHANNELS = ['latest', 'next']
