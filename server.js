const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.urlencoded({ extended: true }));

const KEYS = (process.env.GEMINI_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.6-flash';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts';
const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const TOKEN = process.env.YEMOT_TOKEN || (process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD);
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 40000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();

const SYS = 'אתה עוזר קולי בטלפון. ענה בעברית במשפט או שניים קצרים וברורים, בלי רשימות ובלי סימנים מיוחדים.';
const GREET = sp('שלום אני זיגי שאל אותי כל דבר ובסיום הקש סולמית');
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const EXTP = '/' + EXT;
const yp = name => 'ivr2:' + EXTP + '/' + name + '.wav';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => e && /budget/.test(e.message || '');
let k = 0;
const calls = {};

// drop state of calls that never sent hangup
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

// fetch with a timeout that never exceeds the remaining time of the current turn
async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) throw new Error('turn budget exhausted');
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

async function gem(model, body, deadline) {
  if (!KEYS.length) throw new Error('GEMINI_API_KEYS is empty');
  let err = model + ' failed';
  let status = 0;
  for (let i = 0; i < KEYS.length * 2; i++) {
    const key = KEYS[k++ % KEYS.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, 25000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    await sleep(500);
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// fastest thinking level the model accepts; remembered after the first call
const THINK = ['minimal', 'low', null];
let thinkIdx = 0;
async function textGen(body, deadline) {
  for (;;) {
    const lvl = THINK[thinkIdx];
    const gc = { maxOutputTokens: 1024 };
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
    try {
      return await gem(TEXT_MODEL, { ...body, generationConfig: gc }, deadline);
    } catch (e) {
      if (e.status === 400 && /think/i.test(e.message) && thinkIdx < THINK.length - 1) { thinkIdx++; continue; }
      throw e;
    }
  }
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const NEW_TTS = /^gemini-(3\.[8-9]|[4-9])/.test(TTS_MODEL);
const VOICES = NEW_TTS
  ? [{ voice: VOICE }, { prebuiltVoiceConfig: { voiceName: VOICE } }]
  : [{ prebuiltVoiceConfig: { voiceName: VOICE } }, { voice: VOICE }];
let vIdx = 0;

async function tts(text, deadline) {
  let last = new Error('no audio from tts');
  for (let i = 0; i < 3; i++) {
    try {
      const t = await gem(TTS_MODEL, {
        contents: [{ role: 'user', parts: [{ text: text.slice(0, 800) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: VOICES[vIdx] } }
      }, deadline);
      const parts = (((t.candidates || [])[0] || {}).content || {}).parts || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (part) {
        let pcm = Buffer.from(part.inlineData.data, 'base64');
        if (pcm.subarray(0, 4).toString() !== 'RIFF') {
          const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
          pcm = wav(pcm, m ? Number(m[1]) : 24000);
        }
        return pcm;
      }
      last = new Error('no audio from tts');
    } catch (e) {
      last = e;
      if (isBudget(e)) throw e;
      if (e.status === 400 && /voice|speech/i.test(e.message) && vIdx < VOICES.length - 1) vIdx++;
    }
  }
  throw last;
}

async function download(name, deadline) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await http(YM + 'DownloadFile?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(yp(name)), {}, 8000, deadline);
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && b.length > 100 && b.subarray(0, 4).toString() === 'RIFF') return b;
      last = r.status + ' ' + b.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ');
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error('download failed ' + last);
}

async function upload(name, buf, deadline) {
  const path = yp(name);
  // documented form first (token and path in the URL, file in the body), then the all-in-body form
  const attempts = [
    { q: true, field: 'file' }, { q: true, field: 'upload' },
    { q: false, field: 'upload' }, { q: false, field: 'file' }
  ];
  let last = '';
  for (const a of attempts) {
    try {
      const f = new FormData();
      let url = YM + 'UploadFile';
      if (a.q) {
        url += '?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent(path) + '&convertAudio=1';
      } else {
        f.append('token', TOKEN); f.append('path', path); f.append('convertAudio', '1');
      }
      f.append(a.field, new Blob([buf], { type: 'audio/wav' }), name + '.wav');
      const r = await http(url, { method: 'POST', body: f }, 15000, deadline);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.responseStatus === 'OK') return;
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) {
      if (isBudget(e)) throw e;
      last = e.message;
    }
  }
  throw new Error('upload failed ' + last);
}

// cleanup is best effort and never blocks or fails a call
function del(name) {
  fetch(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp(name)), { signal: AbortSignal.timeout(8000) }).catch(() => {});
}

app.get('/', (q, r) => { r.set('Access-Control-Allow-Origin', '*'); r.send('ok'); });

app.all('/yemot', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const id = String(q.ApiCallId || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'x';
  res.type('text/plain');
  const T0 = Date.now();
  try {
    if (q.hangup === 'yes') {
      const old = calls[id];
      if (old && old.r) del(old.r);
      delete calls[id];
      return res.send('noop=bye');
    }

    const s = calls[id] || (calls[id] = { n: 0, h: [], p: '', name: '', r: '', t: 0, e: crypto.randomBytes(3).toString('hex') });
    s.t = Date.now();

    // every turn uses a new parameter and file name, because Yemot accumulates parameters across requests
    // (s.e keeps the names unique even if this server restarted in the middle of a call)
    const ask = pre => {
      s.n++;
      s.p = 'Q' + s.e + s.n;
      s.name = 'q' + s.e + 'n' + s.n;
      return 'read=' + pre + '=' + s.p + ',no,record,' + EXTP + ',' + s.name + ',no,,,1,' + REC_MAX;
    };

    if (!s.name) return res.send(ask('t-' + GREET));
    if (!q[s.p]) return res.send(ask('t-' + AGAIN));

    const deadline = T0 + BUDGET;
    const qn = s.name;
    let out;
    try {
      const audio = await download(qn, deadline);
      del(qn);
      if (s.r) { del(s.r); s.r = ''; }
      const t1 = Date.now();

      const a = await textGen({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [...s.h.slice(-8), { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }] }]
      }, deadline);
      const parts = (((a.candidates || [])[0] || {}).content || {}).parts || [];
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('empty answer ' + JSON.stringify((a.promptFeedback || {})).slice(0, 100));
      const t2 = Date.now();

      const pcm = await tts(text, deadline);
      const t3 = Date.now();

      const rn = 'r' + s.e + 'n' + s.n;
      await upload(rn, pcm, deadline);
      s.r = rn;
      s.h.push({ role: 'user', parts: [{ text: '[שאלה קולית]' }] }, { role: 'model', parts: [{ text }] });
      if (s.h.length > 12) s.h = s.h.slice(-12);

      console.log(id, 'turn', s.n, 'ok', 'gemini', t2 - t1, 'ms tts', t3 - t2, 'ms total', Date.now() - T0, 'ms');
      out = ask('f-' + EXTP + '/' + rn);
    } catch (e) {
      console.error(id, 'turn', s.n, 'failed after', Date.now() - T0, 'ms:', e.message);
      del(qn);
      out = ask('t-' + ERR);
    }
    return res.send(out);
  } catch (e) {
    // last resort: always answer Yemot with plain text, never HTML or an empty reply
    console.error(id, 'fatal', e.message);
    if (!res.headersSent) res.send('id_list_message=t-' + ERR);
  }
});

// quick end to end check of the whole chain, without a phone call
let lastTest = 0;
app.get('/selftest', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').type('text/plain; charset=utf-8');
  if (Date.now() - lastTest < 20000) return res.send('ERR נבדק הרגע, חכו 20 שניות ונסו שוב');
  lastTest = Date.now();
  const out = [];
  const deadline = Date.now() + 90000;
  const step = async (name, fn) => {
    try { out.push('OK  ' + name + (await fn() || '')); }
    catch (e) { out.push('ERR ' + name + ': ' + String(e.message).slice(0, 220)); }
  };
  const silent = wav(Buffer.alloc(3200), 8000);

  await step('מפתחות ג׳מיני', async () => { if (!KEYS.length) throw new Error('GEMINI_API_KEYS ריק'); return ' (' + KEYS.length + ')'; });
  await step('טוקן ימות', async () => { if (!TOKEN || /undefined/.test(TOKEN)) throw new Error('YEMOT_TOKEN ריק'); });
  await step('ימות: קריאת השלוחה ' + EXT, async () => {
    const r = await http(YM + 'GetIVR2Dir?token=' + encodeURIComponent(TOKEN) + '&path=' + encodeURIComponent('ivr2:' + EXTP), {}, 10000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error(JSON.stringify(j).slice(0, 180));
  });
  await step('ימות: העלאה ומחיקה של קובץ', async () => {
    await upload('selftest', silent, deadline);
    const r = await http(YM + 'FileAction?token=' + encodeURIComponent(TOKEN) + '&action=delete&what=' + encodeURIComponent(yp('selftest')), {}, 8000, deadline);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus !== 'OK') throw new Error('מחיקה: ' + JSON.stringify(j).slice(0, 150));
  });
  await step('ג׳מיני ' + TEXT_MODEL + ' (קלט אודיו)', async () => {
    const a = await textGen({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: silent.toString('base64') } }, { text: 'ענה במילה אחת' }] }] }, deadline);
    if (!(((a.candidates || [])[0] || {}).content)) throw new Error('תשובה ריקה');
    return ' (thinking: ' + (THINK[thinkIdx] || 'ברירת מחדל') + ')';
  });
  await step('ג׳מיני ' + TTS_MODEL + ' (קול)', async () => {
    const p = await tts('בדיקה', deadline);
    return ' (' + Math.round(p.length / 1024) + 'KB)';
  });
  res.send(out.join('\n'));
});

app.use((err, req, res, next) => {
  console.error('express', err && err.message);
  if (!res.headersSent) res.type('text/plain').send('id_list_message=t-' + ERR);
});
process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));

app.listen(process.env.PORT || 3000, () => console.log('zygy up'));
