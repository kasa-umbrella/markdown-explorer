// File System Access API のうち、標準 lib.dom に無い/不足する部分を補う最小宣言。
export {}

declare global {
  interface Window {
    showDirectoryPicker(options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: FileSystemHandle | string
    }): Promise<FileSystemDirectoryHandle>
  }
}
