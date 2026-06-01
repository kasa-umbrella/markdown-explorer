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
  /** ルートフォルダ名（復元時に権限待ちでも名前は出したい） */
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
  /** 権限待ちのとき、ユーザー操作で再開するために保持するハンドル */
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

  // 初回マウント時：保存済みハンドルを復元し、権限があればそのまま走査。
  useEffect(() => {
    if (!SUPPORTED) {
      setState({ status: 'error', rootName: null, scan: null, error: 'このブラウザは File System Access API 未対応' })
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
      // prompt:false（ユーザー操作起点ではないので許可ダイアログは出せない）
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

  /** フォルダを新規に選ぶ。 */
  const choose = useCallback(async () => {
    try {
      const handle = await pickDirectory()
      setPending(null)
      await scanInto(handle)
    } catch (e) {
      // ユーザーがキャンセルした場合は静かに戻す
      if (e instanceof DOMException && e.name === 'AbortError') return
      setState({ status: 'error', rootName: null, scan: null, error: String(e) })
    }
  }, [scanInto])

  /** 権限待ちのハンドルに対し、ユーザー操作で許可を要求して走査。 */
  const grant = useCallback(async () => {
    if (!pending) return
    const ok = await ensureReadPermission(pending, true)
    if (ok) {
      setPending(null)
      await scanInto(pending)
    }
  }, [pending])

  /** 記憶したフォルダを忘れて最初の状態へ。 */
  const reset = useCallback(async () => {
    await forgetDirectory()
    setPending(null)
    setState({ status: 'idle', rootName: null, scan: null, error: null })
  }, [])

  /** 現在のフォルダを再走査。 */
  const rescan = useCallback(async () => {
    const handle = await restoreDirectory()
    if (handle && (await ensureReadPermission(handle, false))) {
      await scanInto(handle)
    }
  }, [scanInto])

  return { supported: SUPPORTED, ...state, choose, grant, reset, rescan }
}
