/* =========================================================
   単語クイズ  script.js
   ---------------------------------------------------------
   1. 共通ユーティリティ・保存
   2. 問題の解析（入力テキスト → 問題データ）
   3. 学習記録（正誤・ピン）
   4. 入力タブ
   5. クイズ設定タブ
   6. クイズ本体
   7. 結果画面
   8. 単語帳・赤シート
   9. 保存場所・ファイル入出力
  10. 変換ツール
  11. 音声読み上げ
  12. モーダル・トースト・紙吹雪
  13. 初期化
   ========================================================= */
'use strict';

/* ---------- 1. 共通ユーティリティ・保存 ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KEYS = { text: 'tq.text', stats: 'tq.stats', store: 'tq.store', settings: 'tq.settings' };

const db = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('ブラウザに保存できませんでした（容量不足の可能性があります）'); return false; }
  }
};

const DEFAULTS = {
  mode: 'normal', order: 'straight', timer: 15,
  ignoreSpaces: true, ignoreBrackets: true,
  ttsLang: 'ja-JP', ttsAuto: false
};
let settings = Object.assign({}, DEFAULTS, db.get(KEYS.settings, {}));
let stats = db.get(KEYS.stats, {});   // { key: {c, w, pin, last} }
let questions = [];
let parseErrors = [];
let quiz = null;
let bookFilterKey = 'all', bookView = 'wb', rsMode = 'answer';

function saveSettings() { db.set(KEYS.settings, settings); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fmtDate(t) {
  const d = new Date(t);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 2. 問題の解析 ---------- */
// 表示用の内部記号
const B_TARGET = '\u0001';  // 答える空欄
const B_OTHER  = '\u0002';  // 隠れているだけの他の空欄（+++）
const M_OPEN   = '\u0003';  // 単語帳で答えを示す範囲の開始
const M_CLOSE  = '\u0004';  // 同 終了
const CIRCLED  = '①②③④⑤⑥⑦⑧⑨⑩';

function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// \ でエスケープされていない文字を探す（trackParen=true ならカッコの中は無視）
function findUnescaped(s, chars, trackParen = false) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (trackParen) {
      if (c === '(' || c === '（') { depth++; continue; }
      if (c === ')' || c === '）') { depth = Math.max(0, depth - 1); continue; }
      if (depth) continue;
    }
    if (chars.includes(c)) return i;
  }
  return -1;
}
function lastUnescaped(s, chars) {
  let r = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (chars.includes(s[i])) r = i;
  }
  return r;
}
function splitAt(s, idx) { return idx < 0 ? [s, null] : [s.slice(0, idx), s.slice(idx + 1)]; }
function splitAllUnescaped(s, chars) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (chars.includes(c)) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const unesc = (s) => s.replace(/\\(.)/g, '$1');
const clean = (s) => unesc(s.replace(/(^|[^\\])\^/g, '$1\n').replace(/(^|[^\\])\^/g, '$1\n')).trim();
const splitAlts = (s) => splitAllUnescaped(s, '|｜').map(clean).filter(Boolean);

function parseAll(text) {
  const qs = [], errs = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, ln) => {
    let line = raw.trim();
    if (!line) return;
    const sm = line.match(/^［([^］]*)］\s*(.*)$/);
    if (sm) {
      section = sm[1].trim();
      line = sm[2].trim();
      if (!line) return;
    }
    try {
      parseLine(line, section).forEach((q) => { q.line = ln + 1; qs.push(q); });
    } catch (e) {
      errs.push({ line: ln + 1, text: raw, msg: e.message });
    }
  });
  const seen = {};
  qs.forEach((q) => {
    const k = hashKey(q.type + '|' + q.q + '|' + q.a);
    seen[k] = (seen[k] || 0) + 1;
    q.key = seen[k] > 1 ? `${k}_${seen[k]}` : k;
  });
  return { qs, errs };
}

function parseLine(line, section) {
  let plus = 0;
  const pm = line.match(/^\+{1,3}/);
  if (pm) { plus = pm[0].length; line = line.slice(plus).trim(); }

  const [qRaw, rest] = splitAt(line, findUnescaped(line, '-－', true));
  if (!qRaw.trim()) throw new Error('問題文が空です');
  const base = { section };

  /* 記述・選択 */
  if (plus === 0) {
    if (rest === null) throw new Error('「-」で問題と答えを区切ってください');
    const r = rest.trim();
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(r)) return [parseMC(qRaw, r, base)];
    const [aRaw, eRaw] = splitAt(r, findUnescaped(r, '・'));
    const alts = splitAlts(aRaw);
    if (!alts.length) throw new Error('答えが空です');
    return [{ ...base, type: 'text', q: clean(qRaw), alts, a: alts.join(' ／ '), exp: eRaw ? clean(eRaw) : '' }];
  }

  /* 穴埋め */
  const src = qRaw.trim();
  const blanks = [];
  const re = /[(（]([^()（）]*)[)）]/g;
  let m;
  while ((m = re.exec(src))) blanks.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  if (!blanks.length) throw new Error('隠す部分を ( ) で囲んでください');

  let given = null, exp = '';
  if (rest !== null) {
    const r = rest.trim();
    const [aRaw, eRaw] = splitAt(r, findUnescaped(r, '・'));
    given = aRaw.trim() || null;
    exp = eRaw ? clean(eRaw) : '';
  }
  const build = (fn) => {
    let out = '', pos = 0;
    blanks.forEach((b, i) => { out += src.slice(pos, b.start) + fn(b, i); pos = b.end; });
    return clean(out + src.slice(pos));
  };
  const shown = (b) => splitAlts(b.text).join(' / ');

  if (plus === 1) {
    const texts = blanks.map((b) => splitAlts(b.text)[0] || '');
    const alts = given ? splitAlts(given) : [texts.join('、')];
    if (!alts.length || !alts[0]) throw new Error('( ) の中が空です');
    const multi = blanks.length > 1 && !given;
    if (!given && blanks.length === 1) alts.splice(0, 1, ...splitAlts(blanks[0].text));
    return [{
      ...base, type: 'fill',
      q: build(() => B_TARGET),
      sheet: build((b) => M_OPEN + shown(b) + M_CLOSE),
      alts, a: alts.join(' ／ '), exp, multi
    }];
  }

  // ++ / +++ : 空欄ごとに1問
  if (!exp && given) exp = clean(given);
  return blanks.map((b, i) => {
    const alts = splitAlts(b.text);
    if (!alts.length) throw new Error(`${i + 1}番目の ( ) の中が空です`);
    return {
      ...base, type: 'fill', long: true,
      q: build((bb, j) => (j === i ? B_TARGET : (plus === 2 ? shown(bb) : B_OTHER))),
      sheet: build((bb, j) => (j === i ? M_OPEN + shown(bb) + M_CLOSE : shown(bb))),
      alts, a: alts.join(' ／ '), exp
    };
  });
}

