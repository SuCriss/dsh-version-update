/**
 * Ambient declarations for the two dsh packages this plugin references in JSDoc
 * types but does not depend on at runtime.
 *
 * Both are internal to the harness and publish no types a third-party plugin can
 * install, yet the sources are more readable naming them than repeating a
 * structural shape. Declaring them here keeps `tsc --checkJs` honest about
 * everything else instead of failing on two unresolvable module specifiers.
 */

declare module '@deepseek-ai/cordis' {
  /** The plugin context; only the members this plugin actually touches. */
  export interface Context {
    /** Register a disposable side effect owned by this fiber. */
    effect(fn: () => (() => void) | void, label?: string): () => void
    /** Read an optional service, or undefined when nothing provides it. */
    get(name: string): any
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  /** One route registration accepted by `webServer.register`. */
  export interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }
}
