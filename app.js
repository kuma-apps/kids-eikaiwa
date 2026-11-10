// ===== くまちゃん英会話 (Gemini Live API) =====
"use strict";

const $ = (id) => document.getElementById(id);
const bear = $("bear"), statusEl = $("status"), starsEl = $("stars");
const btn = $("main-btn"), btnLabel = $("btn-label"), meterBar = $("meter").firstElementChild;

let ws = null, micCtx = null, micStream = null, workletNode = null;
let playCtx = null, playTime = 0, playingSources = [];
let running = false, starCount = 0;

// ---------- APIキー管理 ----------
function getApiKey() { return localStorage.getItem("gemini_api_key") || ""; }
$("key-save").onclick = () => {
  const v = $("key-input").value.trim();
  if (!v.startsWith("AIza")) { alert("キーの形式が正しくないようです"); return; }
  localStorage.setItem("gemini_api_key", v);
  $("key-modal").classList.add("hidden");
  startSession();
};

// ---------- 状態表示 ----------
function setStatus(text, mode) {
  statusEl.textContent = text;
  bear.className = mode || "";
}
function addStar() {
  starCount++;
  starsEl.textContent = "⭐".repeat(Math.min(starCount, 20));
}

// ---------- ドレスの色（お姫様をタップで着せかえ・iPadに記憶） ----------
const DRESSES = [
  { a: "#d6ecff", b: "#8fc7f5", ac: "#b5dcf9", shoe: "#7fb8e8" }, // こおり
  { a: "#ffd9ec", b: "#ff9ec9", ac: "#ffc2dd", shoe: "#f58fbc" }, // ピンク
  { a: "#e6dbff", b: "#b79bf0", ac: "#d4c4f7", shoe: "#a98ae0" }, // むらさき
  { a: "#dff6d8", b: "#95d98a", ac: "#c4ecbb", shoe: "#7cc470" }  // わかくさ
];
function applyDress(i) {
  const d = DRESSES[((i % DRESSES.length) + DRESSES.length) % DRESSES.length];
  const a = $("dressA"), b = $("dressB");
  if (a) a.setAttribute("stop-color", d.a);
  if (b) b.setAttribute("stop-color", d.b);
  document.querySelectorAll(".dress-accent").forEach(el => el.setAttribute("fill", d.ac));
  document.querySelectorAll(".dress-shoe").forEach(el => el.setAttribute("fill", d.shoe));
}
let dressIdx = 0;
try { dressIdx = parseInt(localStorage.getItem("dress") || "0", 10) || 0; } catch (_) {}
applyDress(dressIdx);
bear.onclick = () => {
  dressIdx = (dressIdx + 1) % DRESSES.length;
  try { localStorage.setItem("dress", String(dressIdx)); } catch (_) {}
  applyDress(dressIdx);
  confetti(4);
};

// ---------- メインボタン ----------
btn.onclick = () => {
  if (running) { stopSession("またあそぼうね！"); return; }
  if (!getApiKey()) { $("key-modal").classList.remove("hidden"); return; }
  startSession();
};

// ---------- セッション開始 ----------
async function startSession() {
  btn.disabled = true;
  setStatus("じゅんびちゅう…");
  try {
    await setupAudio();
    await connectWS();
    running = true;
    speechFrames = 0; silenceFrames = 0; childSpoke = false;
    startIdleWatch();
    btn.textContent = "■"; btn.classList.add("stop"); btnLabel.textContent = "おわる";
  } catch (e) {
    console.error(e);
    stopSession("うまくつながらなかったよ…");
    if (String(e).includes("Permission") || String(e).includes("NotAllowed")) {
      alert("マイクの使用を許可してください");
    }
  } finally {
    btn.disabled = false;
  }
}

function stopSession(msg) {
  running = false;
  game = null;
  cardsEl.classList.add("hidden");
  displayEl.classList.add("hidden");
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  aizuchiBufs = []; // playCtxごと破棄されるため次回セッションで再読込
  try { ws && ws.close(); } catch (_) {}
  ws = null;
  stopPlayback();
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micCtx) { micCtx.close(); micCtx = null; }
  if (playCtx) { playCtx.close(); playCtx = null; }
  btn.textContent = "▶"; btn.classList.remove("stop"); btnLabel.textContent = "スタート";
  meterBar.style.width = "0%";
  setStatus(msg || "ボタンをおしてね！");
}