function parseMC(qRaw, r, base) {
  const eq = lastUnescaped(r, '=＝');
  if (eq < 0) throw new Error('選択問題は最後に「=②」のように正解を書いてください');
  const optStr = r.slice(0, eq);
  const [cRaw, eRaw] = splitAt(r.slice(eq + 1), findUnescaped(r.slice(eq + 1), '・'));
  const opts = optStr.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).slice(1).map(clean);
  if (opts.length < 2) throw new Error('選択肢は2つ以上必要です');
  if (opts.some((o) => !o)) throw new Error('空の選択肢があります');
  const c = cRaw.trim();
  let ans;
  if (c.length === 1 && CIRCLED.includes(c)) ans = CIRCLED.indexOf(c);
  else if (/^[0-9０-９]+$/.test(c)) ans = parseInt(c.normalize('NFKC'), 10) - 1;
  else ans = opts.indexOf(clean(c));
  if (!(ans >= 0 && ans < opts.length)) throw new Error('正解が選択肢の中にありません');
  return {
    ...base, type: 'mc', q: clean(qRaw), opts, ans,
    alts: [opts[ans]], a: `${CIRCLED[ans]} ${opts[ans]}`, exp: eRaw ? clean(eRaw) : ''
  };
}

// 表示用HTML
function qHTML(s) {
  return esc(s).replace(/\n/g, '<br>')
    .replace(/\u0001/g, '<span class="blank">？</span>')
    .replace(/\u0002/g, '<span class="blank sub">　</span>')
    .replace(/\u0003/g, '<span class="mark">')
    .replace(/\u0004/g, '</span>');
}
function plain(s, blankWord = '（　）') {
  return s.replace(/[\u0001\u0002]/g, blankWord).replace(/[\u0003\u0004]/g, '');
}
function typeBadge(q) {
  if (q.type === 'mc') return '<span class="tbadge mc">選択</span>';
  if (q.type === 'fill') return '<span class="tbadge fill">穴埋め</span>';
  return '<span class="tbadge">記述</span>';
}

// 答え合わせ用の正規化
function normalize(s, q, keepBrackets) {
  let t = String(s).normalize('NFKC').toLowerCase();
  if (settings.ignoreBrackets && !keepBrackets) t = t.replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, '');
  t = settings.ignoreSpaces ? t.replace(/\s+/g, '') : t.trim().replace(/\s+/g, ' ');
  if (q && q.multi) t = t.replace(/[、,/・\s]/g, '');
  return t;
}
function isCorrect(q, input) {
  return q.alts.some((a) => {
    // カッコを除くと答えが空になる場合はカッコを残して比べる
    const keep = normalize(a, q) === '';
    return normalize(a, q, keep) === normalize(input, q, keep);
  });
}

/* ---------- 3. 学習記録 ---------- */
function statOf(key) { return stats[key] || (stats[key] = { c: 0, w: 0, pin: false, last: null }); }
function saveStats() { db.set(KEYS.stats, stats); }
const isPinned = (k) => !!(stats[k] && stats[k].pin);
const isWrong  = (k) => !!(stats[k] && stats[k].last === false);
const isWeak   = (k) => { const s = stats[k]; return !!s && s.w > 0 && (s.w >= s.c || s.last === false); };
const weakScore = (k) => { const s = stats[k]; return s ? s.w * 2 - s.c + (s.last === false ? 3 : 0) : 0; };

function updHeader() {
  let c = 0, w = 0, p = 0;
  questions.forEach((q) => { const s = stats[q.key]; if (s) { c += s.c; w += s.w; if (s.pin) p++; } });
  $('hC').textContent = c; $('hI').textContent = w; $('hP').textContent = p;
}

function pinAt(i) {
  const q = questions[i]; if (!q) return;
  const s = statOf(q.key); s.pin = !s.pin; saveStats();
  toast(s.pin ? '📌 ピン留めしました' : 'ピンを外しました');
  renderInputList(); updHeader(); updStartBtns();
  if ($('tBook').style.display !== 'none') renderBook();
}

/* ---------- 4. 入力タブ ---------- */
let renderTimer = null;
function renderQList() { clearTimeout(renderTimer); renderTimer = setTimeout(refresh, 150); }

