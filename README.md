# arib-ts2ass.js

MPEG-TS 録画ファイルから ARIB STD-B24 字幕を抽出し、ASS (Advanced SubStation Alpha) 字幕ファイルに変換するCLIツール。

Node.js のみで動作し、C/C++ コンパイラ等のネイティブビルド環境は不要。

ARIB 字幕のデマルチプレクスとパースという一番重い部分は [aribb24.js](https://github.com/monyone/aribb24.js) がすべてやってくれている。本ツールはその出力を ASS 形式に整形しているだけ。aribb24.js の作者 [@monyone](https://github.com/monyone) 氏に感謝。現在は[フォーク版](https://github.com/Jasaj4/aribb24.js)を使用している（バグ修正のため）。

## 背景

既存の TS → ASS 変換ツールとして [arib2ass](https://github.com/Piro77/arib2ass) があるが、以下の課題がある:

- C で書かれておりビルドが必要（環境構築の手間、クロスプラットフォーム対応の難しさ）
- DRCS（放送局が独自定義するビットマップ文字）を処理できない

本ツールは JavaScript で実装されている。DRCS は ASS のドローイングコマンド (`\p1`) でベクター描画として埋め込むため、放送局独自の記号も再現される。

## 必要環境

- Node.js >= 18

## インストール

```bash
git clone --recursive https://github.com/Jasaj4/arib-ts2ass.js.git
cd arib-ts2ass.js
cd lib/aribb24.js && npm install && npm run build:all && cd ../..
npm install
```

サブモジュール (aribb24.js) のビルドに TypeScript と Vite が必要だが、aribb24.js の devDependencies に含まれているため別途インストールは不要。

デバッグビューア (`--viewer`) もこの依存関係のインストールで使えるようになる。

## 使い方

```bash
node arib-ts2ass.js <入力.ts> [出力.ass]
```

出力パスを省略すると `入力ファイル名.ass` に出力される。

```bash
node arib-ts2ass.js 録画.ts
node arib-ts2ass.js 録画.ts 字幕.ass
```

デバッグ用に中間 JSON も同時に出力できる:

```bash
node arib-ts2ass.js 録画.ts 字幕.ass --json debug.json
```

## デバッグビューア

TS ファイルから字幕を抽出し、ブラウザ上で1つずつ確認できる Web ツール。

```bash
node arib-ts2ass.js --viewer
```

ブラウザが自動で開き、TS ファイルをドラッグ＆ドロップで読み込める。矢印キーで字幕を送り、PNG 保存で現在の描画結果をスクリーンショットとして保存できる。

依存関係が未インストールの場合は、先に `npm install` を実行する。

## 出力仕様

- **解像度**: 1920x1080 (PlayRes)
- **フォント**: Hiragino Maru Gothic Pro (macOS標準搭載)
- **スタイル名**: `Cap_Default`
- **字幕位置**: ARIB B24 仕様通りの絶対座標配置
- **DRCS**: ASS ドローイングコマンド (`\p1`) でベクター描画
- **カラー**: ARIB 128色パレットに準拠

## 対応フォーマット

### 入力

- MPEG-TS (.ts, .m2ts, .mts)
- 日本の地上デジタル放送の字幕 (ARIB STD-B24 JIS8)

### 出力

- ASS v4+ (Advanced SubStation Alpha)

## 依存パッケージ

- [aribb24.js](https://github.com/Jasaj4/aribb24.js) — ARIB B24 デマルチプレクサ・パーサー（[monyone/aribb24.js](https://github.com/monyone/aribb24.js) のフォーク。ひらがなが欠落するバグを修正）