// ---------- マイク（16kHz PCM で送信） ----------
const WORKLET_CODE = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1024); // 16kHzで64ms分ためて送信
    this.pos = 0;
    this.peak = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.peak = Math.max(this.peak, Math.abs(s));
        this.buf[this.pos++] = s * 0x7fff;
        if (this.pos === this.buf.length) {
          const out = this.buf.slice();
          this.port.postMessage({ pcm: out.buffer, peak: this.peak }, [out.buffer]);
          this.pos = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-processor", MicProcessor);`;

async function setupAudio() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  micCtx = new AudioContext({ sampleRate: 16000 });
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
  await micCtx.audioWorklet.addModule(blobUrl);
  const src = micCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(micCtx, "mic-processor");
  src.connect(workletNode);
  workletNode.port.onmessage = (e) => {
    meterBar.style.width = Math.min(100, e.data.peak * 160) + "%";
    detectSpeech(e.data.peak);
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Safari(iPad)は16kHz指定を無視することがあるため、実際のレートを申告（API側で変換される）
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=" + micCtx.sampleRate, data: b64FromBuffer(e.data.pcm) }
        }
      }));
    }
  };
  playCtx = new AudioContext({ sampleRate: 24000 });
  playTime = 0;
  // iOSはユーザー操作後にresumeが必要
  await micCtx.resume();
  await playCtx.resume();
  loadAizuchi(); // 相槌音声の読み込み（初回のみ・完了を待たない）
}

// ---------- WebSocket（Live API） ----------
// つながったモデルの番号をiPadに記憶し、次回はそこから試す（モデルの提供終了に備えて自動で次へ）
async function connectWS() {
  let start = 0;
  try { start = parseInt(localStorage.getItem("model_idx") || "0", 10) || 0; } catch (_) {}
  if (start >= MODEL_CANDIDATES.length) start = 0;
  let lastErr = null;
  for (let k = 0; k < MODEL_CANDIDATES.length; k++) {
    const idx = (start + k) % MODEL_CANDIDATES.length;
    try {
      await connectWith(MODEL_CANDIDATES[idx]);
      try { localStorage.setItem("model_idx", String(idx)); } catch (_) {}
      console.log("connected:", MODEL_CANDIDATES[idx].model, MODEL_CANDIDATES[idx].api);
      return;
    } catch (e) {
      console.warn("model failed:", MODEL_CANDIDATES[idx].model, MODEL_CANDIDATES[idx].api, e);
      lastErr = e;
    }
  }
  throw lastErr || new Error("no model");
}

function connectWith(cand) {
  return new Promise((resolve, reject) => {
    let ready = false;
    const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
      cand.api + ".GenerativeService.BidiGenerateContent?key=" + encodeURIComponent(getApiKey());
    const sock = new WebSocket(url);
    ws = sock;
    // 8秒たっても準備完了が来なければ、このモデルはあきらめて次へ
    const giveUp = setTimeout(() => {
      if (!ready) { try { sock.close(); } catch (_) {} reject(new Error("setup timeout")); }
    }, 8000);
    sock.onopen = () => {
      const generationConfig = {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } }
      };
      // 旧モデルだけ「考えてから話す」をオフにする（3.8 は送らない）
      if (cand.thinkingOff) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      sock.send(JSON.stringify({
        setup: {
          model: cand.model,
          generationConfig,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          // 話し終わり判定を速める（無音の待ち時間を短縮）
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
              prefixPaddingMs: 100,
              silenceDurationMs: 400
            }
          }
        }
      }));
    };
    sock.onmessage = async (ev) => {
      if (ws !== sock) return;
      const text = ev.data instanceof Blob ? await ev.data.text() : ev.data;
      const msg = JSON.parse(text);
      if (msg.setupComplete) {
        ready = true;
        clearTimeout(giveUp);
        setStatus("きいてるよ！", "listening");
        // くまちゃんから話しかけてもらう（毎回ちがう話題でスタート）
        const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
        sendText("(She just opened the app. Introduce yourself as Princess Yuki, SLOWLY and warmly, " +
          "in a fresh way, then start with ONE very easy question about " + topic + ". " +
          "Remember: very slow, 4 words or less, vary your questions today!)");
        resolve();
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) { stopPlayback(); setStatus("きいてるよ！", "listening"); return; }
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          answerArrived();
          setStatus("おひめさまが おはなししてるよ", "talking");
          queuePcm(p.inlineData.data);
        }
      }
      if (sc.turnComplete) { addStar(); }
    };
    sock.onerror = () => { if (!ready) { clearTimeout(giveUp); reject(new Error("WebSocket error")); } };
    sock.onclose = (ev) => {
      if (!ready) {
        // 準備完了の前に閉じた＝このモデル（またはAPIの版）が使えない → 次の候補へ
        clearTimeout(giveUp);
        reject(new Error("closed before setup: " + ev.code + " " + ev.reason));
        return;
      }
      if (ws !== sock || !running) return;
      console.warn("closed:", ev.code, ev.reason);
      stopSession(ev.code === 1000 ? "またあそぼうね！" : "せつぞくがきれちゃった…もういちどおしてね");
    };
  });
}

