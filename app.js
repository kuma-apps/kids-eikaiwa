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

// ---------- 再生（24kHz PCM キュー） ----------
function queuePcm(b64) {
  if (!playCtx) return;
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
const CARD_SETS = [
  [{ e: "🐶", w: "dog" }, { e: "🐱", w: "cat" }],
  [{ e: "🍎", w: "apple" }, { e: "🍌", w: "banana" }],
  [{ e: "🐘", w: "elephant" }, { e: "🐰", w: "rabbit" }],
  [{ e: "🚗", w: "car" }, { e: "⭐", w: "star" }],
  [{ e: "🐟", w: "fish" }, { e: "🐦", w: "bird" }],
  [{ e: "🍓", w: "strawberry" }, { e: "🍇", w: "grapes" }],
  [{ e: "👑", w: "crown" }, { e: "🎀", w: "ribbon" }],
  [{ e: "❄️", w: "snow" }, { e: "🌸", w: "flower" }]
];
const cardsEl = $("cards");
const cardBtns = [$("card0"), $("card1")];
let game = null; // { round, pair, target }

$("game-btn").onclick = () => {
  if (!running || game) return;
  game = { round: 0, pair: null, target: null };
  nextRound(null);
};

// 新しいラウンド開始（prevWord: 直前の正解ワード。褒め＋次の出題を1メッセージで送る）
function nextRound(prevWord) {
  game.round++;
  const pair = CARD_SETS[Math.floor(Math.random() * CARD_SETS.length)].slice();
  if (Math.random() < 0.5) pair.reverse();
  game.pair = pair;
  game.target = pair[Math.floor(Math.random() * 2)];
  cardBtns[0].textContent = pair[0].e;
  cardBtns[1].textContent = pair[1].e;
  cardsEl.classList.remove("hidden");
  stopPlayback();
  const intro = prevWord
    ? "(She tapped the " + prevWord + " — correct! Praise her briefly like 'Yay! Great!'. Then next question. "
    : "(Card game starts! Say 'Let's play a game!'. ";
  sendText(intro + "The screen shows " + pair[0].w + " and " + pair[1].w +
    ". Ask her slowly: 'Where is the " + game.target.w + "?' Keep it short.)");
  setStatus("どっちかな？", "talking");
}

cardBtns.forEach((btn, i) => {
  btn.onclick = () => {
    if (!game || !game.pair) return;
    const tapped = game.pair[i];
    if (tapped.w === game.target.w) {
      chime(true);
      addStar();
      if (game.round >= 3) {
        // 3問正解でゲームクリア
        game = null;
        cardsEl.classList.add("hidden");
        confetti(24);
        stopPlayback();
        sendText("(She tapped the " + tapped.w + " — correct! GAME CLEAR, 3 out of 3! " +
          "Celebrate her joyfully like a fanfare: 'Yay! You did it! Three stars!' " +
          "Then go back to easy chatting.)");
        setStatus("ゲームクリア！すごい！", "talking");
      } else {
        confetti(8);
        nextRound(tapped.w);
      }
    } else {
      chime(false);
      stopPlayback();
      sendText("(She tapped the " + tapped.w + " — not quite. Gently say 'Almost! Try again!' " +
        "and ask the same question again, slower.)");
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
