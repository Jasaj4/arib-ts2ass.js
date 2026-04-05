#!/usr/bin/env node
/**
 * arib-ts2ass.js — MPEG-TS 録画ファイルから ARIB B24 字幕を ASS 形式に変換
 *
 * aribb24.js のキャンバスレンダラーに擬似キャンバスを渡し、
 * レンダラーが計算した正確な位置・色・サイズを記録して ASS に変換する。
 *
 * Usage:
 *   node arib-ts2ass.js <input.ts> [output.ass]
 *   node arib-ts2ass.js <input.ts> --json <output.json>
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  demuxMPEGTS,
  ARIBB24JapaneseJIS8Tokenizer,
  ARIBB24Parser,
  ARIBB24JapaneseInitialParserState,
  canvasRenderingStrategy,
  CanvasRenderingOption,
} from 'aribb24.js';

// ============================================================
// Recording Canvas — aribb24.js レンダラーの描画命令を記録
// ============================================================

class MockPath2D {
  constructor(d) { this.d = d || ''; }
}

class RecordingContext {
  constructor() {
    this.characterEvents = [];
    this.drcsEvents = [];
    this.rectEvents = [];
    // Transform state (renderer always does: setTransform(identity) → translate → scale → draw)
    this._tx = 0; this._ty = 0;
    this._sx = 1; this._sy = 1;
    // Style state
    this.fillStyle = '';
    this.strokeStyle = '';
    this.font = '';
    this.textBaseline = '';
    this.textAlign = '';
    this.lineWidth = 0;
    this.lineJoin = '';
    // Pending ornament (strokeText/stroke before fillText/fill)
    this._pendingOrnament = null;
  }

  // --- Transform ---
  translate(x, y) { this._tx += x; this._ty += y; }
  scale(sx, sy) { this._sx *= sx; this._sy *= sy; }
  setTransform(a, _b, _c, d, e, f) {
    this._sx = a; this._sy = d; this._tx = e; this._ty = f;
  }

  // --- Drawing ---
  clearRect() {}
  fillRect(x, y, w, h) {
    // Record fillRects drawn in non-identity transform (highlight / underline borders)
    // Background fills happen at identity transform and are skipped.
    if (this._tx !== 0 || this._ty !== 0 || this._sx !== 1 || this._sy !== 1) {
      this.rectEvents.push({
        x: this._tx + x * this._sx,
        y: this._ty + y * this._sy,
        w: w * this._sx,
        h: h * this._sy,
        fillStyle: this.fillStyle,
      });
    }
  }

  // --- Text (character rendering) ---
  strokeText(_text, _x, _y, _maxWidth) {
    this._pendingOrnament = { color: this.strokeStyle, lineWidth: this.lineWidth };
  }

  fillText(text, _x, _y, maxWidth) {
    // fillText is called at (0, 0) after translate(centerX, centerY) + scale(sx, sy)
    this.characterEvents.push({
      text,
      centerX: this._tx,
      centerY: this._ty,
      scaleY: this._sy,
      fillStyle: this.fillStyle,
      font: this.font,
      maxWidth,
      ornament: this._pendingOrnament,
    });
    this._pendingOrnament = null;
  }

  // --- Path (DRCS / glyph rendering) ---
  stroke(_path2d) {
    this._pendingOrnament = { color: this.strokeStyle, lineWidth: this.lineWidth };
  }

  fill(path2d) {
    if (path2d?.d != null) {
      this.drcsEvents.push({
        tx: this._tx, ty: this._ty,
        sx: this._sx, sy: this._sy,
        fillStyle: this.fillStyle,
        ornament: this._pendingOrnament,
      });
      this._pendingOrnament = null;
    }
  }
}

class RecordingCanvas {
  constructor(w, h) {
    this.width = w; this.height = h;
    this._ctx = new RecordingContext();
  }
  getContext() { return this._ctx; }
}

// ============================================================
// ASS helpers
// ============================================================

/** #RRGGBBAA (CSS/aribb24.js colortable) → &HAABBGGRR (ASS) */
function cssColorToASS(css) {
  if (!css || !css.startsWith('#') || css.length < 7) return '&H00FFFFFF';
  const r = css.slice(1, 3), g = css.slice(3, 5), b = css.slice(5, 7);
  const a = css.length >= 9 ? css.slice(7, 9) : 'FF';
  const aa = (255 - parseInt(a, 16)).toString(16).padStart(2, '0').toUpperCase();
  return `&H${aa}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** DRCS ビットマップを ASS 描画コマンドに変換 (既存ロジック維持) */
function drcsToDrawing(token) {
  const buf = new Uint8Array(token.binary);
  const { width, height, depth } = token;
  const mask = (1 << depth) - 1;
  const cmds = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const bp = (y * width + x) * depth;
      if (((buf[bp >> 3] >> ((8 - depth) - (bp & 7))) & mask) > 0) {
        const sx = x;
        while (x < width) {
          const b2 = (y * width + x) * depth;
          if (((buf[b2 >> 3] >> ((8 - depth) - (b2 & 7))) & mask) <= 0) break;
          x++;
        }
        cmds.push(`m ${sx} ${y} l ${x} ${y} ${x} ${y + 1} ${sx} ${y + 1}`);
      } else { x++; }
    }
  }
  return cmds.join(' ');
}

// ============================================================
// ASS generation — Recording Canvas 経由
// ============================================================

const rendererOption = CanvasRenderingOption.from({});
const captionInfo = { association: 'ARIB', language: 'jpn' };
const require = createRequire(import.meta.url);

function generateASS(source, entries) {
  const firstParsed = entries.find(e => e.parsed?.some(p => p.state?.plane));
  const plane = firstParsed?.parsed.find(p => p.state?.plane)?.state.plane || [1920, 1080];

  const header = `\ufeff[Script Info]
Title: ${source || 'ARIB B24 Subtitles'}
ScriptType: v4.00+
PlayResX: ${plane[0]}
PlayResY: ${plane[1]}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap_Default,Hiragino Maru Gothic Pro,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogues = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const parsed = entry.parsed;
    if (!parsed || parsed.length === 0) continue;

    const hasContent = parsed.some(p => p.tag === 'Character' || p.tag === 'DRCS');
    if (!hasContent) continue;

    // --- Timing ---
    const pts = entry.pts;
    const lastElapsed = parsed.reduce((max, p) => Math.max(max, p.state?.elapsed_time || 0), 0);
    let endTime;
    if (lastElapsed > 0) {
      endTime = pts + lastElapsed;
    } else {
      const nextEntry = entries.slice(i + 1).find(e =>
        e.parsed?.some(p => p.tag === 'Character' || p.tag === 'DRCS'));
      endTime = nextEntry ? Math.min(nextEntry.pts, pts + 10) : pts + 5;
    }
    const startStr = formatASSTime(pts);
    const endStr = formatASSTime(endTime);

    // --- aribb24.js レンダラーで描画を記録 ---
    const canvas = new RecordingCanvas(plane[0], plane[1]);
    canvasRenderingStrategy(canvas, MockPath2D, [1, 1], parsed, captionInfo, rendererOption);
    const { characterEvents, drcsEvents, rectEvents } = canvas._ctx;

    // --- Highlight 枠線を ASS 描画コマンドに変換 (テキストより先に描画) ---
    if (rectEvents.length > 0) {
      const byColor = {};
      for (const r of rectEvents) (byColor[r.fillStyle] ??= []).push(r);
      for (const [color, rects] of Object.entries(byColor)) {
        const drawing = rects.map(r => {
          const x1 = Math.round(r.x);
          const y1 = Math.round(r.y);
          const x2 = Math.round(r.x + r.w);
          const y2 = Math.round(r.y + r.h);
          return `m ${x1} ${y1} l ${x2} ${y1} ${x2} ${y2} ${x1} ${y2}`;
        }).join(' ');
        const assColor = cssColorToASS(color);
        const assText = `{\\pos(0,0)\\an7}{\\c${assColor}\\bord0\\shad0}{\\p1}${drawing}{\\p0}`;
        dialogues.push(`Dialogue: 0,${startStr},${endStr},Cap_Default,,0,0,0,,${assText}`);
      }
    }

    // --- 記録とパーストークンを対応付けて ASS Dialogue 生成 ---
    let charIdx = 0, drcsIdx = 0;
    for (const token of parsed) {
      if (token.tag === 'Character' && charIdx < characterEvents.length) {
        const ev = characterEvents[charIdx++];

        // Position: レンダラーが計算した文字セルの中心
        const cx = Math.round(ev.centerX);
        const cy = Math.round(ev.centerY);

        // Font size: レンダラーの font プロパティから取得
        const fontSize = parseFloat(ev.font) || 72;

        // Scale: scaleX は maxWidth/fontSize、scaleY はキャンバス変換から
        const maxWidth = ev.maxWidth ?? fontSize;
        const scaleX = maxWidth / fontSize;
        const scaleY = ev.scaleY;

        // 半角置換の検出 (レンダラーが内部で変換済み)
        const isHalfwidth = (token.character !== ev.text);
        const fscx = isHalfwidth ? 100 : Math.round(scaleX * 100);
        const fscy = Math.round(scaleY * 100);

        // Colors
        const fgColor = cssColorToASS(ev.fillStyle);
        const ornStr = ev.ornament
          ? `\\3c${cssColorToASS(ev.ornament.color)}\\bord3`
          : '\\3c&H00000000\\bord3';

        // Underline / Flashing (レンダラーでは fillRect で描画されるが ASS ではタグで)
        let extra = '';
        if (token.state?.underline) extra += '\\u1';
        if (token.state?.flashing === 0x40)
          extra += '\\t(0,500,\\alpha&HFF&)\\t(500,1000,\\alpha&H00&)';
        else if (token.state?.flashing === 0x47)
          extra += '\\alpha&HFF&\\t(0,500,\\alpha&H00&)\\t(500,1000,\\alpha&HFF&)';

        // Character (ASS escaping)
        let c = ev.text;
        if (c === '\\') c = '\\\\';
        else if (c === '{') c = '\\{';
        else if (c === '}') c = '\\}';

        const overrides = `\\c${fgColor}\\fs${fontSize}\\fscx${fscx}\\fscy${fscy}${ornStr}${extra}`;
        const assText = `{\\pos(${cx},${cy})\\an5}{${overrides}}${c}`;
        dialogues.push(`Dialogue: 0,${startStr},${endStr},Cap_Default,,0,0,0,,${assText}`);

      } else if (token.tag === 'DRCS' && drcsIdx < drcsEvents.length) {
        const ev = drcsEvents[drcsIdx++];

        // Position & scale: レンダラーから (DRCS はオフセット込みの位置)
        const x = Math.round(ev.tx);
        const y = Math.round(ev.ty);
        const drawScaleX = Math.round(ev.sx * 100);
        const drawScaleY = Math.round(ev.sy * 100);

        // Colors
        const fgColor = cssColorToASS(ev.fillStyle);
        const ornStr = ev.ornament
          ? `\\3c${cssColorToASS(ev.ornament.color)}\\bord3`
          : '\\3c&H00000000\\bord3';

        // Drawing: 既存の DRCS→ASS 描画変換 (ビットマップ処理は維持)
        const drawing = drcsToDrawing(token);

        const overrides = `\\c${fgColor}${ornStr}`;
        const assText = `{\\pos(${x},${y})\\an7}{${overrides}}{\\p1\\fscx${drawScaleX}\\fscy${drawScaleY}}${drawing}{\\p0}`;
        dialogues.push(`Dialogue: 0,${startStr},${endStr},Cap_Default,,0,0,0,,${assText}`);
      }
    }
  }

  return header + dialogues.join('\n') + '\n';
}