// ---------- 相槌と沈黙フォロー ----------
let aizuchiBufs = [], lastAizuchiAt = 0;
let speechFrames = 0, silenceFrames = 0, childSpoke = false;
let lastActivity = 0, idleTimer = null;

async function loadAizuchi() {
  if (aizuchiBufs.length || !playCtx) return;
  for (let i = 1; i <= 5; i++) {
    try {
      const ab = await (await fetch("aizuchi_" + i + ".wav")).arrayBuffer();
      aizuchiBufs.push(await playCtx.decodeAudioData(ab));
    } catch (_) {}
  }
}

// お姫様の声（Leda）で作った相槌をランダム再生
function playAizuchi() {
  if (!playCtx || !aizuchiBufs.length) return;
  const src = playCtx.createBufferSource();
  src.buffer = aizuchiBufs[Math.floor(Math.random() * aizuchiBufs.length)];
  src.connect(playCtx.destination);
  // 相槌のあとに本回答が続くよう、再生の順番に並べる（声が重ならないように）
  const startAt = Math.max(playCtx.currentTime + 0.02, playTime);
  src.start(startAt);
  playTime = startAt + src.buffer.duration;
  playingSources.push(src);
  src.onended = () => {
    playingSources = playingSources.filter(s => s !== src);
    if (playingSources.length === 0 && running) setStatus("きいてるよ！", "listening");
  };
}

// マイク音量から「話しはじめ・話し終わり」をローカル検知する（改良v9）
// ・小さな声でも拾えるよう、部屋の雑音の大きさに合わせて基準を自動で下げる
// ・話しはじめたらすぐ「きいてるよ」、話し終わったらすぐ「きこえたよ！」と画面で返す
//   （返事が来ないと思って大声になるのを防ぐ）
// ・話し終わりをサーバーに即知らせる（audioStreamEnd＝サーバー側の無音待ちを飛ばす）
// ・それでも返事が0.7秒来なければ、相槌でつなぐ
let noiseFloor = 0.01, waitTimer = null, answerSeen = false;
function detectSpeech(peak) {
  // おひめさまが話している間は、スピーカーの音を拾わないよう判定しない
  if (playingSources.length > 0) { speechFrames = 0; silenceFrames = 0; return; }
  if (!childSpoke && peak < 0.06) noiseFloor = noiseFloor * 0.97 + peak * 0.03;
  const th = Math.min(0.05, Math.max(0.02, noiseFloor * 3));
  if (peak > th) {
    speechFrames++; silenceFrames = 0;
    if (speechFrames >= 2 && !childSpoke) {
      childSpoke = true; lastActivity = Date.now();
      setStatus("きいてるよ…", "listening");
    }
  } else {
    silenceFrames++; speechFrames = 0;
    if (childSpoke && silenceFrames >= 7) { // 約450ms無音が続いたら話し終わり
      childSpoke = false;
      lastActivity = Date.now();
      setStatus("きこえたよ！ ✨", "talking");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
      answerSeen = false;
      if (waitTimer) clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (!running || answerSeen || playingSources.length > 0) return;
        if (Date.now() - lastAizuchiAt > 1500) {
          lastAizuchiAt = Date.now();
          playAizuchi();
        }
      }, 700);
    }
  }
}

// 本回答の声が届いたら、相槌の予定を取り消す
function answerArrived() {
  answerSeen = true;
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
}

