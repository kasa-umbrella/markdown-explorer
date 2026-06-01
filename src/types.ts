/** ツリー上の1ノード。ディレクトリ、または .md ファイル。 */
export interface TreeNode {
  /** ルートからの相対パス。例: "docs/guide.md" */
  path: string
  /** 表示名（パスの末尾） */
  name: string
  kind: 'dir' | 'file'
  /** kind === 'dir' のときのみ。名前順に並んだ子ノード。 */
  children?: TreeNode[]
  /** kind === 'dir' のときのみ。直下に .md を持つフォルダなら true。 */
  hasMarkdown?: boolean
}

/** フォルダ走査の結果。 */
export interface ScanResult {
  /** サイドバー用のツリー（ディレクトリと .md のみ） */
  tree: TreeNode
  /** 全ファイルのハンドル。キーはルートからの相対パス。画像など .md 以外も含む。 */
  files: Map<string, FileSystemFileHandle>
  /** 走査でヒットした .md の総数 */
  markdownCount: number
}
