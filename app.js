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
function connectWS() {
  return new Promise((resolve, reject) => {
    const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage." +
      "v1beta.GenerativeService.BidiGenerateContent?key=" + encodeURIComponent(getApiKey());
    ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
            // 「考えてから話す」をオフにして即答させる（高音質モデルの遅延対策）
            thinkingConfig: { thinkingBudget: 0 }
          },
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
    ws.onmessage = async (ev) => {
      const text = ev.data instanceof Blob ? await ev.data.text() : ev.data;
      const msg = JSON.parse(text);
      if (msg.setupComplete) {
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
          setStatus("おひめさまが おはなししてるよ", "talking");
          queuePcm(p.inlineData.data);
        }
      }
      if (sc.turnComplete) { addStar(); }
    };
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onclose = (ev) => {
      if (!running) return;
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
  src.start();
}

// マイク音量から「話し終わり」をローカル検知 → 本回答が届くまでの間を相槌でつなぐ
function detectSpeech(peak) {
  if (peak > 0.05) {
    speechFrames++; silenceFrames = 0;
    if (speechFrames >= 3 && !childSpoke) { childSpoke = true; lastActivity = Date.now(); }
  } else {
    silenceFrames++; speechFrames = 0;
    if (childSpoke && silenceFrames >= 7) { // 約450ms無音が続いたら話し終わり
      childSpoke = false;
      if (playingSources.length === 0 && Date.now() - lastAizuchiAt > 4000) {
        lastAizuchiAt = Date.now();
        playAizuchi();
      }
    }
  }
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

// 山札方式：全ペアを使い切るまで同じ問題を出さない
let deck = [];
function drawSet() {
  if (!deck.length) {
    deck = CARD_SETS.map((_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  return CARD_SETS[deck.pop()];
}
const cardsEl = $("cards");
const cardBtns = [$("card0"), $("card1")];
let game = null; // { round, pair, target }

const displayEl = $("quiz-display");

$("game-btn").onclick = () => startGame("cards");
$("sound-btn").onclick = () => startGame("sound");
$("count-btn").onclick = () => startGame("count");

function startGame(type) {
  if (!running || game) return;
  game = { type, round: 0, targetIndex: 0, words: [] };
  nextRound(null);
}

// 配列から重複しない2つを選ぶ
function pick2(arr) {
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * (arr.length - 1));
  if (j >= i) j++;
  return [arr[i], arr[j]];
}

// 新しいラウンド開始（prevWord: 直前の正解。褒め＋次の出題を1メッセージで送り割り込みを防ぐ）
function nextRound(prevWord) {
  game.round++;
  const intro = prevWord
    ? "(She tapped " + prevWord + " — correct! Praise her briefly like 'Yay! Great!'. Then next question. "
    : "(Game starts! Say 'Let's play a game!'. ";
  let ask = "";
  displayEl.classList.add("hidden");

  if (game.type === "cards") {
    // どっちかな？
    const pair = drawSet().slice();
    if (Math.random() < 0.5) pair.reverse();
    game.targetIndex = Math.floor(Math.random() * 2);
    game.words = [pair[0].w, pair[1].w];
    cardBtns[0].textContent = pair[0].e;
    cardBtns[1].textContent = pair[1].e;
    ask = "The screen shows " + pair[0].w + " and " + pair[1].w +
      ". Ask her slowly: 'Where is the " + game.words[game.targetIndex] + "?' Keep it short.)";
  } else if (game.type === "sound") {
    // なきごえクイズ
    const pair = pick2(SOUND_ANIMALS);
    game.targetIndex = Math.floor(Math.random() * 2);
    const t = pair[game.targetIndex];
    game.words = [pair[0].w, pair[1].w];
    cardBtns[0].textContent = pair[0].e;
    cardBtns[1].textContent = pair[1].e;
    ask = "Animal sound quiz. The cards show " + pair[0].w + " and " + pair[1].w +
      ". Make the " + t.w + "'s sound in a fun, exaggerated way, like '" + t.s + " " + t.s +
      "', WITHOUT saying the animal's name. Then ask: 'What animal? Touch it!')";
  } else {
    // かずあてゲーム
    const item = COUNT_ITEMS[Math.floor(Math.random() * COUNT_ITEMS.length)];
    const n = 2 + Math.floor(Math.random() * 4); // 2〜5個
    let wrong = n + (Math.random() < 0.5 ? -1 : 1);
    if (wrong < 1) wrong = n + 1;
    game.targetIndex = Math.floor(Math.random() * 2);
    game.words = game.targetIndex === 0 ? [String(n), String(wrong)] : [String(wrong), String(n)];
    cardBtns[0].textContent = game.words[0];
    cardBtns[1].textContent = game.words[1];
    displayEl.textContent = Array(n).fill(item.e).join(" ");
    displayEl.classList.remove("hidden");
    ask = "Counting game. The screen shows " + n + " " + item.w + " and two number cards. " +
      "Ask her slowly: 'How many " + item.w + "?' If she is stuck, count together slowly. " +
      "The correct answer is " + n + ".)";
  }
  cardsEl.classList.remove("hidden");
  stopPlayback();
  sendText(intro + ask);
  setStatus("どっちかな？", "talking");
}

cardBtns.forEach((btn, i) => {
  btn.onclick = () => {
    if (!game) return;
    const tappedWord = game.words[i];
    if (i === game.targetIndex) {
      chime(true);
      addStar();
      if (game.round >= GAME_ROUNDS) {
        // 全問正解でゲームクリア
        game = null;
        cardsEl.classList.add("hidden");
        displayEl.classList.add("hidden");
        confetti(30);
        stopPlayback();
        sendText("(She tapped " + tappedWord + " — correct! GAME CLEAR, all " + GAME_ROUNDS +
          " questions! Celebrate her joyfully like a big fanfare: 'Yay! You did it! Amazing!' " +
          "Then go back to easy chatting.)");
        setStatus("ゲームクリア！すごい！", "talking");
      } else {
        confetti(8);
        nextRound(tappedWord);
      }
    } else {
      chime(false);
      stopPlayback();
      const hint = game.type === "sound" ? "Make the sound one more time and let her try again."
        : game.type === "count" ? "Count together with her slowly, then ask again."
        : "Ask the same question again, slower.";
      sendText("(She tapped " + tappedWord + " — not quite. Gently say 'Almost! Try again!' " + hint + ")");
    }
  };
});

// ピンポン音／ブブー音（WebAudioで生成、音声ファイル不要）
function chime(good) {
  if (!playCtx) return;
  const t = playCtx.currentTime;
  const notes = good ? [880, 1320] : [230];
  notes.forEach((f, i) => {
    const o = playCtx.createOscillator(), g = playCtx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.22, t + i * 0.12);
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