// ============================================================
// Serialization helpers (for --json)
// ============================================================

function bufferToBase64(v) {
  return Buffer.from(v instanceof ArrayBuffer ? v : v.buffer).toString('base64');
}

function serializeToken(token) {
  const obj = { tag: token.tag };
  for (const [k, v] of Object.entries(token)) {
    if (k === 'tag') continue;
    obj[k] = (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) ? bufferToBase64(v) : v;
  }
  return obj;
}

function serializeParsed(parsed) {
  const obj = { tag: parsed.tag };
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'tag') continue;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      obj[k] = bufferToBase64(v);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) {
        nested[nk] = (nv instanceof ArrayBuffer || ArrayBuffer.isView(nv)) ? bufferToBase64(nv) : nv;
      }
      obj[k] = nested;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

// ============================================================
// CLI
// ============================================================

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`arib-ts2ass.js — ARIB B24 字幕を ASS に変換

Usage:
  node arib-ts2ass.js <input.ts> [output.ass]
  node arib-ts2ass.js <input.ts> --json <output.json>  デバッグ用 JSON も出力
  node arib-ts2ass.js --viewer                          デバッグビューアを開く

Options:
  --json <path>   中間 JSON ファイルを出力 (デバッグ用)
  --viewer        ブラウザでデバッグビューアを起動
  -h, --help      ヘルプを表示`);
  process.exit(0);
}

