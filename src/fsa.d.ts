// Minimal declarations filling in the parts of the File System Access API missing or incomplete in the standard lib.dom.
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