// 12秒なにも起きなかったら、お姫様からやさしく再アプローチ
function startIdleWatch() {
  lastActivity = Date.now();
  idleTimer = setInterval(() => {
    if (!running || playingSources.length > 0) return;
    if (Date.now() - lastActivity > 12000) {
      lastActivity = Date.now();
      sendText("(She has been quiet for a while. Gently re-engage her: " +
        "repeat your question much slower with a short Japanese hint, " +
        "or offer two easy choices like 'Cats or dogs?')");
    }
  }, 3000);
}

// ---------- 再生（24kHz PCM キュー） ----------
function queuePcm(b64) {
  if (!playCtx) return;
  lastActivity = Date.now();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const buf = playCtx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const startAt = Math.max(playCtx.currentTime + 0.05, playTime);
  src.start(startAt);
  playTime = startAt + buf.duration;
  playingSources.push(src);
  src.onended = () => {
    playingSources = playingSources.filter(s => s !== src);
    if (playingSources.length === 0 && running) setStatus("きいてるよ！", "listening");
  };
}
function stopPlayback() {
  playingSources.forEach(s => { try { s.stop(); } catch (_) {} });
  playingSources = [];
  playTime = 0;
}

// ---------- テキスト指示の送信（画面ボタン用） ----------
function sendText(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true
    }
  }));
}

// 🐢ゆっくりボタン：同じことをもっとゆっくり言い直してもらう
$("slow-btn").onclick = () => {
  if (!running) return;
  stopPlayback();
  sendText("(She couldn't catch that. Say the SAME thing again MUCH slower, " +
    "word ... by ... word, in an even simpler way, and add one short Japanese hint.)");
  setStatus("もういちど いうね！", "talking");
};

// 話題えらびボタン：娘が自分で話題を切り替えられる
document.querySelectorAll(".topic").forEach(b => {
  b.onclick = () => {
    if (!running) return;
    stopPlayback();
    sendText("(She tapped a picture button! She wants to talk about " + b.dataset.topic +
      " now. Switch cheerfully and ask ONE very easy question about it. Very slowly!)");
    setStatus("おはなし かえるね！", "talking");
  };
});

// ---------- どっちかな？カードゲーム ----------
const GAME_ROUNDS = 10; // 1ゲームの問題数
const CARD_SETS = [
  [{ e: "🐶", w: "dog" }, { e: "🐱", w: "cat" }],
  [{ e: "🍎", w: "apple" }, { e: "🍌", w: "banana" }],
  [{ e: "🐘", w: "elephant" }, { e: "🐰", w: "rabbit" }],
  [{ e: "🚗", w: "car" }, { e: "⭐", w: "star" }],
  [{ e: "🐟", w: "fish" }, { e: "🐦", w: "bird" }],
  [{ e: "🍓", w: "strawberry" }, { e: "🍇", w: "grapes" }],
  [{ e: "👑", w: "crown" }, { e: "🎀", w: "ribbon" }],
  [{ e: "❄️", w: "snow" }, { e: "🌸", w: "flower" }],
  [{ e: "🦁", w: "lion" }, { e: "🐵", w: "monkey" }],
  [{ e: "🐻", w: "bear" }, { e: "🐼", w: "panda" }],
  [{ e: "🍦", w: "ice cream" }, { e: "🍰", w: "cake" }],
  [{ e: "🥛", w: "milk" }, { e: "🧃", w: "juice" }],
  [{ e: "☀️", w: "sun" }, { e: "🌙", w: "moon" }],
  [{ e: "☂️", w: "umbrella" }, { e: "🌈", w: "rainbow" }],
  [{ e: "👟", w: "shoes" }, { e: "👒", w: "hat" }],
  [{ e: "🎒", w: "bag" }, { e: "📖", w: "book" }],
  [{ e: "🚃", w: "train" }, { e: "✈️", w: "airplane" }],
  [{ e: "🥚", w: "egg" }, { e: "🍞", w: "bread" }],
  [{ e: "🍅", w: "tomato" }, { e: "🌽", w: "corn" }],
  [{ e: "🦋", w: "butterfly" }, { e: "🐝", w: "bee" }]
];

// どっちかな？用のフラットな絵札プール
const CARD_ITEMS = CARD_SETS.flat();