function refresh() {
  clearTimeout(renderTimer);
  const text = $('inputArea').value;
  db.set(KEYS.text, text);
  const r = parseAll(text);
  questions = r.qs; parseErrors = r.errs;
  renderInputList(); updHeader(); updStartBtns();
}

function renderInputList() {
  $('qCountLabel').textContent = `問題数：${questions.length}問` + (parseErrors.length ? `（エラー ${parseErrors.length}行）` : '');
  let h = '';
  parseErrors.forEach((e) => {
    h += `<div class="qerr"><b>${e.line}行目</b>：${esc(e.msg)}<code>${esc(e.text)}</code></div>`;
  });
  if (!questions.length && !parseErrors.length) {
    h = '<div class="qempty">上の欄に問題を入力すると、ここに一覧が表示されます</div>';
  }
  questions.forEach((q, i) => {
    const s = stats[q.key];
    h += `<div class="qi${s && s.pin ? ' pinned' : ''}">
      <div class="qi-n">${i + 1}</div>
      <div class="qi-body">
        <div class="qi-tags">${typeBadge(q)}${q.section ? `<span class="qi-sec">${esc(q.section)}</span>` : ''}${s && (s.c || s.w) ? `<span class="qi-st">✓${s.c} ✗${s.w}</span>` : ''}</div>
        <div class="qi-q">${qHTML(q.q)}</div>
        <div class="qi-a">${esc(q.a)}</div>
      </div>
      <button class="qi-pin" onclick="pinAt(${i})" aria-label="ピン留め" title="ピン留め">📌</button>
    </div>`;
  });
  $('qList').innerHTML = h;
}

function confirmClear() {
  if (!$('inputArea').value.trim()) { toast('削除する問題がありません'); return; }
  openModal('問題をすべて削除しますか？', '入力欄の内容が消えます。正解・不正解の記録とピンは残ります。', [
    { label: 'キャンセル' },
    { label: '削除する', cls: 'btn-red', fn: () => { $('inputArea').value = ''; refresh(); toast('削除しました'); } }
  ]);
}

const TAB_IDS = ['tInput', 'tQuiz', 'tBook', 'tStore', 'tConv'];
function showTab(id) {
  TAB_IDS.forEach((t) => {
    $(t).style.display = t === id ? '' : 'none';
    $('n' + t).classList.toggle('on', t === id);
  });
  if (id !== 'tInput') refresh();
  if (id === 'tBook') renderBook();
  if (id === 'tStore') renderStore();
  if (id === 'tConv') convCount();
}

function showScreen(id) {
  ['sHome', 'sQuiz', 'sResult'].forEach((s) => $(s).classList.toggle('on', s === id));
  window.scrollTo(0, 0);
}

/* ---------- 5. クイズ設定タブ ---------- */
function applySettingsUI() {
  document.querySelectorAll('.mcard').forEach((e) => e.classList.toggle('on', e.dataset.mode === settings.mode));
  document.querySelectorAll('.ocard').forEach((e) => e.classList.toggle('on', e.dataset.order === settings.order));
  $('timerCfg').classList.toggle('hid', settings.mode !== 'timeattack');
  $('timerRange').value = settings.timer;
  $('timerVal').textContent = settings.timer + '秒';
  $('ignoreSpaces').checked = settings.ignoreSpaces;
  $('ignoreBrackets').checked = settings.ignoreBrackets;
  $('ttsLang').value = settings.ttsLang;
  $('ttsAuto').checked = settings.ttsAuto;
}
function selMode(m) { settings.mode = m; saveSettings(); applySettingsUI(); }
function selOrder(o) { settings.order = o; saveSettings(); applySettingsUI(); }
function updTimer() {
  settings.timer = parseInt($('timerRange').value, 10) || 15;
  $('timerVal').textContent = settings.timer + '秒';
  saveSettings();
}

function updStartBtns() {
  const pins = questions.filter((q) => isPinned(q.key)).length;
  const wrong = questions.filter((q) => isWrong(q.key)).length;
  const weak = questions.filter((q) => isWeak(q.key)).length;
  const set = (id, n, label) => { $(id).style.display = n ? '' : 'none'; $(id).textContent = `${label}（${n}）`; };
  set('startPinBtn', pins, '📌 ピンのみ');
  set('startWrongBtn', wrong, '🔁 不正解のみ');
  set('startWeakBtn', weak, '🎯 弱点モード');
}

/* ---------- 6. クイズ本体 ---------- */
const cur = () => quiz.items[quiz.i];

function startQuiz(kind) {
  refresh();
  if (!questions.length) {
    toast('問題がありません。入力タブで問題を追加してください');
    showScreen('sHome'); showTab('tInput');
    return;
  }
  let pool = questions.slice();
  let order = settings.order;
  if (kind === 'pinned') pool = pool.filter((q) => isPinned(q.key));
  else if (kind === 'wrong') pool = pool.filter((q) => isWrong(q.key));
  else if (kind === 'weakness') {
    const weak = pool.filter((q) => isWeak(q.key));
    if (weak.length) pool = weak;
    order = 'weakness';
  }
  if (!pool.length) {
    toast(kind === 'pinned' ? 'ピン留めした問題がありません' : '該当する問題がありません');
    return;
  }
  if (order === 'random') shuffle(pool);
  else if (order === 'weakness') { shuffle(pool); pool.sort((a, b) => weakScore(b.key) - weakScore(a.key)); }

  quiz = { items: pool, i: 0, ok: 0, ng: 0, wrong: [], mode: settings.mode, answered: false, revealed: false, lockUntil: 0 };
  $('qOkCount').textContent = '✓ 0'; $('qNgCount').textContent = '✗ 0';
  showScreen('sQuiz');
  showQ();
}

