<p align="center">
  <img src="build/icon.png" width="128" alt="Markdown Explorer" />
</p>

<h1 align="center">Markdown Explorer</h1>

<p align="center">
  <strong>フォルダを開くだけ。あなたの知識がまるごとビューアになる。</strong>
</p>

<p align="center">
  <em>Markdown も、YAML も、JSON も、ぜんぶ。リンクのつながりも、Git の過去も、いっしょに。</em>
</p>

---

## なにがすごいの？

### 📂 フォルダひとつで、ぜんぶ読める
ファイルを 1 枚ずつ開いて回るのは、もう終わり。<br>
ルートフォルダを指定すれば、その中の Markdown を**まるごとツリーに展開**して、即座に読める状態にします。次回起動時はワンタッチで前回のフォルダに戻れる――許可ダイアログも、もう出ません。

### 🔍 「あれ、どこに書いたっけ？」が 1 秒で終わる
- **ファイル名検索**：ツリーをそのまま絞り込み。
- **中身全文検索**：フォルダ内のすべてのファイルに対して、本文の中身までグレップ。検索結果はハイライト付きでプレビューに飛べます。

### 🕸 リンクのつながりを、一枚の絵で
`[[wiki link]]` や `[](relative/path.md)` を解析して、**ファイル同士のリンクをグラフ可視化**。<br>
「このメモ、どこから参照されてるんだっけ？」が、地図を見るように直感で分かります。

### 🕰 Git に、もう一度命を吹き込む
ルートが Git リポジトリなら、自動で連携。
- ツリーに **変更ステータス**（M / A / D / R / Untracked）をバッジ表示。
- **タイムマシン**で、その場で過去コミットの中身までジャンプ。`git log --follow` 対応なので、リネームを越えて履歴を辿れます。

### 🪟 仕事の "そばに置ける" ビューア
- **透明度調整**：ターミナルやエディタの上に薄く重ねて、メモを透かしながら作業。
- **常に最前面**：チェックリストや手順書を、画面の隅でずっと表示。
- **フォーカスで自動再読込**：他のエディタで保存して戻ってくるだけで、最新の内容が反映されます。

### 💧 何を投げ込んでも、ちゃんと読む
- Finder から「このアプリで開く」、もちろん OK。
- **VSCode のエディタタブからのドラッグ**、Finder からのドロップ、外部からの D&D ぜんぶ対応。
- ルート外のファイルを投げ込んでも、外部タブとして開けます。後から「親フォルダをルートにする？」と聞いてくれます。

### ✨ Markdown の "気持ちいい" を全部入り
- GFM 相当のテーブル / 取り消し線 / **タスクリスト** / 見出しアンカー
- **highlight.js** によるシンタックスハイライト
- **Mermaid** 図表のレンダリング。フローチャートは **React Flow** でインタラクティブ表示。
- 相対パスの画像も、リンク先の `.md` への遷移も、ちゃんと解決。

### 🎛 こだわりたい人のための設定
テーマ（システム / ライト / ダーク）、フォントサイズ、行の高さ、読み幅、コードの折り返し、追加で表示する拡張子 (YAML / JSON など)。<br>
**設定はぜんぶ localStorage に保存**。次回も自分好みのまま。

---

## インストール

### 配布版（macOS）
[Releases](https://github.com/kasa-umbrella/markdown-explorer/releases) から `.dmg` をダウンロードして、`/Applications` にドラッグするだけ。

> 署名なし配布なので、初回起動時には `xattr -dr com.apple.quarantine /Applications/markdown-explorer.app` で隔離属性の解除が必要なことがあります。

### ソースからビルド
```bash
git clone https://github.com/kasa-umbrella/markdown-explorer.git
cd markdown-explorer
npm install

# 開発モード（HMR 付き）
npm run dev

# 配布用 DMG を作る
npm run dist

# ローカルの /Applications に焼き直す（macOS, Apple Silicon）
npm run install:local
```

---

## 使い方

### 1. フォルダを選ぶ
起動するとフォルダ選択画面。読みたいフォルダを 1 つ選ぶだけ。<br>
**選んだフォルダは記憶される**ので、次回起動時は自動で開きます。

### 2. ツリーから開く
左サイドバーのツリーから、好きなファイルをクリック。
- **シングルクリック**：プレビュー（ピンなしタブ）。
- **ダブルクリック**：ピン留めタブで固定。

### 3. 検索する
左上の検索バーの下にある **「名前」 / 「中身」** トグルで切り替え。
- **名前**：ツリーを絞り込み表示。
- **中身**：全ファイルの本文をグレップ。

### 4. リンクを辿る、グラフで眺める
プレビュー内のリンクをそのままクリックすれば、別ファイルにジャンプ。<br>
ツールバーの **🕸** ボタンで**リンクグラフ**を表示。ノードをタップすればそのファイルへ。

### 5. Git の中を覗く
- ツリーには変更ファイルのバッジが自動で出ます。
- プレビュー上部の **🕰** ボタンで**タイムマシン**を開き、過去コミットの内容を切り替え表示。

### 6. 設定を開く
右下の歯車ボタンから、ウィンドウ・テーマ・タイポグラフィ・拡張子をカスタマイズ。

---

## キーボードショートカット

| キー | 動作 |
| :-- | :-- |
| `⌘ + [` / `⌘ + ]` | アクティブタブ内で **戻る / 進む** |
| `⌘ + Shift + [` / `⌘ + Shift + ]` | **前 / 次のタブ**へ |
| `⌘ + 1` 〜 `⌘ + 9` | **N 番目のタブ**へジャンプ |
| `⌘ + W` | アクティブタブを閉じる（タブが無くなったらウィンドウを閉じる） |
| `⌘ + R` | アクティブタブの内容をディスクから**再読込** |

トラックパッドの **2 本指スワイプ**でも、戻る／進むができます。

---

## 対応している拡張子

デフォルトで以下を「ビューアブル」扱いします。<br>
追加したい拡張子は**設定モーダル**から自由に増やせます（小文字、ドット無し、カンマ／改行区切り）。

- Markdown: `.md` / `.markdown` / `.mdown` / `.mkd`
- 既定追加: `.yaml` / `.yml` / `.json`

Markdown 以外はシンタックスハイライト付きのコードブロックとしてレンダリングされます。

---

## 動作環境

- macOS（Apple Silicon を主に動作確認、Intel もビルド可）
- Electron 42 / React 19 / TypeScript / Vite
- Markdown レンダリング: `markdown-it` + `highlight.js` + `mermaid` + `@xyflow/react`
- ファイルアクセス: File System Access API（Electron の secure context 経由で永続化）

---

## 開発

```bash
# 型チェックつきビルド
npm run build

# Lint
npm run lint

# DMG を出力（release/ に出ます）
npm run dist
```

主要なディレクトリ：

```
src/
├── components/   # TreeView, Preview, GraphView, SettingsModal …
├── hooks/        # useDirectory, useTabs, useContentSearch, useSettings …
├── lib/          # markdown / mermaid / linkGraph / searchContent / paths
└── App.tsx       # ぜんぶの司令塔
electron/
├── main.ts       # メインプロセス（ファイル IPC、Git、ウィンドウ制御）
└── preload.ts    # contextBridge 経由のレンダラ API
```

---

## ライセンス

MIT.

---

<p align="center">
  <em>「あの知識のフォルダ」を、もう一度きれいに歩けるように。</em>
</p>