// なぞなぞゲーム用（hints=やさしい英語ヒント3つ）
const RIDDLE_ITEMS = [
  { e: "🍌", w: "banana", hints: ["It's yellow.", "It's long.", "Monkeys love it!"] },
  { e: "🍎", w: "apple", hints: ["It's red.", "It's round.", "It's a fruit."] },
  { e: "🐱", w: "cat", hints: ["It says meow.", "It's soft.", "It likes fish!"] },
  { e: "🐶", w: "dog", hints: ["It says woof.", "It loves to play.", "It's your friend!"] },
  { e: "☀️", w: "sun", hints: ["It's in the sky.", "It's hot.", "It's bright!"] },
  { e: "❄️", w: "snow", hints: ["It's white.", "It's cold.", "It falls in winter!"] },
  { e: "🚗", w: "car", hints: ["It goes vroom.", "It has wheels.", "It goes fast!"] },
  { e: "🐟", w: "fish", hints: ["It swims.", "It's in the water.", "It has no legs!"] },
  { e: "🍦", w: "ice cream", hints: ["It's cold.", "It's sweet.", "Yummy dessert!"] },
  { e: "🐘", w: "elephant", hints: ["It's big.", "It's gray.", "It has a long nose!"] },
  { e: "🌈", w: "rainbow", hints: ["It's in the sky.", "It has many colors.", "It comes after rain!"] },
  { e: "🍓", w: "strawberry", hints: ["It's red.", "It's small.", "It's sweet!"] }
];

// なきごえクイズ用の動物（e=絵、w=名前、s=鳴きまね）
const SOUND_ANIMALS = [
  { e: "🐶", w: "dog", s: "Woof woof!" },
  { e: "🐱", w: "cat", s: "Meow meow!" },
  { e: "🐮", w: "cow", s: "Moo moo!" },
  { e: "🦆", w: "duck", s: "Quack quack!" },
  { e: "🐷", w: "pig", s: "Oink oink!" },
  { e: "🦁", w: "lion", s: "Roar!" },
  { e: "🐑", w: "sheep", s: "Baa baa!" },
  { e: "🐸", w: "frog", s: "Ribbit ribbit!" },
  { e: "🐴", w: "horse", s: "Neigh neigh!" },
  { e: "🐔", w: "chicken", s: "Cluck cluck!" }
];

// かずあてゲーム用のアイテム
const COUNT_ITEMS = [
  { e: "🍎", w: "apples" }, { e: "🍓", w: "strawberries" }, { e: "⭐", w: "stars" },
  { e: "🌸", w: "flowers" }, { e: "🐟", w: "fish" }, { e: "🧁", w: "cupcakes" }
];

const cardsEl = $("cards");
const cardBtns = [$("card0"), $("card1"), $("card2")];
let game = null; // { type, current, round, targetIndex, words }

const displayEl = $("quiz-display");

$("game-btn").onclick = () => startGame("cards");
$("sound-btn").onclick = () => startGame("sound");
$("count-btn").onclick = () => startGame("count");
$("riddle-btn").onclick = () => startGame("riddle");
$("mix-btn").onclick = () => startGame("mix");
$("teach-btn").onclick = () => startGame("teach");
$("shop-btn").onclick = () => startGame("shop");
$("math-btn").onclick = () => startGame("math");

// さんすうゲーム用の絵
const MATH_ITEMS = [
  { e: "🍎", w: "apples" }, { e: "🍓", w: "strawberries" }, { e: "⭐", w: "stars" },
  { e: "🐟", w: "fish" }, { e: "🧁", w: "cupcakes" }, { e: "❄️", w: "snowflakes" },
  { e: "🌸", w: "flowers" }, { e: "🍬", w: "candies" }
];
const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// 正解の数と、となりの数で選択肢を作る（1〜10の範囲・重ならない）
function numberChoices(ans, opts) {
  const pool = [ans];
  for (const d of [1, -1, 2, -2]) {
    const v = ans + d;
    if (pool.length < opts && v >= 1 && v <= 10 && !pool.includes(v)) pool.push(v);
  }
  return pickN(pool, pool.length);
}