function showQ() {
  const q = cur(), n = quiz.items.length, s = stats[q.key];
  quiz.answered = false; quiz.revealed = false;

  $('ppf').style.width = (quiz.i / n * 100) + '%';
  $('pplbl').textContent = `${quiz.i + 1}/${n}`;

  $('secLabel').style.display = q.section ? '' : 'none';
  $('secLabel').textContent = q.section || '';
  $('qNum').textContent = `問題 ${quiz.i + 1}`;
  $('pinInd').classList.toggle('show', isPinned(q.key));
  $('wBadge').classList.toggle('show', !!(s && s.w));
  $('wBadge').textContent = s && s.w ? `✗${s.w}回` : '';
  $('mcTag').classList.toggle('show', q.type === 'mc');
  $('sgTag').style.display = quiz.mode === 'selfgrade' && q.type !== 'mc' ? '' : 'none';
  $('fillTag').style.display = q.type === 'fill' ? '' : 'none';
  $('qPinBtn').classList.toggle('on', isPinned(q.key));

  const txt = $('qTxt');
  txt.innerHTML = qHTML(q.q);
  txt.classList.toggle('long', !!q.long || plain(q.q).length > 50);
  $('qCard').classList.remove('ok', 'ng');

  // 回答エリアのリセット
  ['fbCard', 'sgReveal', 'sgBtns'].forEach((id) => $(id).classList.remove('show'));
  $('nextBtn').style.display = 'none';
  $('ttsABtn').style.display = 'none';

  const input = $('ansInput');
  if (q.type === 'mc') {
    $('ansArea').style.display = 'none';
    $('checkBtn').style.display = 'none';
    const grid = $('mcGrid');
    grid.style.display = '';
    grid.innerHTML = q.opts.map((o, i) =>
      `<button class="mcopt" onclick="pickMC(${i})"><span class="mck">${CIRCLED[i]}</span><span>${esc(o).replace(/\n/g, '<br>')}</span></button>`).join('');
  } else {
    $('mcGrid').style.display = 'none';
    $('mcGrid').innerHTML = '';
    $('ansArea').style.display = '';
    input.value = '';
    input.disabled = false;
    input.className = 'ansi';
    const sg = quiz.mode === 'selfgrade';
    input.placeholder = sg ? '（任意）自分の答えをメモ…　Enterで正解を表示' : '答えを入力してください…（Enterで確定）';
    $('checkBtn').style.display = '';
    $('checkBtn').textContent = sg ? '正解を見る' : '答え合わせ';
    if (window.matchMedia('(hover: hover)').matches) input.focus();
  }

  const ring = $('tRing');
  ring.classList.toggle('show', quiz.mode === 'timeattack');
  if (quiz.mode === 'timeattack') startTimer(); else stopTimer();

  if (settings.ttsAuto) ttsQ();
}

function pickMC(i) {
  if (!quiz || quiz.answered) return;
  const q = cur();
  markMC(i);
  finish(i === q.ans, q.opts[i]);
}
function markMC(picked) {
  const q = cur();
  document.querySelectorAll('#mcGrid .mcopt').forEach((b, i) => {
    b.disabled = true;
    if (i === q.ans) b.classList.add('ok');
    else if (i === picked) b.classList.add('ng');
    else b.classList.add('dim');
  });
}

function checkAns() {
  if (!quiz || !$('sQuiz').classList.contains('on')) return;
  if (quiz.answered) { if (Date.now() >= quiz.lockUntil) nextQ(); return; }
  const q = cur();
  if (q.type === 'mc') return;
  const val = $('ansInput').value;
  if (quiz.mode === 'selfgrade') { if (!quiz.revealed) reveal(q); return; }
  finish(val.trim() !== '' && isCorrect(q, val), val);
}

function reveal(q) {
  quiz.revealed = true;
  $('sgAns').textContent = q.a;
  $('sgExp').style.display = q.exp ? '' : 'none';
  $('sgExp').textContent = q.exp;
  $('sgReveal').classList.add('show');
  $('sgBtns').classList.add('show');
  $('checkBtn').style.display = 'none';
  $('ansInput').disabled = true;
  if (settings.ttsAuto) ttsA();
}

function sgJudge(ok) {
  if (!quiz || quiz.answered || !quiz.revealed) return;
  $('sgBtns').classList.remove('show');
  finish(ok, $('ansInput').value);
  setTimeout(() => { if (quiz && quiz.answered) nextQ(true); }, 220);
}

