/** APIs exposed to the renderer by electron/preload.ts via contextBridge. */
interface MdexpApi {
  /** Read an absolute OS path as UTF-8 text (handled in the main process). */
  readTextFileByPath(path: string): Promise<string>
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
}

interface Window {
  mdexp?: MdexpApi
}
