import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureReadPermission,
  forgetDirectory,
  isFsAccessSupported,
  pickDirectory,
  rememberNativePath,
  resolveRootAbsPath,
  restoreDirectory,
  restoreNativePath,
  scanDirectory,
  scanDirectoryByPath,
} from '../lib/fsAccess'
import type { ScanResult } from '../types'

type Status = 'idle' | 'restoring' | 'need-permission' | 'scanning' | 'ready' | 'error'
/**
 * Which backend produced the active scan.
 * - 'fsa'    → FSA picker + IndexedDB-stored handle
 * - 'native' → absolute path passed via CLI / open-folder; reads go through IPC
 */
type Mode = 'fsa' | 'native'

interface State {
  status: Status
  mode: Mode
  /** Root folder name (we want to show it even while waiting for permission during restore) */
  rootName: string | null
  scan: ScanResult | null
  /**
   * Absolute OS path of the active root, auto-resolved via Electron's webUtils after each
   * successful scan. Null in the browser, or when the root contains no files to sample from.
   */
  rootAbsPath: string | null
  error: string | null
}

const SUPPORTED = isFsAccessSupported()

export function useDirectory(viewable: ReadonlySet<string>, showHidden: boolean) {
  const [state, setState] = useState<State>({
    status: 'idle',
    mode: 'fsa',
    rootName: null,
    scan: null,
    rootAbsPath: null,
    error: null,
  })
  /** Handle held while awaiting permission, so a user action can resume from it */
  const [pending, setPending] = useState<FileSystemDirectoryHandle | null>(null)
  /**
   * Absolute path of the active native-mode root, kept so `rescan` can re-walk it
   * without having to dig the path back out of the scan map.
   */
  const nativeRootRef = useRef<string | null>(null)
  /**
   * Flipped the moment the user's CLI / open-folder request lands, so the auto-restore
   * effect (which runs concurrently on mount) bails out instead of racing the explicit
   * intent. Without this, a saved native or FSA root could overwrite the freshly opened
   * folder depending on which `await` settled last.
   */
  const cliOverrideRef = useRef(false)

  // Keep the latest viewable set and hidden-flag reachable from stable callbacks without
  // forcing them to re-create whenever the user edits the extension list or toggles
  // the "show hidden" switch.
  const viewableRef = useRef(viewable)
  useEffect(() => {
    viewableRef.current = viewable
  }, [viewable])
  const showHiddenRef = useRef(showHidden)
  useEffect(() => {
    showHiddenRef.current = showHidden
  }, [showHidden])

  const scanInto = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setState((s) => ({ ...s, status: 'scanning', mode: 'fsa', rootName: handle.name, error: null }))
    nativeRootRef.current = null
    try {
      const scan = await scanDirectory(handle, viewableRef.current, {
        showHidden: showHiddenRef.current,
      })
      // Best-effort: derive the absolute OS path from a sampled file. Null is fine —
      // downstream git features just degrade quietly.
      const rootAbsPath = await resolveRootAbsPath(scan.files)
      setState({
        status: 'ready',
        mode: 'fsa',
        rootName: handle.name,
        scan,
        rootAbsPath,
        error: null,
      })
    } catch (e) {
      setState({
        status: 'error',
        mode: 'fsa',
        rootName: handle.name,
        scan: null,
        rootAbsPath: null,
        error: String(e),
      })
    }
  }, [])

  /**
   * Native-mode scan: walk `absPath` through the Electron IPC bridge. Used by the
   * CLI alias (`mdexp /some/dir`) and by macOS folder drops. The scan is persisted
   * under a separate idb key so subsequent launches restore it before falling back
   * to a saved FSA handle.
   */
  const scanIntoPath = useCallback(async (absPath: string) => {
    const trimmed = absPath.replace(/[/\\]+$/, '')
    const name = trimmed.split(/[/\\]/).pop() || absPath
    setState((s) => ({ ...s, status: 'scanning', mode: 'native', rootName: name, error: null }))
    nativeRootRef.current = trimmed
    try {
      const scan = await scanDirectoryByPath(absPath, viewableRef.current, {
        showHidden: showHiddenRef.current,
      })
      if (!scan) {
        setState({
          status: 'error',
          mode: 'native',
          rootName: name,
          scan: null,
          rootAbsPath: null,
          error: 'Electron ブリッジが利用できないため、パス指定での読み込みができません',
        })
        return
      }
      await rememberNativePath(trimmed)
      setState({
        status: 'ready',
        mode: 'native',
        rootName: name,
        scan,
        rootAbsPath: trimmed,
        error: null,
      })
    } catch (e) {
      setState({
        status: 'error',
        mode: 'native',
        rootName: name,
        scan: null,
        rootAbsPath: null,
        error: String(e),
      })
    }
  }, [])

  // On first mount: restore the saved root and (if granted/possible) scan right away.
  // Native paths take priority over FSA handles — once the user has switched to the
  // CLI workflow, that's what they expect to come back on relaunch.
  useEffect(() => {
    if (!SUPPORTED) {
      setState({
        status: 'error',
        mode: 'fsa',
        rootName: null,
        scan: null,
        rootAbsPath: null,
        error: 'このブラウザは File System Access API に対応していません',
      })
      return
    }
    let cancelled = false
    ;(async () => {
      setState((s) => ({ ...s, status: 'restoring' }))
      const nativePath = await restoreNativePath()
      if (cancelled || cliOverrideRef.current) return
      if (nativePath) {
        await scanIntoPath(nativePath)
        return
      }
      const handle = await restoreDirectory()
      if (cancelled || cliOverrideRef.current) return
      if (!handle) {
        setState((s) => ({ ...s, status: 'idle' }))
        return
      }
      // prompt:false (not triggered by a user action, so we can't show the permission dialog)
      const ok = await ensureReadPermission(handle, false)
      if (cancelled || cliOverrideRef.current) return
      if (ok) {
        await scanInto(handle)
      } else {
        setPending(handle)
        setState((s) => ({ ...s, status: 'need-permission', rootName: handle.name }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scanInto, scanIntoPath])

  /** Choose a new folder. */
  const choose = useCallback(async () => {
    try {
      const handle = await pickDirectory()
      setPending(null)
      await scanInto(handle)
    } catch (e) {
      // If the user cancelled, just return quietly
      if (e instanceof DOMException && e.name === 'AbortError') return
      setState({
        status: 'error',
        mode: 'fsa',
        rootName: null,
        scan: null,
        rootAbsPath: null,
        error: String(e),
      })
    }
  }, [scanInto])

  /**
   * Like `choose`, but exposes the picked handle and the resulting scan so the
   * caller can act on them — used by the "open with Finder" → promote-to-root
   * flow which needs to locate the originally-opened file inside the new root.
   * Returns null when the user cancels the picker.
   */
  const chooseAndScan = useCallback(
    async (): Promise<{ handle: FileSystemDirectoryHandle; scan: ScanResult } | null> => {
      let handle: FileSystemDirectoryHandle
      try {
        handle = await pickDirectory()
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null
        setState({
          status: 'error',
          mode: 'fsa',
          rootName: null,
          scan: null,
          rootAbsPath: null,
          error: String(e),
        })
        return null
      }
      setPending(null)
      nativeRootRef.current = null
      setState((s) => ({ ...s, status: 'scanning', mode: 'fsa', rootName: handle.name, error: null }))
      try {
        const scan = await scanDirectory(handle, viewableRef.current, {
          showHidden: showHiddenRef.current,
        })
        const rootAbsPath = await resolveRootAbsPath(scan.files)
        setState({
          status: 'ready',
          mode: 'fsa',
          rootName: handle.name,
          scan,
          rootAbsPath,
          error: null,
        })
        return { handle, scan }
      } catch (e) {
        setState({
          status: 'error',
          mode: 'fsa',
          rootName: handle.name,
          scan: null,
          rootAbsPath: null,
          error: String(e),
        })
        return null
      }
    },
    [],
  )

  /** For a handle awaiting permission, request access via a user action and then scan. */
  const grant = useCallback(async () => {
    if (!pending) return
    const ok = await ensureReadPermission(pending, true)
    if (ok) {
      setPending(null)
      await scanInto(pending)
    }
  }, [pending, scanInto])

  /** Forget the remembered folder and return to the initial state. */
  const reset = useCallback(async () => {
    await forgetDirectory()
    setPending(null)
    nativeRootRef.current = null
    setState({
      status: 'idle',
      mode: 'fsa',
      rootName: null,
      scan: null,
      rootAbsPath: null,
      error: null,
    })
  }, [])

  /**
   * Rescan the current folder. Branches on mode: FSA re-uses the stored handle,
   * native re-walks the saved absolute path via IPC.
   */
  const rescan = useCallback(async () => {
    if (nativeRootRef.current) {
      await scanIntoPath(nativeRootRef.current)
      return
    }
    const handle = await restoreDirectory()
    if (handle && (await ensureReadPermission(handle, false))) {
      await scanInto(handle)
    }
  }, [scanInto, scanIntoPath])

  /**
   * Entry point for the CLI alias and macOS folder drops: bypass FSA and scan an
   * absolute path through the IPC bridge. We flip `cliOverrideRef` synchronously so
   * the still-running restore effect bails out instead of overwriting our scan with
   * whatever was saved from a previous session.
   */
  const openByPath = useCallback(
    async (absPath: string) => {
      cliOverrideRef.current = true
      await scanIntoPath(absPath)
    },
    [scanIntoPath],
  )

  // When the viewable extension set or the "show hidden" toggle changes (the user
  // edited Settings), rebuild the tree by re-walking the root. We deliberately
  // serialize the set into a stable string for the dep array so React only fires
  // this on real changes. Skip the initial mount — the restore effect will perform
  // the first scan.
  const initialViewableRef = useRef(true)
  const viewableKey = Array.from(viewable).sort().join(',')
  useEffect(() => {
    if (initialViewableRef.current) {
      initialViewableRef.current = false
      return
    }
    if (state.status !== 'ready' || !state.rootName) return
    void rescan()
    // We intentionally only react to viewableKey/showHidden; rescan itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewableKey, showHidden])

  return {
    supported: SUPPORTED,
    ...state,
    choose,
    chooseAndScan,
    grant,
    reset,
    rescan,
    openByPath,
  }
}