function finish(correct, userAns, timeout = false) {
  const q = cur();
  quiz.answered = true;
  quiz.lockUntil = Date.now() + 300;
  stopTimer();

  const s = statOf(q.key);
  if (correct) s.c++; else s.w++;
  s.last = correct;
  saveStats();

  if (correct) quiz.ok++;
  else { quiz.ng++; quiz.wrong.push({ q, user: timeout && !userAns ? '（時間切れ）' : userAns }); }
  $('qOkCount').textContent = `✓ ${quiz.ok}`;
  $('qNgCount').textContent = `✗ ${quiz.ng}`;
  $('ppf').style.width = ((quiz.i + 1) / quiz.items.length * 100) + '%';
  updHeader();

  $('qCard').classList.add(correct ? 'ok' : 'ng');
  const input = $('ansInput');
  input.disabled = true;
  if (q.type !== 'mc') input.classList.add(correct ? 'ok' : 'ng');

  const selfJudged = quiz.mode === 'selfgrade' && q.type !== 'mc';
  if (!selfJudged) {
    const fb = $('fbCard');
    fb.className = 'fb show ' + (correct ? 'ok' : 'ng');
    $('fbLbl').textContent = correct ? '⭕ 正解！' : (timeout ? '⏰ 時間切れ' : '❌ 不正解');
    let ans = `${correct ? '答え' : '正解'}：<b>${esc(q.a)}</b>`;
    if (!correct && q.type !== 'mc') {
      ans += `<div class="fbyour">あなたの答え：${userAns && userAns.trim() ? esc(userAns) : '（未回答）'}</div>`;
    }
    $('fbAns').innerHTML = ans;
    document.querySelector('#fbCard .fbexlbl').style.display = q.exp ? '' : 'none';
    $('fbExp').style.display = q.exp ? '' : 'none';
    $('fbExp').textContent = q.exp;
    $('ttsABtn').style.display = '';
  }

  $('checkBtn').style.display = 'none';
  const next = $('nextBtn');
  next.style.display = '';
  next.textContent = quiz.i + 1 >= quiz.items.length ? '結果を見る' : '次の問題 →';
  if (!selfJudged) setTimeout(() => next.focus({ preventScroll: true }), 0);
}

function nextQ(force = false) {
  if (!quiz || !quiz.answered) return;
  if (!force && Date.now() < quiz.lockUntil) return;   // Enterの二重反応を防ぐ
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  quiz.i++;
  if (quiz.i >= quiz.items.length) showResult();
  else { showQ(); window.scrollTo(0, 0); }
}

function togglePin() {
  if (!quiz) return;
  const q = cur(), s = statOf(q.key);
  s.pin = !s.pin; saveStats();
  $('pinInd').classList.toggle('show', s.pin);
  $('qPinBtn').classList.toggle('on', s.pin);
  updHeader();
  toast(s.pin ? '📌 ピン留めしました' : 'ピンを外しました');
}

function confirmQuit() {
  const leave = () => goHome('tQuiz');
  if (!quiz || (quiz.i === 0 && !quiz.answered)) { leave(); return; }
  openModal('クイズを中断しますか？', 'ここまでに答えた問題の記録は保存されています。', [
    { label: '続ける' },
    { label: '中断する', cls: 'btn-red', fn: leave }
  ]);
}

function goHome(tab = 'tInput') {
  stopTimer();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  quiz = null;
  showScreen('sHome');
  showTab(tab);
}

/* タイマー */
const RING = 2 * Math.PI * 27;
let timerId = null;
function startTimer() {
  stopTimer();
  const total = settings.timer * 1000, end = Date.now() + total;
  const fg = $('tfg');
  fg.style.strokeDasharray = RING;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    fg.style.strokeDashoffset = RING * (1 - left / total);
    $('tnum').textContent = Math.ceil(left / 1000);
    $('tRing').classList.toggle('warn', left <= 5000);
    if (left <= 0) { stopTimer(); timeUp(); }
  };
  tick();
  timerId = setInterval(tick, 100);
}
function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
function timeUp() {
  if (!quiz || quiz.answered) return;
  const q = cur();
  if (q.type === 'mc') { markMC(-1); finish(false, '', true); return; }
  const val = $('ansInput').value;
  finish(val.trim() !== '' && isCorrect(q, val), val, true);
}

