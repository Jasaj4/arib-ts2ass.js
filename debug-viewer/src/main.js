import {
  demuxMPEGTS,
  ARIBB24JapaneseJIS8Tokenizer,
  ARIBB24Parser,
  ARIBB24JapaneseInitialParserState,
  canvasRenderingStrategy,
  CanvasRenderingOption,
} from 'aribb24.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const controls = document.getElementById('controls');
const statusEl = document.getElementById('status');
const canvasEl = document.getElementById('subtitle-canvas');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnAutoPlay = document.getElementById('btn-autoplay');
const captionInfo = document.getElementById('caption-info');

let captions = [];       // { pts, tokens (ARIBB24Token[]), rawEntry }
let currentIndex = -1;
let autoPlayTimer = null;
let currentFileName = '';

const tokenizer = new ARIBB24JapaneseJIS8Tokenizer();

const rendererOption = CanvasRenderingOption.from({
  color: {
    stroke: 'black',
  },
});

function log(msg) {
  statusEl.textContent = msg;
  console.log('[ARIB]', msg);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
}

function renderCaption(index) {
  const ctx = canvasEl.getContext('2d');
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  if (index < 0 || index >= captions.length) {
    captionInfo.textContent = `-- / ${captions.length}`;
    return;
  }

  currentIndex = index;
  const cap = captions[index];

  // Parse tokens into renderable parsed tokens
  const parser = new ARIBB24Parser(
    ARIBB24JapaneseInitialParserState,
  );
  const parsed = parser.parse(cap.tokens);

  // CaptionAssociationInformation for rendering
  const info = {
    association: 'ARIB',
    language: 'jpn',
  };

  // Render onto canvas
  canvasRenderingStrategy(
    canvasEl,
    Path2D,
    [1, 1],  // magnification (座標系が既に1920x1080)
    parsed,
    info,
    rendererOption,
  );

  captionInfo.textContent =
    `${index + 1} / ${captions.length}  |  PTS: ${formatTime(cap.pts)}`;
}

// --- Navigation ---
btnPrev.addEventListener('click', () => {
  if (currentIndex > 0) renderCaption(currentIndex - 1);
});
btnNext.addEventListener('click', () => {
  if (currentIndex < captions.length - 1) renderCaption(currentIndex + 1);
});
btnAutoPlay.addEventListener('click', () => {
  if (autoPlayTimer) {
    clearInterval(autoPlayTimer);
    autoPlayTimer = null;
    btnAutoPlay.textContent = '自動再生';
    return;
  }
  btnAutoPlay.textContent = '停止';
  autoPlayTimer = setInterval(() => {
    if (currentIndex < captions.length - 1) {
      renderCaption(currentIndex + 1);
    } else {
      clearInterval(autoPlayTimer);
      autoPlayTimer = null;
      btnAutoPlay.textContent = '自動再生';
    }
  }, 1500);
});

// --- Drop zone ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) loadFile(fileInput.files[0]);
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (currentIndex > 0) renderCaption(currentIndex - 1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (currentIndex < captions.length - 1) renderCaption(currentIndex + 1);
  }
});

// --- JSON Save ---
const btnSaveJson = document.getElementById('btn-save-json');
btnSaveJson.addEventListener('click', () => {
  if (captions.length === 0) return;

  const output = {
    source: currentFileName,
    extractedAt: new Date().toISOString(),
    totalEntries: captions.length,
    entries: captions.map((cap) => {
      const entry = cap.rawEntry;
      const record = {
        tag: entry.tag,
        pts: entry.pts,
        dts: entry.dts,
        data: {
          tag: entry.data.tag,
          group: entry.data.group,
        },
      };
      if (entry.data.tag === 'CaptionManagement') {
        record.data.languages = entry.data.languages;
        record.data.timeControlMode = entry.data.timeControlMode;
        if ('offsetTime' in entry.data) record.data.offsetTime = entry.data.offsetTime;
      }
      if (entry.data.tag === 'CaptionStatement') {
        record.data.lang = entry.data.lang;
        record.data.timeControlMode = entry.data.timeControlMode;
        if ('presentationStartTime' in entry.data) {
          record.data.presentationStartTime = entry.data.presentationStartTime;
        }
      }
      record.data.units = entry.data.units.map((unit) => ({
        tag: unit.tag,
        ...(unit.tag === 'DRCS' ? { bytes: unit.bytes } : {}),
        dataBase64: arrayBufferToBase64(unit.data),
      }));
      record.tokens = cap.tokens.map(serializeToken);
      record.text = cap.tokens
        .filter((t) => t.tag === 'Character')
        .map((t) => t.character)
        .join('');
      return record;
    }),
  };

  const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentFileName.replace(/\.[^.]+$/, '_subtitles.json');
  a.click();
  URL.revokeObjectURL(url);
  log('JSONを保存しました');
});

// --- PNG Save ---
const btnSavePng = document.getElementById('btn-save-png');
btnSavePng.addEventListener('click', () => {
  if (currentIndex < 0) return;
  const tmp = document.createElement('canvas');
  tmp.width = canvasEl.width;
  tmp.height = canvasEl.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvasEl, 0, 0);
  const a = document.createElement('a');
  a.href = tmp.toDataURL('image/png');
  a.download = `${currentFileName.replace(/\.[^.]+$/, '')}_${currentIndex + 1}.png`;
  a.click();
  log('PNGを保存しました');
});

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function serializeToken(token) {
  const obj = { tag: token.tag };
  for (const [k, v] of Object.entries(token)) {
    if (k === 'tag') continue;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      obj[k] = arrayBufferToBase64(v);
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

async function loadFile(file) {
  currentFileName = file.name;
  log(`読み込み中: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

  // Reset state
  captions = [];
  currentIndex = -1;
  if (autoPlayTimer) {
    clearInterval(autoPlayTimer);
    autoPlayTimer = null;
    btnAutoPlay.textContent = '自動再生';
  }

  // Show controls
  controls.style.display = 'flex';

  // Canvas size: 1920x1080 (地デジ HD)
  canvasEl.width = 1920;
  canvasEl.height = 1080;
  canvasEl.style.display = 'block';

  log('字幕データを抽出中...');

  try {
    const stream = file.stream();
    const demuxIter = demuxMPEGTS(stream, {
      type: 'Caption',
    });

    let count = 0;
    for await (const entry of demuxIter) {
      // entry: { tag, pts, dts, data: ARIBB24CaptionData }
      if (entry.data.tag !== 'CaptionStatement') continue;

      try {
        const tokens = tokenizer.tokenize(entry.data);
        if (tokens.length > 0) {
          captions.push({
            pts: entry.pts,
            tokens,
            rawEntry: entry,
          });
          count++;
          if (count % 10 === 0) {
            log(`字幕抽出中... ${count} 件`);
          }
        }
      } catch (e) {
        console.warn('tokenize error at pts', entry.pts, e);
      }
    }

    // Sort by PTS
    captions.sort((a, b) => a.pts - b.pts);

    log(`抽出完了: ${captions.length} 件の字幕`);

    // Show first caption
    if (captions.length > 0) {
      renderCaption(0);
    }
  } catch (e) {
    console.error('demux error:', e);
    log(`エラー: ${e.message}`);
  }
}
