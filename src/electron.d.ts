/** APIs exposed to the renderer by electron/preload.ts via contextBridge. */
interface MdexpApi {
  /** Read an absolute OS path as text, auto-detecting UTF-8 vs Shift_JIS (handled in the main process). */
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
  /**
   * Subscribe to "open this folder" requests from the CLI alias
   * (`mdexp /path/to/dir`) or macOS folder drops. The handler receives an
   * absolute directory path. Returns an unsubscribe function.
   */
  onOpenDir(handler: (path: string) => void): () => void
  /**
   * Native-mode directory walk. Main process recursively enumerates files under
   * `absPath` (skipping `.git`, and dotfiles when `showHidden` is false) and
   * returns one entry per file. The renderer builds the tree on its side.
   */
  scanDirByPath(
    absPath: string,
    options: { showHidden?: boolean },
  ): Promise<{ relPath: string; absPath: string }[]>
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
  /** Open another full explorer window (also available on Cmd/Ctrl+N). */
  newWindow(): void
  /**
   * Return the absolute OS path of a `File` object. Works for File instances
   * obtained from FSA's `FileSystemFileHandle.getFile()`, so we can derive the
   * active root's OS path without prompting the user a second time. Returns
   * the empty string when no on-disk path is available.
   */
  getPathForFile(file: File): string
  /**
   * Snapshot of git status under the given absolute root path, returned as
   * `{ relativePath → statusCode }`. Status codes are collapsed:
   *   M (modified), A (added/staged), D (deleted), R (renamed), U (untracked).
   * Resolves to null when the root is outside any git repo or git is unavailable.
   */
  gitStatus(absoluteRootPath: string): Promise<Record<string, MdexpGitStatusCode> | null>
  /**
   * The committed (HEAD) contents of a single file, so the preview can mark which
   * blocks changed since the last commit. Resolves to:
   *   - null              → the file isn't inside a git repo (or git is unavailable)
   *   - { head: string }  → the committed text to diff the current file against
   *   - { head: null }    → a new / untracked file with no HEAD revision (all added)
   */
  gitFileDiff(absoluteFilePath: string): Promise<{ head: string | null } | null>
  /** Open (or focus) the detached presenter window. Main window only. */
  presenterOpen(): void
  /** Close the detached presenter window. Main window only. */
  presenterClose(): void
  /** Main window → presenter window: push a deck-init or index-update message. */
  sendToPresenter(msg: unknown): void
  /** Presenter window: subscribe to pushes from the main window. Returns an unsubscribe fn. */
  onToPresenter(handler: (msg: unknown) => void): () => void
  /** Presenter window → main window: send a navigation / exit / ready command. */
  sendToMain(msg: unknown): void
  /** Main window: subscribe to commands from the presenter window. Returns an unsubscribe fn. */
  onToMain(handler: (msg: unknown) => void): () => void
  /** Main window: subscribe to the presenter window being closed by the user. */
  onPresenterClosed(handler: () => void): () => void
}

/** Single-letter status surface for the sidebar. See `MdexpApi.gitStatus`. */
type MdexpGitStatusCode = 'M' | 'A' | 'D' | 'R' | 'U'

interface Window {
  mdexp?: MdexpApi
}