// さんすうの1問を作る（easy=2択でやさしく／そうでなければ3択で少し大きい数）
function makeMath(opts) {
  const easy = opts === 2;
  const kind = ["add", "next", "more"][Math.floor(Math.random() * 3)];
  const it = MATH_ITEMS[Math.floor(Math.random() * MATH_ITEMS.length)];
  if (kind === "add") {
    // たしざん（絵で数えられる）：やさしい＝答え5まで／ふつう＝答え10まで
    const a = easy ? rnd(1, 3) : rnd(2, 6);
    const b = easy ? rnd(1, Math.min(2, 5 - a)) : rnd(1, Math.min(4, 10 - a));
    const ans = a + b;
    const nums = numberChoices(ans, opts);
    return {
      faces: nums.map(String), group: false, words: nums.map(String),
      target: nums.indexOf(ans),
      display: Array(a).fill(it.e).join("") + " ＋ " + Array(b).fill(it.e).join("") + " ＝ ？",
      ask: "Adding game with pictures. The screen shows " + a + " " + it.w + " plus " + b + " " + it.w +
        ". Ask slowly: '" + NUM_WORDS[a] + " ... plus " + NUM_WORDS[b] + " ... is?' " +
        "Invite her to count the pictures with you. The answer is " + NUM_WORDS[ans] +
        ". Do NOT say the answer before she taps.)",
      say: NUM_WORDS[a] + " plus " + NUM_WORDS[b] + " is " + NUM_WORDS[ans]
    };
  }
  if (kind === "next") {
    // つぎのかず：やさしい＝5まで／ふつう＝10まで
    const last = easy ? rnd(2, 4) : rnd(4, 9);
    const seq = [];
    for (let v = Math.max(1, last - 2); v <= last; v++) seq.push(v);
    const ans = last + 1;
    const nums = numberChoices(ans, opts);
    return {
      faces: nums.map(String), group: false, words: nums.map(String),
      target: nums.indexOf(ans),
      display: seq.join("  ") + "  ？",
      ask: "What-comes-next game. The screen shows " + seq.join(", ") + ", then a question mark. " +
        "Count slowly with a rhythm: '" + seq.map(v => NUM_WORDS[v]).join(" ... ") + " ... what's next?' " +
        "The answer is " + NUM_WORDS[ans] + ". Do NOT say it before she taps.)",
      say: seq.map(v => NUM_WORDS[v]).join(", ") + ", " + NUM_WORDS[ans]
    };
  }
  // どっちがおおい？（いつも2択）：やさしい＝差2以上／ふつう＝差1もある
  const lo = easy ? rnd(1, 2) : rnd(2, 5);
  const hi = lo + (easy ? rnd(2, 3) : rnd(1, 2));
  const sides = pickN([lo, hi], 2);
  return {
    faces: sides.map(n => Array(n).fill(it.e).join(" ")), group: true, // 空白を入れて2行に折り返す
    words: sides.map(n => n + " " + it.w),
    target: sides.indexOf(hi),
    display: "",
    ask: "Which-has-more game. Two cards show " + sides[0] + " " + it.w + " and " + sides[1] + " " + it.w +
      ". Ask slowly: 'Which has more " + it.w + "? ... More!' Do NOT say which one before she taps.)",
    say: NUM_WORDS[hi] + " is more than " + NUM_WORDS[lo]
  };
}

// 遊びの途中でも別の遊びに切り替えられる（詰まったら移れるように）
function startGame(type) {
  if (!running) return;
  const free = (type === "teach" || type === "shop");
  game = { type, free, round: 0, streak: 0, misses: 0, targetIndex: 0, words: [] };
  if (free) nextFree(true, null); else nextRound(null);
}

