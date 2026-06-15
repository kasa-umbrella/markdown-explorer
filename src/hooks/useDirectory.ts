import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureReadPermission,
  forgetDirectory,
  isFsAccessSupported,
  pickDirectory,
  resolveRootAbsPath,
  restoreDirectory,
  scanDirectory,
} from '../lib/fsAccess'
import type { ScanResult } from '../types'

type Status = 'idle' | 'restoring' | 'need-permission' | 'scanning' | 'ready' | 'error'

interface State {
  status: Status
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

export function useDirectory(viewable: ReadonlySet<string>) {
  const [state, setState] = useState<State>({
    status: 'idle',
    rootName: null,
    scan: null,
    rootAbsPath: null,
    error: null,
  })
  /** Handle held while awaiting permission, so a user action can resume from it */
  const [pending, setPending] = useState<FileSystemDirectoryHandle | null>(null)

  // Keep the latest viewable set reachable from stable callbacks without forcing them to
  // re-create whenever the user edits the extension list.
  const viewableRef = useRef(viewable)
  useEffect(() => {
    viewableRef.current = viewable
  }, [viewable])

  const scanInto = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setState((s) => ({ ...s, status: 'scanning', rootName: handle.name, error: null }))
    try {
      const scan = await scanDirectory(handle, viewableRef.current)
      // Best-effort: derive the absolute OS path from a sampled file. Failure here is
      // non-fatal — the Time Machine UI falls back to a manual link prompt.
      const rootAbsPath = await resolveRootAbsPath(scan.files)
      setState({ status: 'ready', rootName: handle.name, scan, rootAbsPath, error: null })
    } catch (e) {
      setState({ status: 'error', rootName: handle.name, scan: null, rootAbsPath: null, error: String(e) })
    }
  }, [])

  // On first mount: restore the saved handle and, if permission is granted, scan right away.
  useEffect(() => {
    if (!SUPPORTED) {
      setState({ status: 'error', rootName: null, scan: null, rootAbsPath: null, error: 'このブラウザは File System Access API に対応していません' })
      return
    }
    let cancelled = false
    ;(async () => {
      setState((s) => ({ ...s, status: 'restoring' }))
      const handle = await restoreDirectory()
      if (cancelled) return
      if (!handle) {
        setState((s) => ({ ...s, status: 'idle' }))
        return
      }
      // prompt:false (not triggered by a user action, so we can't show the permission dialog)
      const ok = await ensureReadPermission(handle, false)
      if (cancelled) return
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
  }, [scanInto])

  /** Choose a new folder. */
  const choose = useCallback(async () => {
    try {
      const handle = await pickDirectory()
      setPending(null)
      await scanInto(handle)
    } catch (e) {
      // If the user cancelled, just return quietly
      if (e instanceof DOMException && e.name === 'AbortError') return
      setState({ status: 'error', rootName: null, scan: null, rootAbsPath: null, error: String(e) })
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
        setState({ status: 'error', rootName: null, scan: null, rootAbsPath: null, error: String(e) })
        return null
      }
      setPending(null)
      setState((s) => ({ ...s, status: 'scanning', rootName: handle.name, error: null }))
      try {
        const scan = await scanDirectory(handle, viewableRef.current)
        const rootAbsPath = await resolveRootAbsPath(scan.files)
        setState({ status: 'ready', rootName: handle.name, scan, rootAbsPath, error: null })
        return { handle, scan }
      } catch (e) {
        setState({ status: 'error', rootName: handle.name, scan: null, rootAbsPath: null, error: String(e) })
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
  }, [pending])

  /** Forget the remembered folder and return to the initial state. */
  const reset = useCallback(async () => {
    await forgetDirectory()
    setPending(null)
    setState({ status: 'idle', rootName: null, scan: null, rootAbsPath: null, error: null })
  }, [])

  /** Rescan the current folder. */
  const rescan = useCallback(async () => {
    const handle = await restoreDirectory()
    if (handle && (await ensureReadPermission(handle, false))) {
      await scanInto(handle)
    }
  }, [scanInto])

  // When the viewable extension set changes (the user edited the list in Settings),
  // rebuild the tree against the new set by re-walking the root. We deliberately serialize
  // the set into a stable string for the dep array so React only fires this on real changes.
  // Skip the initial mount — the restore effect will perform the first scan.
  const initialViewableRef = useRef(true)
  const viewableKey = Array.from(viewable).sort().join(',')
  useEffect(() => {
    if (initialViewableRef.current) {
      initialViewableRef.current = false
      return
    }
    if (state.status !== 'ready' || !state.rootName) return
    void rescan()
    // We intentionally only react to viewableKey; rescan itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewableKey])

  return { supported: SUPPORTED, ...state, choose, chooseAndScan, grant, reset, rescan }
}
