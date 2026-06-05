import { useCallback, useEffect, useState } from 'react'
import {
  ensureReadPermission,
  forgetDirectory,
  isFsAccessSupported,
  pickDirectory,
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
  error: string | null
}

const SUPPORTED = isFsAccessSupported()

export function useDirectory() {
  const [state, setState] = useState<State>({
    status: 'idle',
    rootName: null,
    scan: null,
    error: null,
  })
  /** Handle held while awaiting permission, so a user action can resume from it */
  const [pending, setPending] = useState<FileSystemDirectoryHandle | null>(null)

  const scanInto = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setState((s) => ({ ...s, status: 'scanning', rootName: handle.name, error: null }))
    try {
      const scan = await scanDirectory(handle)
      setState({ status: 'ready', rootName: handle.name, scan, error: null })
    } catch (e) {
      setState({ status: 'error', rootName: handle.name, scan: null, error: String(e) })
    }
  }, [])

  // On first mount: restore the saved handle and, if permission is granted, scan right away.
  useEffect(() => {
    if (!SUPPORTED) {
      setState({ status: 'error', rootName: null, scan: null, error: 'このブラウザは File System Access API に対応していません' })
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
      setState({ status: 'error', rootName: null, scan: null, error: String(e) })
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
        setState({ status: 'error', rootName: null, scan: null, error: String(e) })
        return null
      }
      setPending(null)
      setState((s) => ({ ...s, status: 'scanning', rootName: handle.name, error: null }))
      try {
        const scan = await scanDirectory(handle)
        setState({ status: 'ready', rootName: handle.name, scan, error: null })
        return { handle, scan }
      } catch (e) {
        setState({ status: 'error', rootName: handle.name, scan: null, error: String(e) })
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
    setState({ status: 'idle', rootName: null, scan: null, error: null })
  }, [])

  /** Rescan the current folder. */
  const rescan = useCallback(async () => {
    const handle = await restoreDirectory()
    if (handle && (await ensureReadPermission(handle, false))) {
      await scanInto(handle)
    }
  }, [scanInto])

  return { supported: SUPPORTED, ...state, choose, chooseAndScan, grant, reset, rescan }
}
