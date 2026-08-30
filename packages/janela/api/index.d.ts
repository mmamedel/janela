/**
 * The janela frontend API.
 *
 * Values cross the boundary as values — janela owns the JSON at the edge — so
 * the generic parameter is what the host command returns, not a string to
 * parse.
 */

/** The bridge janela injects as `window.janela` before each document loads. */
export interface JanelaBridge {
  invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;
  listen<T = unknown>(event: string, cb: (payload: T) => void): void;
}

/**
 * Call a command the host registered with `app.command` / `app.commandAsync`.
 *
 * ```ts
 * const sum = await invoke<number>("add", { a: 2, b: 40 });
 * ```
 *
 * Rejects if the command is unknown, if the handler rejected, or if the page
 * is not running inside a janela window.
 */
export declare function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;

/**
 * Subscribe to an event the host sends with `app.emit`.
 *
 * ```ts
 * listen<number>("added", (sum) => console.log(sum));
 * ```
 */
export declare function listen<T = unknown>(
  event: string,
  cb: (payload: T) => void,
): void;