// 配列から重複しないn個を選ぶ（シャッフルして先頭n個）
function pickN(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// カードの表示枚数を切り替え（1枚のときは大きく／ヒントの光は毎回消す）
function setCards(faces, group) {
  cardBtns.forEach((b, i) => {
    b.classList.remove("card--hint");
    b.classList.toggle("card--big", faces.length === 1);
    b.classList.toggle("card--group", !!group);
    if (i < faces.length) { b.textContent = faces[i]; b.classList.remove("hidden"); }
    else { b.classList.add("hidden"); }
  });
}

// 新しいラウンド開始（prevWord: 直前の正解。褒め＋次の出題を1メッセージで送り割り込みを防ぐ）
function nextRound(prevWord) {
  game.round++;
  game.misses = 0;
  // 適応式：3問つづけて正解できたときだけ3択に上げ、まちがえたら2択に戻す
  const opts = game.streak >= 3 ? 3 : 2;
  // ミックスはやさしい3種から（なぞなぞは 💡ボタンを押したときだけ）
  game.current = game.type === "mix"
    ? ["cards", "sound", "count", "math"][Math.floor(Math.random() * 4)]
    : game.type;
  // さんすうで正解したら、式をまるごと英語で1回言ってもらう（"Two plus one is three!"）
  const sayIt = game.lastSay ? " Say the whole thing once, happily: '" + game.lastSay + "!'" : "";
  game.lastSay = "";
  const intro = prevWord
    ? "(She tapped " + prevWord + " — correct! Praise her briefly like 'Yay! Great!'." + sayIt + " Then next question. "
    : "(Game starts! Say 'Let's play a game!'. ";
  let ask = "";
  displayEl.classList.add("hidden");

  if (game.current === "math") {
    // さんすう（たしざん／つぎのかず／どっちがおおい）
    const m = makeMath(opts);
    game.targetIndex = m.target;
    game.words = m.words;
    game.mathSay = m.say;
    setCards(m.faces, m.group);
    if (m.display) { displayEl.textContent = m.display; displayEl.classList.remove("hidden"); }
    ask = m.ask;
  } else if (game.current === "cards") {
    // どっちかな？
    const items = pickN(CARD_ITEMS, opts);
    game.targetIndex = Math.floor(Math.random() * opts);
    game.words = items.map(x => x.w);
    setCards(items.map(x => x.e));
    ask = "The screen shows " + game.words.join(", ") +
      ". Ask her slowly: 'Where is the " + game.words[game.targetIndex] + "?' Keep it short.)";
  } else if (game.current === "sound") {
    // なきごえクイズ
    const items = pickN(SOUND_ANIMALS, opts);
    game.targetIndex = Math.floor(Math.random() * opts);
    const t = items[game.targetIndex];
    game.words = items.map(x => x.w);
    setCards(items.map(x => x.e));
    ask = "Animal sound quiz. The cards show " + game.words.join(", ") +
      ". Make the " + t.w + "'s sound in a fun, exaggerated way, like '" + t.s + " " + t.s +
      "', WITHOUT saying the animal's name. Then ask: 'What animal? Touch it!')";
  } else if (game.current === "count") {
    // かずあてゲーム（前半2〜5個、後半3〜8個）
    const item = COUNT_ITEMS[Math.floor(Math.random() * COUNT_ITEMS.length)];
    const n = opts === 2 ? 2 + Math.floor(Math.random() * 4) : 3 + Math.floor(Math.random() * 6);
    const numbers = opts === 2
      ? pickN([n, Math.random() < 0.5 && n > 2 ? n - 1 : n + 1], 2)
      : pickN([n, n - 1, n + 1], 3);
    game.targetIndex = numbers.indexOf(n);
    game.words = numbers.map(String);
    setCards(game.words);
    displayEl.textContent = Array(n).fill(item.e).join(" ");
    displayEl.classList.remove("hidden");
    ask = "Counting game. The screen shows " + n + " " + item.w + " and number cards. " +
      "Ask her slowly: 'How many " + item.w + "?' If she is stuck, count together slowly. " +
      "The correct answer is " + n + ".)";
  } else {
    // なぞなぞゲーム（文の聞き取り練習）
    const items = pickN(RIDDLE_ITEMS, opts);
    game.targetIndex = Math.floor(Math.random() * opts);
    const t = items[game.targetIndex];
    game.words = items.map(x => x.w);
    setCards(items.map(x => x.e));
    ask = "Riddle game. The cards show " + game.words.join(", ") + ". The answer is " + t.w +
      ". Give these hints SLOWLY, one by one, with a pause after each: " +
      t.hints.map(h => "'" + h + "'").join(" ... ") +
      " Then ask: 'What is it? Touch it!' NEVER say the answer word.)";
  }
  cardsEl.classList.remove("hidden");
  stopPlayback();
  sendText(intro + ask);
  setStatus("どっちかな？", "talking");
}

// ---------- 正解・不正解のない遊び（おしえて／おみせやさん） ----------
function nextFree(first, prev) {
  displayEl.classList.add("hidden");
  if (game.type === "teach") {
    // 役割逆転：お姫様がわざと間違えて、娘に直してもらう
    const it = CARD_ITEMS[Math.floor(Math.random() * CARD_ITEMS.length)];
    game.words = [it.w];
    setCards([it.e]);
    sendText((first ? "(Teaching game! Tell her: 'Teach me! I am learning!' "
                    : "(Wonderful! Next picture. ") +
      "The screen shows a " + it.w + ". FIRST guess it WRONG on purpose, playfully, " +
      "like 'Is this a ... banana?', so she can correct you. When she reacts at all, be delighted: " +
      "'Ohh! A " + it.w + "! Thank you, teacher!' Then invite her: 'Say it with me ... " + it.w + "!' " +
      "Praise her a lot. There are NO wrong answers here — never correct her.)");
    setStatus("おひめさまに おしえてね！", "talking");
  } else {
    // おみせやさんごっこ：どれを選んでも正解
    const items = pickN(CARD_ITEMS, 3);
    game.words = items.map(x => x.w);
    setCards(items.map(x => x.e));
    sendText((first ? "(Shop game! You are the shopkeeper. Say 'Welcome to my shop!' "
                    : "(She chose the " + prev + "! Say happily: 'One " + prev + "! Here you are!' Then, ") +
      "the shop now has " + game.words.join(", ") +
      ". Ask her warmly: 'What would you like?' Every line 4 words or less.)");
    setStatus("なにを かおうかな？", "talking");
  }
  cardsEl.classList.remove("hidden");
  stopPlayback();
}

cardBtns.forEach((btn, i) => {
  btn.onclick = () => {
    if (!game) return;
    const tappedWord = game.words[i];
    // 遊びモードは どれを押しても正解
    if (game.free) {
      chime(true);
      addStar();
      confetti(6);
      nextFree(false, tappedWord || game.words[0]);
      return;
    }
    if (i === game.targetIndex) {
      chime(true);
      addStar();
      game.streak++;
      game.lastSay = game.current === "math" ? game.mathSay : "";
      if (game.round >= GAME_ROUNDS) {
        // 全問正解でゲームクリア
        const lastSay = game.lastSay;
        game = null;
        cardsEl.classList.add("hidden");
        displayEl.classList.add("hidden");
        confetti(30);
        stopPlayback();
        sendText("(She tapped " + tappedWord + " — correct!" +
          (lastSay ? " First say happily: '" + lastSay + "!'" : "") + " GAME CLEAR, all " + GAME_ROUNDS +
          " questions! Celebrate her joyfully like a big fanfare: 'Yay! You did it! Amazing!' " +
          "Then go back to easy chatting.)");
        setStatus("ゲームクリア！すごい！", "talking");
      } else {
        confetti(8);
        nextRound(tappedWord);
      }
    } else {
      chime(false);
      game.streak = 0;
      game.misses++;
      // 2回まちがえたら正解のカードを光らせる（行き止まりにしない）
      if (game.misses >= 2) cardBtns[game.targetIndex].classList.add("card--hint");
      stopPlayback();
      const hint = game.current === "sound" ? "Make the sound one more time and let her try again."
        : game.current === "count" ? "Count together with her slowly, then ask again."
        : game.current === "math" ? "Count the pictures together slowly on your fingers, one by one, then ask again. Do not say the answer."
        : game.current === "riddle" ? "Give one more easy hint and let her try again."
        : "Ask the same question again, slower.";
      sendText("(She tapped " + tappedWord + " — not quite, but NEVER say she is wrong. " +
        "Stay bright and encouraging: 'Ooh! Nearly!' " + hint +
        (game.misses >= 2 ? " The correct card is now glowing on screen — tell her warmly to touch the shiny one." : "") + ")");
    }
  };
});

// ピンポン音／ブブー音（WebAudioで生成、音声ファイル不要）
function chime(good) {
  if (!playCtx) return;
  const t = playCtx.currentTime;
  // まちがいの音は「ブブー」をやめ、やさしい下降音を小さめに鳴らす
  const notes = good ? [880, 1320] : [520, 440];
  const vol = good ? 0.22 : 0.09;
  notes.forEach((f, i) => {
    const o = playCtx.createOscillator(), g = playCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(vol, t + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.28);
    o.connect(g); g.connect(playCtx.destination);
    o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.3);
  });
}

// 紙吹雪
function confetti(n) {
  for (let i = 0; i < n; i++) {
    const sp = document.createElement("span");
    sp.className = "confetti";
    sp.textContent = ["🎊", "✨", "⭐", "❄️"][i % 4];
    sp.style.left = Math.random() * 100 + "vw";
    sp.style.animationDelay = (Math.random() * 0.6) + "s";
    document.body.appendChild(sp);
    setTimeout(() => sp.remove(), 3200);
  }
}

// ---------- util ----------
function b64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