/* キーボード操作 */
function onKey(e) {
  if ($('modal').classList.contains('show')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (!quiz || !$('sQuiz').classList.contains('on')) return;
  const q = cur();
  const tag = e.target.tagName;
  if (!quiz.answered && q.type === 'mc' && /^[1-9]$/.test(e.key)) {
    const n = +e.key - 1;
    if (n < q.opts.length) { e.preventDefault(); pickMC(n); }
    return;
  }
  if (quiz.revealed && !quiz.answered && tag !== 'INPUT') {
    if (e.key === 'o' || e.key === 'O') { sgJudge(true); return; }
    if (e.key === 'x' || e.key === 'X') { sgJudge(false); return; }
  }
  if (e.key === 'Enter' && quiz.answered && tag !== 'BUTTON' && tag !== 'INPUT' && Date.now() >= quiz.lockUntil) {
    e.preventDefault(); nextQ();
  }
}

/* ---------- 7. 結果画面 ---------- */
function showResult() {
  stopTimer();
  const n = quiz.items.length, ok = quiz.ok, ng = quiz.ng;
  const pct = n ? Math.round(ok / n * 100) : 0;
  let emo, tit;
  if (pct === 100) { emo = '🏆'; tit = 'パーフェクト！'; }
  else if (pct >= 80) { emo = '🎉'; tit = 'よくできました'; }
  else if (pct >= 50) { emo = '💪'; tit = 'あと少し！'; }
  else { emo = '📚'; tit = '復習していきましょう'; }
  $('resEmo').textContent = emo;
  $('resTit').textContent = tit;
  $('resSub').textContent = `${n}問中 ${ok}問正解`;
  $('stC').textContent = ok;
  $('stI').textContent = ng;
  $('stP').textContent = pct + '%';

  $('wrongSec').style.display = ng ? '' : 'none';
  $('wrongList').innerHTML = quiz.wrong.map(({ q, user }) => `
    <div class="wl">
      <div class="wl-q">${qHTML(q.q)}</div>
      <div class="wl-a">正解：${esc(q.a)}</div>
      ${q.type !== 'mc' && user && user.trim() ? `<div class="wl-u">あなたの答え：${esc(user)}</div>` : ''}
    </div>`).join('');

  $('retryWrong').style.display = ng ? '' : 'none';
  $('retryPin').style.display = questions.some((q) => isPinned(q.key)) ? '' : 'none';

  showScreen('sResult');
  if (pct >= 80) confetti();
  quiz.answered = false;
}

/* ---------- 8. 単語帳・赤シート ---------- */
function setView(v) {
  bookView = v;
  $('vbWb').classList.toggle('on', v === 'wb');
  $('vbRs').classList.toggle('on', v === 'rs');
  renderBook();
}
function bkFilter(f, el) {
  bookFilterKey = f;
  document.querySelectorAll('.wbf').forEach((b) => b.classList.toggle('on', b === el));
  renderBook();
}
function rsSetMode(mode, el) {
  rsMode = mode;
  document.querySelectorAll('.rsmb').forEach((b) => b.classList.toggle('on', b === el));
  renderBook();
}
function rsHideAll() { document.querySelectorAll('#bookList .sheet').forEach((e) => e.classList.remove('open')); }
function rsShowAll() { document.querySelectorAll('#bookList .sheet').forEach((e) => e.classList.add('open')); }
function rsToggle(el) { el.classList.toggle('open'); }

function renderBook() {
  const rs = bookView === 'rs';
  $('wbtit').textContent = rs ? '🔴 赤シート' : '📖 単語帳';
  $('wbsub').textContent = rs ? '赤い部分をタップすると答えが見えます' : '問題と答えを一覧で確認できます';
  $('rsCtrls').style.display = rs ? 'flex' : 'none';

  const list = questions.filter((q) => {
    switch (bookFilterKey) {
      case 'pinned': return isPinned(q.key);
      case 'wrong':  return isWrong(q.key);
      case 'weak':   return isWeak(q.key);
      case 'mc':     return q.type === 'mc';
      default:       return true;
    }
  });
  $('wbCnt').textContent = `${list.length}件`;

  if (!list.length) {
    $('bookList').innerHTML = `<div class="storempty">${questions.length ? 'この条件に当てはまる問題はありません' : '入力タブで問題を追加すると、ここに表示されます'}</div>`;
    return;
  }
  $('bookList').innerHTML = list.map((q) => bookItem(q, rs)).join('');
}

function bookItem(q, rs) {
  const idx = questions.indexOf(q);
  const s = stats[q.key];
  const hideA = rs && rsMode === 'answer';
  const hideQ = rs && rsMode === 'question';
  const SH = 'class="sheet" onclick="rsToggle(this)"';

  let qBlock, aBlock = '';
  if (q.type === 'fill') {
    // 文の中の答えをオレンジで表示し、赤シートで隠す
    const inner = hideA ? `<span ${SH}>` : '<span class="mark">';
    const sentence = esc(q.sheet).replace(/\n/g, '<br>').replace(/\u0003/g, inner).replace(/\u0004/g, '</span>');
    if (hideQ) {
      qBlock = `<div class="bk-q sheet" onclick="rsToggle(this)">${sentence}</div>`;
      aBlock = `<div class="bk-a">${esc(q.a)}</div>`;
    } else {
      qBlock = `<div class="bk-q">${sentence}</div>`;
    }
  } else {
    qBlock = `<div class="bk-q${hideQ ? ' sheet" onclick="rsToggle(this)' : ''}">${qHTML(q.q)}</div>`;
    const body = q.type === 'mc'
      ? `<div class="bk-opts">${q.opts.map((o, i) => `<div class="bk-opt${i === q.ans ? ' ok' : ''}">${CIRCLED[i]} ${esc(o)}</div>`).join('')}</div>`
      : esc(q.a).replace(/\n/g, '<br>');
    aBlock = q.type === 'mc'
      ? (hideA ? `<div class="sheet" onclick="rsToggle(this)">${body}</div>` : body)
      : `<div class="bk-a${hideA ? ' sheet" onclick="rsToggle(this)' : ''}">${body}</div>`;
  }
  const exp = q.exp
    ? `<div class="bk-exp${hideA ? ' sheet" onclick="rsToggle(this)' : ''}">💡 ${esc(q.exp)}</div>` : '';

  return `<div class="bk${s && s.pin ? ' pinned' : ''}">
    <div class="bk-meta"><span>No.${idx + 1}</span>${typeBadge(q)}${q.section ? `<span>${esc(q.section)}</span>` : ''}${s && (s.c || s.w) ? `<span>✓${s.c} ✗${s.w}</span>` : ''}</div>
    ${qBlock}${aBlock}${exp}
    <button class="bk-pin" onclick="pinAt(${idx})" aria-label="ピン留め">📌</button>
  </div>`;
}

/* ---------- 9. 保存場所・ファイル入出力 ---------- */
const getStore = () => db.get(KEYS.store, []);
const countQ = (text) => parseAll(text || '').qs.length;

function renderStore() {
  const list = getStore();
  if (!list.length) {
    $('storageList').innerHTML = '<div class="storempty">保存されたデータはまだありません。<br>入力タブの「名前をつけて保存」で保存できます。</div>';
    return;
  }
  $('storageList').innerHTML = list.map((e, i) => `
    <div class="sti">
      <div class="sti-info">
        <div class="sti-name">${esc(e.name)}</div>
        <div class="sti-meta">${fmtDate(e.savedAt)}　${countQ(e.text)}問</div>
      </div>
      <div class="sti-acts">
        <button class="btn btn-ink btn-sm" onclick="storeLoad(${i})">読み込む</button>
        <button class="btn btn-out btn-sm" onclick="storeDownload(${i})">ファイルに書き出す</button>
        <button class="btn btn-dng btn-sm" onclick="storeDelete(${i})">削除</button>
      </div>
    </div>`).join('');
}

function defaultName() {
  const firstSec = questions.find((q) => q.section);
  if (firstSec) return firstSec.section;
  const d = new Date();
  return `単語クイズ_${d.getMonth() + 1}月${d.getDate()}日`;
}

function saveToFile() {
  refresh();
  if (!$('inputArea').value.trim()) { toast('保存する問題がありません'); return; }
  openModal('名前をつけて保存',
    `保存名<input type="text" id="saveName" value="${esc(defaultName())}" maxlength="60">
     <label class="ttog"><input type="checkbox" id="saveDl" checked> ファイル（.json）としてもダウンロードする</label>`,
    [
      { label: 'キャンセル' },
      { label: '保存する', cls: 'btn-ink', fn: () => {
          const name = ($('saveName').value || '').trim() || defaultName();
          const entry = { name, text: $('inputArea').value, savedAt: Date.now() };
          const list = getStore().filter((e) => e.name !== name);
          list.unshift(entry);
          if (db.set(KEYS.store, list)) toast(`「${name}」を保存しました`);
          if ($('saveDl').checked) downloadJSON(entry);
        } }
    ]);
  setTimeout(() => { const el = $('saveName'); if (el) { el.focus(); el.select(); } }, 50);
}

function downloadJSON(entry) {
  const keys = parseAll(entry.text).qs.map((q) => q.key);
  const sub = {};
  keys.forEach((k) => { if (stats[k]) sub[k] = stats[k]; });
  const data = { app: 'tango-quiz', version: 1, name: entry.name, savedAt: entry.savedAt, text: entry.text, stats: sub };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${entry.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadFromFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const raw = String(reader.result || '');
    let text = raw, imported = null;
    try {
      const data = JSON.parse(raw);
      if (data && typeof data.text === 'string') { text = data.text; imported = data.stats; }
      else if (Array.isArray(data)) text = data.join('\n');
      else throw new Error();
    } catch (e) {
      if (/\.json$/i.test(file.name)) { toast('このファイルは読み込めませんでした'); return; }
    }
    if (imported && typeof imported === 'object') {
      Object.keys(imported).forEach((k) => { if (!stats[k]) stats[k] = imported[k]; });
      saveStats();
    }
    applyText(text, `「${file.name}」を読み込みました`);
  };
  reader.onerror = () => toast('ファイルを読み込めませんでした');
  reader.readAsText(file);
}

// 入力欄に反映（中身があれば 置き換え／追加 を確認）
function applyText(text, doneMsg) {
  const area = $('inputArea');
  const put = (mode) => {
    if (mode === 'append') area.value = area.value.replace(/\s*$/, '') + '\n' + text;
    else area.value = text;
    showScreen('sHome'); showTab('tInput'); refresh();
    toast(doneMsg);
  };
  if (!area.value.trim()) { put('replace'); return; }
  openModal('入力欄に反映します', '入力欄にはすでに問題があります。どうしますか？', [
    { label: 'キャンセル' },
    { label: '末尾に追加', cls: 'btn-out', fn: () => put('append') },
    { label: '置き換える', cls: 'btn-ink', fn: () => put('replace') }
  ]);
}

function storeLoad(i) {
  const e = getStore()[i]; if (!e) return;
  applyText(e.text, `「${e.name}」を読み込みました`);
}
function storeDownload(i) { const e = getStore()[i]; if (e) downloadJSON(e); }
function storeDelete(i) {
  const list = getStore(), e = list[i]; if (!e) return;
  openModal('保存データを削除しますか？', `「${esc(e.name)}」を削除します。元に戻せません。`, [
    { label: 'キャンセル' },
    { label: '削除する', cls: 'btn-red', fn: () => { list.splice(i, 1); db.set(KEYS.store, list); renderStore(); toast('削除しました'); } }
  ]);
}

/* ---------- 10. 変換ツール ---------- */
const lines = (t) => t.split(/\r?\n/);
const CONV = {
  emptyLines: (t) => lines(t).filter((l) => l.trim()).join('\n'),
  numbers:    (t) => t.replace(/[0-9０-９]/g, ''),
  kanji:      (t) => t.replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF々〆ヵヶ]/g, ''),
  addPlus:    (t) => lines(t).map((l) => (/[(（][^()（）]*[)）]/.test(l) && !/^\s*\+/.test(l) ? '+' + l : l)).join('\n'),
  qaFormat:   (t) => {
    const out = []; let pending = null;
    const flush = () => { if (pending !== null) { out.push(pending); pending = null; } };
    const escQ = (s) => s.trim().replace(/-/g, '\\-');
    lines(t).map((l) => l.trim()).filter(Boolean).forEach((l) => {
      let m;
      if (/^［[^］]*］$/.test(l) || /^\+/.test(l)) { flush(); out.push(l); return; }
      if ((m = l.match(/^([^\t]+)\t+(.+)$/)))        { flush(); out.push(escQ(m[1]) + '-' + m[2].trim()); return; }
      if ((m = l.match(/^(.+?)\s*[：:]\s*(.+)$/)))   { flush(); out.push(escQ(m[1]) + '-' + m[2].trim()); return; }
      if ((m = l.match(/^(.+?)(?:　+| {2,})(.+)$/))) { flush(); out.push(escQ(m[1]) + '-' + m[2].trim()); return; }
      if (findUnescaped(l, '-－', true) > 0)         { flush(); out.push(l); return; }
      // 区切りがない行は「問題の行」「答えの行」の2行で1問とみなす
      if (pending === null) pending = l;
      else { out.push(escQ(pending) + '-' + l); pending = null; }
    });
    flush();
    return out.join('\n');
  }
};