// --- Debug Viewer モード ---
if (args.includes('--viewer')) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const viewerDir = join(__dirname, 'debug-viewer');
  let viteBin;
  try {
    const viteEntry = require.resolve('vite');
    viteBin = join(viteEntry, '..', '..', '..', 'bin', 'vite.js');
  } catch {
    console.error('デバッグビューアを起動できません: `npm install` で依存関係をインストールしてください。');
    process.exit(1);
  }
  console.log('デバッグビューアを起動中...');
  const vite = spawn(process.execPath, [viteBin, viewerDir, '--open'], {
    stdio: 'inherit',
  });
  vite.on('error', (err) => {
    console.error(`起動エラー: ${err.message}`);
    process.exit(1);
  });
  vite.on('exit', (code) => process.exit(code ?? 0));
  // vite が終了するまでメインの変換処理には進まない
  await new Promise(() => {}); // block forever
}

if (args.length === 0) {
  console.log('Usage: node arib-ts2ass.js <input.ts> [output.ass]  (--help で詳細表示)');
  process.exit(0);
}

const inputPath = args[0];
let outputPath = null;
let jsonPath = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--json' && args[i + 1]) {
    jsonPath = args[++i];
  } else if (!outputPath) {
    outputPath = args[i];
  }
}
if (!outputPath) {
  outputPath = inputPath.replace(/\.[^.]+$/, '.ass');
}

