/** A single commit returned by gitHistory(). */
interface MdexpGitCommit {
  /** Full SHA. */
  sha: string
  /** Abbreviated SHA suitable for display. */
  shortSha: string
  /** Author date in strict ISO-8601 (`%aI`). */
  dateISO: string
  authorName: string
  /** Commit subject (first line). */
  subject: string
}

/** APIs exposed to the renderer by electron/preload.ts via contextBridge. */
interface MdexpApi {
  /** Read an absolute OS path as UTF-8 text (handled in the main process). */
  readTextFileByPath(path: string): Promise<string>
  /**
   * Read an absolute OS path as raw bytes. The renderer wraps the buffer in a
   * Blob to render images referenced by relative paths inside externally-opened
   * markdown files.
   */
  readBinaryFileByPath(path: string): Promise<ArrayBuffer>
  /**
   * Subscribe to "open with this app" requests dispatched by macOS Finder
   * (via app.on('open-file') in the main process). The handler receives an
   * absolute filesystem path. Returns an unsubscribe function.
   */
  onOpenFile(handler: (path: string) => void): () => void
  /** Set the BrowserWindow opacity. Range is clamped to [0.2, 1.0] in the main process. */
  setWindowOpacity(opacity: number): void
  /** Toggle BrowserWindow.setAlwaysOnTop. */
  setAlwaysOnTop(flag: boolean): void
  /**
   * Subscribe to Cmd/Ctrl+W intercepted by the main process. The renderer is
   * expected to close the active tab; if no tab is open, call `closeWindow()`.
   * Returns an unsubscribe function.
   */
  onCloseActiveTab(handler: () => void): () => void
  /**
   * Subscribe to Cmd/Ctrl+R intercepted by the main process. The renderer should
   * re-read the active tab's content from disk (rather than reloading the page).
   * Returns an unsubscribe function.
   */
  onReloadActiveTab(handler: () => void): () => void
  /** Close the BrowserWindow (used as the Cmd+W fallback when no tabs remain). */
  closeWindow(): void
  /**
   * Open a native directory picker. Used as a manual fallback to learn the absolute
   * OS path of a folder when `getPathForFile`-based auto-resolution fails (e.g. an
   * empty root). Resolves to the chosen path, or null if the user cancelled.
   */
  chooseDirectory(): Promise<string | null>
  /**
   * Return the absolute OS path of a `File` object. Works for File instances
   * obtained from FSA's `FileSystemFileHandle.getFile()`, so we can derive the
   * active root's OS path without prompting the user a second time. Returns
   * the empty string when no on-disk path is available.
   */
  getPathForFile(file: File): string
  /**
   * `git log --follow -- <file>` for the given absolute path. Returns commits
   * newest-first. Resolves to an empty array if the file isn't tracked.
   */
  gitHistory(absoluteFilePath: string): Promise<MdexpGitCommit[]>
  /** `git show <sha>:<file>` → the file's content at that revision. */
  gitShow(absoluteFilePath: string, sha: string): Promise<string>
  /**
   * Snapshot of git status under the given absolute root path, returned as
   * `{ relativePath → statusCode }`. Status codes are collapsed:
   *   M (modified), A (added/staged), D (deleted), R (renamed), U (untracked).
   * Resolves to null when the root is outside any git repo or git is unavailable.
   */
  gitStatus(absoluteRootPath: string): Promise<Record<string, MdexpGitStatusCode> | null>
}

/** Single-letter status surface for the sidebar. See `MdexpApi.gitStatus`. */
type MdexpGitStatusCode = 'M' | 'A' | 'D' | 'R' | 'U'

interface Window {
  mdexp?: MdexpApi
}