function convCount() {
  const t = $('convOut').value;
  $('convOutCount').textContent = t.trim() ? `${lines(t).filter((l) => l.trim()).length}行` : '';
}
function convAutoPreview() { $('convOut').value = $('convIn').value; convCount(); }
function convClearIn() { $('convIn').value = ''; $('convOut').value = ''; convCount(); }

function convDo(type) {
  const src = $('convIn').value;
  if (!src.trim()) { toast('入力テキストが空です'); return; }
  let out;
  if (type === 'removeWord') {
    const w = $('convRemoveWord').value;
    if (!w) { toast('削除する文字を入力してください'); return; }
    out = src.split(w).join('');
  } else if (type === 'replace') {
    const from = $('convFrom').value;
    if (!from) { toast('検索する文字を入力してください'); return; }
    out = src.split(from).join($('convTo').value);
  } else {
    out = CONV[type](src);
  }
  $('convOut').value = out;
  convCount();
  if (type === 'qaFormat') {
    const r = parseAll(out);
    toast(`${r.qs.length}問に変換しました` + (r.errs.length ? `（${r.errs.length}行は要確認）` : ''));
  }
}

function convOutDo(type) {
  const t = $('convOut').value;
  if (!t.trim()) { toast('出力テキストが空です'); return; }
  $('convOut').value = CONV[type](t);
  convCount();
}