// --- Extract ---
console.log(`入力: ${inputPath}`);

const nodeStream = createReadStream(inputPath);
const webStream = Readable.toWeb(nodeStream);
const tokenizer = new ARIBB24JapaneseJIS8Tokenizer();
const entries = [];
let count = 0;

process.stdout.write('字幕抽出中...');

try {
  for await (const entry of demuxMPEGTS(webStream, { type: 'Caption' })) {
    try {
      const tokens = tokenizer.tokenize(entry.data);
      const parser = new ARIBB24Parser(ARIBB24JapaneseInitialParserState);
      const parsed = parser.parse(tokens);
      entries.push({ pts: entry.pts, dts: entry.dts, raw: entry, tokens, parsed });
      count++;
      if (count % 100 === 0) process.stdout.write(`\r字幕抽出中... ${count} 件`);
    } catch {
      // skip unparseable
    }
  }
} catch (e) {
  console.error(`\ndemux エラー: ${e.message}`);
}

console.log(`\r抽出完了: ${entries.length} 件`);

// --- Generate ASS (raw parsed tokens → recording canvas → ASS) ---
const ass = generateASS(inputPath, entries);
writeFileSync(outputPath, ass);

const lineCount = ass.split('\n').filter(l => l.startsWith('Dialogue:')).length;
console.log(`ASS 出力: ${outputPath} (${lineCount} ダイアログ行)`);

// --- Optional JSON ---
if (jsonPath) {
  const jsonEntries = entries.map(({ pts, dts, raw, tokens, parsed }) => ({
    tag: raw.tag, pts, dts,
    data: {
      tag: raw.data.tag, group: raw.data.group,
      ...(raw.data.tag === 'CaptionManagement' ? {
        languages: raw.data.languages, timeControlMode: raw.data.timeControlMode,
      } : {}),
      ...(raw.data.tag === 'CaptionStatement' ? {
        lang: raw.data.lang, timeControlMode: raw.data.timeControlMode,
      } : {}),
      units: raw.data.units.map(u => ({
        tag: u.tag,
        ...(u.tag === 'DRCS' ? { bytes: u.bytes } : {}),
        dataBase64: Buffer.from(u.data).toString('base64'),
      })),
    },
    tokens: tokens.map(serializeToken),
    parsed: parsed.map(serializeParsed),
    text: tokens.filter(t => t.tag === 'Character').map(t => t.character).join(''),
  }));

  await writeFile(jsonPath, JSON.stringify({
    source: inputPath,
    extractedAt: new Date().toISOString(),
    totalEntries: jsonEntries.length,
    entries: jsonEntries,
  }, null, 2));
  console.log(`JSON 出力: ${jsonPath}`);
}