function convTx(type) {
  const target = $('convOut').value.trim() ? $('convOut') : $('convIn');
  let t = target.value;
  if (!t.trim()) { toast('テキストが空です'); return; }
  switch (type) {
    case 'hiragana':  t = t.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)); break;
    case 'katakana':  t = t.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); break;
    case 'upper':     t = t.toUpperCase(); break;
    case 'lower':     t = t.toLowerCase(); break;
    case 'fullwidth': t = t.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/ /g, '　'); break;
    case 'halfwidth': t = t.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' '); break;
  }
  $('convOut').value = t;
  convCount();
}

function convSwap() {
  const a = $('convIn').value;
  $('convIn').value = $('convOut').value;
  $('convOut').value = a;
  convCount();
}

function convCopy() {
  const t = $('convOut').value;
  if (!t) { toast('コピーする内容がありません'); return; }
  const fallback = () => {
    const el = $('convOut'); el.focus(); el.select();
    try { document.execCommand('copy'); toast('コピーしました'); } catch (e) { toast('コピーできませんでした'); }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(() => toast('コピーしました'), fallback);
  } else fallback();
}

function convSendToQuiz() {
  const t = $('convOut').value.trim();
  if (!t) { toast('出力テキストが空です'); return; }
  const n = countQ(t);
  applyText(t, `${n}問を入力欄に送りました`);
}

/* ---------- 11. 音声読み上げ ---------- */
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('このブラウザは音声読み上げに対応していません'); return; }
  if (!text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = settings.ttsLang;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-') === u.lang);
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
function ttsQ() {
  if (!quiz) return;
  const q = cur();
  const blank = settings.ttsLang.startsWith('ja') ? '、くうらん、' : ' blank ';
  let t = plain(q.q, blank);
  if (q.type === 'mc') t += '。' + q.opts.map((o, i) => `${i + 1}、${o}`).join('。');
  speak(t);
}
function ttsA() {
  if (!quiz) return;
  const q = cur();
  speak(q.type === 'mc' ? q.opts[q.ans] : q.alts[0]);
}

/* ---------- 12. モーダル・トースト・紙吹雪 ---------- */
function openModal(title, bodyHTML, actions) {
  $('mTit').textContent = title;
  $('mBody').innerHTML = bodyHTML;
  const box = $('mActs');
  box.innerHTML = '';
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + (a.cls || 'btn-out');
    b.textContent = a.label;
    b.onclick = () => { if (a.fn) a.fn(); closeModal(); };
    box.appendChild(b);
  });
  $('modal').classList.add('show');
  const last = box.lastElementChild;
  if (last && !bodyHTML.includes('<input')) last.focus();
}
function closeModal() { $('modal').classList.remove('show'); }
function closeModalOut(e) { if (e.target === $('modal')) closeModal(); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function confetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = $('cfLayer');
  const colors = ['#D12F43', '#F5B800', '#2D6CDF', '#1F8A5B', '#EE5A24', '#1C2B4A'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('span');
    p.className = 'cf';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
    p.style.animationDelay = (Math.random() * 0.5) + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(p);
  }
  setTimeout(() => { layer.innerHTML = ''; }, 4200);
}

/* ---------- 13. 初期化 ---------- */
function init() {
  $('inputArea').value = db.get(KEYS.text, '');
  applySettingsUI();
  ['ignoreSpaces', 'ignoreBrackets', 'ttsAuto'].forEach((id) => {
    $(id).addEventListener('change', (e) => { settings[id] = e.target.checked; saveSettings(); });
  });
  $('ttsLang').addEventListener('change', (e) => { settings.ttsLang = e.target.value; saveSettings(); });
  document.addEventListener('keydown', onKey);
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  refresh();
  convCount();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
