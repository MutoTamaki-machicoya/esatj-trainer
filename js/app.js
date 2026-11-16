/* =========================================================
   ESAT-J トレーナー アプリ本体
   - フレームワークなしの素のJS（ビルド不要）
   - 録音: MediaRecorder / 読み上げ: SpeechSynthesis
   - 文字起こし(参考): SpeechRecognition（対応ブラウザのみ）
   - Claude採点: アーティファクトの sample 機能（教室の端末だけ。無い環境では出さない）
   ========================================================= */

"use strict";

const $app = () => document.getElementById("app");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const OFFICIAL_URL = "https://www.kyoiku.metro.tokyo.lg.jp/school/content/global/esat-j";

/* ---------- 設定 ---------- */
const IS_MOBILE = /iPhone|iPad|Android/i.test(navigator.userAgent);
// Claudeのアーティファクトとして開いているか（window.claude は最初のスクリプトより前に用意される）。
// アーティファクトでは、対応する capability の無い端末API（getUserMedia / MediaRecorder / SpeechRecognition）は
// 確認なしで拒否されるので、最初から使わない。話した英語は dictation capability で文字にする
const IN_ARTIFACT = !!(window.claude && typeof window.claude.use === "function");
const SR_CTOR = IN_ARTIFACT ? null : (window.SpeechRecognition || window.webkitSpeechRecognition || null);

const Settings = {
  // srOn は自動採点の土台。使えない端末では実行時に自動で落ちる
  data: { showText: false, srOn: !!SR_CTOR, rate: 0.95 },
  load() {
    try {
      const raw = localStorage.getItem("esatj_settings_v1");
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* 破損時は初期値 */ }
  },
  save() {
    try { localStorage.setItem("esatj_settings_v1", JSON.stringify(this.data)); } catch (e) {}
  },
};

const History = {
  list: [],
  load() {
    try { this.list = JSON.parse(localStorage.getItem("esatj_history_v1") || "[]"); } catch (e) { this.list = []; }
  },
  add(entry) {
    this.list.unshift(entry);
    this.list = this.list.slice(0, 30);
    try { localStorage.setItem("esatj_history_v1", JSON.stringify(this.list)); } catch (e) {}
  },
  clear() {
    this.list = [];
    try { localStorage.removeItem("esatj_history_v1"); } catch (e) {}
  },
};

/* ---------- 読み上げ (TTS) ---------- */
const TTS = {
  voice: null,
  pick() {
    if (!("speechSynthesis" in window)) return;
    const vs = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
    if (!vs.length) return;
    const prefer = ["Google US English", "Samantha", "Aaron", "Microsoft Ana", "Microsoft Aria", "Karen", "Daniel"];
    let best = null;
    for (const name of prefer) {
      best = vs.find((v) => v.name.includes(name));
      if (best) break;
    }
    this.voice = best || vs.find((v) => v.lang.toLowerCase().startsWith("en-us")) || vs[0];
  },
  init() {
    if (!("speechSynthesis" in window)) return;
    this.pick();
    speechSynthesis.onvoiceschanged = () => this.pick();
  },
  available() { return !!this.voice; },
  warm() {
    // iOS対策: ユーザー操作の直後に一度発話しておく
    if (!("speechSynthesis" in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) {}
  },
  stop() { try { speechSynthesis.cancel(); } catch (e) {} },
  // onend は「全再生が終わったとき」に必ず1回だけ呼ぶ。
  // onendが発火しないブラウザ対策として、文の長さから見積もった上限時間で強制的に先へ進む。
  speak(text, { times = 1, gap = 700, onend = null } = {}) {
    if (!this.available()) { if (onend) onend(); return; }
    this.stop();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (onend) onend();
    };
    const words = text.split(/\s+/).length;
    const maxMs = times * (2000 + words * 700) + (times - 1) * gap + 3000;
    const guard = setTimeout(finish, maxMs);
    let count = 0;
    const say = () => {
      if (finished) return;
      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voice;
      u.lang = this.voice.lang || "en-US";
      u.rate = Settings.data.rate;
      u.onend = () => {
        count += 1;
        if (count < times) setTimeout(say, gap);
        else { clearTimeout(guard); finish(); }
      };
      u.onerror = () => { clearTimeout(guard); finish(); };
      speechSynthesis.speak(u);
    };
    say();
  },
};

/* ---------- 効果音 ---------- */
const Beep = {
  ctx: null,
  init() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },
  play(freq = 880, dur = 0.18, when = 0) {
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime + when;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch (e) {}
  },
  start() { this.play(880, 0.15); this.play(880, 0.15, 0.22); },
  end() { this.play(520, 0.3); },
};

/* ---------- 録音 ---------- */
const Rec = {
  stream: null,
  recorder: null,
  chunks: [],
  mime: "",
  supported: !IN_ARTIFACT && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
  async init() {
    if (!this.supported) return false;
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return true;
    } catch (e) {
      return false;
    }
  },
  pickMime() {
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const m of cands) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  },
  start() {
    if (!this.stream) return false;
    try {
      this.chunks = [];
      this.mime = this.pickMime();
      this.recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
      this.mime = this.recorder.mimeType || this.mime || "audio/webm";
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recorder.start();
      return true;
    } catch (e) {
      this.recorder = null;
      return false;
    }
  },
  stop() {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r || r.state === "inactive") { resolve(null); return; }
      r.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this.recorder = null;
        resolve(blob.size ? { url: URL.createObjectURL(blob), mime: this.mime } : null);
      };
      try { r.stop(); } catch (e) { resolve(null); }
    });
  },
  release() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  },
};

/* ---------- 文字起こし（参考機能） ---------- */
const SR = {
  inst: null,
  text: "",
  failed: false,
  enabled() { return !!SR_CTOR && Settings.data.srOn && !this.failed; },
  start() {
    this.text = "";
    if (!this.enabled()) return;
    try {
      const r = new SR_CTOR();
      r.lang = "en-US";
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) this.text += e.results[i][0].transcript + " ";
        }
      };
      r.onerror = () => { this.failed = true; };
      r.start();
      this.inst = r;
    } catch (e) { this.inst = null; }
  },
  stop() {
    if (this.inst) { try { this.inst.stop(); } catch (e) {} this.inst = null; }
  },
};

/* ---------- タイマー ---------- */
const Timer = {
  handle: null,
  stop() { if (this.handle) { clearInterval(this.handle); this.handle = null; } },
  run(sec, onTick, onEnd) {
    this.stop();
    const endAt = performance.now() + sec * 1000;
    onTick(sec);
    this.handle = setInterval(() => {
      const remain = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
      onTick(remain);
      if (remain <= 0) { this.stop(); onEnd(); }
    }, 100);
  },
};

/* =========================================================
   Claude採点（教室の端末だけで動く追加機能）
   - アーティファクトの sample 機能（claude.use("sample")）を使う
   - window.claude が無い／null が返る環境（生徒のスマホの共有リンク・ローカル版）では
     ボタンごと出さない。従来のブラウザ内自動採点はそのまま動く
   - 送るのは「問題」「文字起こし（または講師の手入力）」「解答時間」「採点基準の要約」だけ。
     名前・録音は送らない。送るのはボタンを押したときだけ
   ========================================================= */
const AI_LEVELS = ["A2.2", "A2.1", "A1.3", "A1.2", "A1.1", "PreA1", "判定不能"];
const AI_NOTE = "文字起こしを元にした目安です。発音は採点していません。";

const AI = {
  sample: null,     // claude.use("sample") の結果
  blocked: false,   // not_granted など、この画面では二度と出さない
  allBusy: false,
  on() { return !!this.sample && !this.blocked; },
  async init() {
    if (!IN_ARTIFACT) return; // ローカル版・ふつうのブラウザ
    const c = window.claude;
    const safe = (name) => { try { return Promise.resolve(c.use(name)).catch(() => null); } catch (e) { return Promise.resolve(null); } };
    const [smp, d] = await Promise.all([safe("sample"), safe("dictation")]);
    this.sample = smp && typeof smp.json === "function" ? smp : null;
    if (d && typeof d.start === "function") Dict.bind(d);
    fillAnswerSlots();
    refreshEnvNotes();
  },
  // 失敗の種類ごとの対応（ループで再試行しない）
  handleError(e, statusEl) {
    const code = e && e.code ? e.code : "upstream_error";
    const hide = ["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"];
    if (hide.includes(code)) { this.blocked = true; fillAnswerSlots(); return; }
    const msg = {
      cancelled: "採点を止めました。",
      rate_limited: "Claudeの利用が混み合っています。少し待ってから、もう一度押してください。",
      session_expired: "Claudeへのログインが切れています。ログインし直してから押してください。",
      invalid_json: "結果をうまく読み取れませんでした。もう一度押してください。",
      refused: "この解答は採点できませんでした。文字起こしを直して、もう一度押してください。",
      empty_completion: "この解答は採点できませんでした。文字起こしを直して、もう一度押してください。",
      prompt_too_large: "解答が長すぎて送れません。文字起こしを短くしてください。",
    }[code] || "通信が途切れました。もう一度押してください。";
    if (statusEl) statusEl.textContent = msg;
  },
};

/* ---------- 文字起こし（アーティファクト用：dictation capability） ----------
   - 生のマイクは使えないので、話した英語は platform の音声入力で受け取る（音そのものは受け取らない）
   - start() は閲覧者のクリックの中で同期的に呼ぶ必要がある。本番モードは問題の間にクリックが無いので、
     セッション開始・各Partの「はじめる」・「次へ」のクリックで start() し、セッション中は聞き続ける。
     使うのは「解答中」に確定した文字だけ（準備中・質問の読み上げ中の文字は捨てる）
   - 使えない閲覧者（組織外・Safari・スマホのアプリなど）は null → 手入力と自己チェックで振り返る
   ------------------------------------------------------------------ */
const Dict = {
  ns: null,
  off: false,       // not_granted / unavailable：この画面ではもう出さない
  state: "idle",
  route: null,      // "answer"＝解答の文字起こし／textarea＝手入力欄へ
  buf: "",
  usable() { return !!this.ns && !this.off; },
  listening() { return this.usable() && this.state === "listening"; },
  bind(ns) {
    this.ns = ns;
    try {
      ns.onFinal(({ text }) => {
        if (!text) return;
        if (this.route === "answer") { this.buf += text; return; }
        const ta = this.route;
        if (ta && ta.isConnected && ta.tagName === "TEXTAREA") {
          ta.value += ta.value.trim() ? text : text.replace(/^\s+/, "");
          ta.dispatchEvent(new Event("input"));
        }
      });
      ns.onPartial(({ text }) => {
        const ta = this.route;
        const box = ta && ta.isConnected && ta.closest ? ta.closest(".ai-panel") : null;
        const el = box ? box.querySelector(".ai-partial") : null;
        if (el) el.textContent = text ? "🎙 " + text : "";
      });
      ns.onState(({ state, reason }) => {
        this.state = state;
        if (state === "idle") {
          document.querySelectorAll(".ai-partial").forEach((el) => { el.textContent = ""; });
          if (reason === "not_granted" || reason === "unavailable") { this.off = true; fillAnswerSlots(); refreshEnvNotes(); }
          if (this.route && this.route !== "answer") this.route = null;
        }
        this.paint();
      });
    } catch (e) { this.ns = null; }
  },
  // クリックの中から呼ぶ（先に await しない）。聞いていなければ聞き始める
  ensure() {
    if (!this.usable()) return;
    try { if (this.ns.active()) return; } catch (e) { return; }
    this.ns.start({ language: "en" }).catch((e) => {
      const c = e && e.code;
      if (c === "not_granted" || c === "unavailable") { this.off = true; fillAnswerSlots(); refreshEnvNotes(); }
    });
  },
  stop() {
    this.route = null;
    if (!this.ns) return;
    try { if (this.ns.active()) this.ns.stop().catch(() => {}); } catch (e) {}
  },
  // 手入力欄の「🎙 声で入力」ボタンの表示
  paint() {
    document.querySelectorAll(".ai-dict").forEach((b) => {
      const ta = b.closest(".ai-panel") && b.closest(".ai-panel").querySelector(".ai-text");
      const on = this.state !== "idle" && this.route === ta;
      b.textContent = on ? "⏹ 声で入力をやめる" : "🎙 声で入力";
      b.classList.toggle("listening", on);
    });
    const live = document.getElementById("dict-live");
    if (live) live.classList.toggle("hidden", !(this.route === "answer" && this.listening()));
  },
};

// どの開き方で、何が使えるか（ホームの動作チェック・設定・各Partの説明に出す）
function envSummary() {
  return {
    where: IN_ARTIFACT ? "Claudeのアーティファクト" : "ふつうのWebブラウザ",
    rec: Rec.supported,
    text: IN_ARTIFACT ? (Dict.usable() ? "dictation" : null) : (SR_CTOR ? "browser" : null),
    ai: AI.on(),
    tts: TTS.available(),
  };
}
function envNoteHtml() {
  if (!IN_ARTIFACT) return "";
  return Dict.usable()
    ? `<div class="warn-banner">この開き方では録音できません。話した英語は音声入力（🎙）で文字にして採点します。</div>`
    : `<div class="warn-banner">この開き方では録音できません。解答のあとに、お手本・自己チェック・講師の入力で振り返ります。</div>`;
}
function refreshEnvNotes() {
  document.querySelectorAll(".env-note").forEach((el) => { el.innerHTML = envNoteHtml(); });
}

// 令和8年度 採点基準（都教委公開）の要約。Claudeへの指示に使う
const AI_RUBRIC = {
  A: "Part A 音読（2問・準備30秒・音読30秒）。観点は「発音と強勢」「読む速さや間の取り方」。上段＝多少の誤りがあっても聞き手が十分に理解できる発音・速さ・間。中段＝発音の誤りや不自然な間があり、分かりにくいことがある。下段＝分かりにくいことが多く、意味が伝わらない。最下段＝大部分が分かりにくい、または評価に十分な量を読んでいない。levelは 上段→A2.2、中段→A1.3、下段→A1.1、最下段→PreA1 に置きかえて答える。文字起こしでは発音が分からないので、主に「原文をどれだけ最後まで読めたか（読み飛ばし・読めなかった語）」で判断する。",
  B: "Part B 会話（5問・各15秒以内）。No.1・2はイラストについて相手が質問、No.3・4は自分自身について相手が質問（どちらも音声のみ・準備なし）、No.5は日本語で示された内容を自分から英語で質問（準備10秒）。A2.1＝5問すべて場面に応じて適切（必要に応じて文を使い、文法・語彙が適切）／A1.3＝少なくとも4問が適切（平易な文、多少の基礎的な誤り）／A1.2＝少なくとも3問が適切／A1.1＝少なくとも1問が適切（誤りが多い）／PreA1＝まとまりのない語句を並べる程度で適切な解答がない。無言・英語でない・求められた内容から明らかに外れた解答は適切に数えない。1問だけを判定するときは：適切で文で答えている（No.5は質問の形）→A2.1、適切だが語句だけ・小さな誤り→A1.3、情報が一部だけ・誤りで分かりにくい→A1.2、何とか伝わる程度→A1.1、答えになっていない・外れている→PreA1。",
  C: "Part C ナレーション（準備30秒・40秒以内）。4コマの人物（自分）になったつもりで、画面の書き出し（Last week など）から時間の順に話す。A2.2＝重要な5つのポイントすべてに触れ、4枚すべてを時間を追って順序立てて説明。接続詞・代名詞を効果的に使い、文法・語彙を幅広く適切に使う／A2.1＝重要なポイントのうち4つに触れ、4枚すべてを順序立てて説明。接続詞・代名詞を使っている／A1.3＝4枚を一連の出来事として説明しているが、1枚の説明が不十分／A1.2＝少なくとも2枚の出来事を説明。順序立てる表現を使っていない／A1.1＝出来事に触れているが適切な説明になっていない／PreA1＝まとまりのない語句を並べる程度。",
  D: "Part D 意見（先生の説明を聞く→準備60秒・40秒以内）。テーマについて、3つのヒントか自分の考えのどれか1つを基に意見と理由を述べる。A2.2＝明確な意見に効果的な理由や例を加え、補足情報でより詳しく説明。接続詞などを効果的に使い、文法・語彙が幅広い／A2.1＝意見に理由や例を加えている。補足情報を加えようとしているが十分でないことがある。接続詞などを使っている／A1.3＝少なくとも1つの理由や例を加えて意見を述べている／A1.2＝意見を述べ理由や例を伝えようとしているが、接続詞などでつないでいない／A1.1＝意見を述べようとしているが、理由や例を述べていない／PreA1＝まとまりのない語句を並べる程度。",
};

const AI_HEAD = [
  "あなたは東京都の中学3年生向け英語スピーキングテスト「ESAT-J YEAR 3」（令和8年度）の採点基準に詳しい英語の先生です。",
  "塾の練習で録音した生徒の解答を、下の採点基準に照らして目安で判定してください。",
  "注意：",
  "- 判断の材料は、ブラウザの音声認識による文字起こし（または講師が聞き取って入力した英文）だけです。音声認識の聞き違いと思われる語は、文脈から好意的に解釈してください。",
  "- 発音・イントネーションは判定できません。内容・文の形・語彙と文法・つなぎ方で判断してください。",
  "- 文字起こしが空、または短すぎて判断できないときだけ level を「判定不能」にしてください（無言は本番では点にならない、と fix に書く）。",
  "- コメントは中学生が読んで分かる、やさしい日本語で短く書いてください。",
].join("\n");

// SVG のイラストから文字（ポスターの文言など）だけを取り出す
function svgText(svg) {
  const out = [];
  String(svg || "").replace(/<text[^>]*>([\s\S]*?)<\/text>/g, (m, t) => {
    const s = t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (s) out.push(s);
    return m;
  });
  return out.join(" / ");
}

function answerTextOf(ans) {
  if (!ans) return "";
  const m = typeof ans.manual === "string" ? ans.manual.trim() : "";
  return m || (ans.transcript || "").trim();
}

function aiItemBlock(it, data, ans, set) {
  const t = timingOf(it, data);
  const said = answerTextOf(ans);
  const lines = [`【${itemLabel(it)}】（id: ${data.id}）`];
  if (it.part === "A") {
    if (data.situation) lines.push("場面：" + data.situation);
    lines.push("原文：" + data.text);
  } else if (it.part === "B") {
    lines.push("場面：" + set.B.scene);
    if (data.kind === "fig") {
      lines.push("種類：イラストについての質問（音声のみ）");
      lines.push("イラストに書かれている内容：" + (set.B.figure.text || svgText(set.B.figure.svg)));
      lines.push("質問：" + data.q);
      const prev = prevAnswerText(it);
      if (prev) lines.push("（参考）同じ場面の No.1 での生徒の解答：\"" + prev + "\"（No.2 は No.1 で選んだものと合っているかも見る）");
    } else if (data.kind === "self") {
      lines.push("種類：生徒自身についての質問（音声のみ。答えの中身は本当でなくてよい）");
      lines.push("質問：" + data.q);
    } else {
      lines.push("種類：生徒から相手に質問する問題（準備10秒）");
      lines.push("画面の指示（日本語）：" + data.jp);
    }
  } else if (it.part === "C") {
    lines.push("場面：" + data.scene);
    lines.push("指定の書き出し：" + data.opener);
    lines.push("重要な5つのポイント：" + data.points.map((p, i) => `${i + 1}. ${p}`).join(" "));
  } else {
    lines.push("先生の説明（音声）：" + data.narration);
    lines.push("テーマ：" + data.theme);
    lines.push("ヒント：" + data.hints.join(" / ") + "（または自分の考え）");
  }
  lines.push(`解答時間：${ans && ans.secs != null ? ans.secs + "秒" : "不明"}（制限${t.ans}秒以内）`);
  lines.push("生徒の解答：" + (said ? `"${said}"` : "（聞き取れず：文字起こしが空）"));
  return lines.join("\n");
}

const AI_ITEM_FIELDS = '"level": "A2.2 / A2.1 / A1.3 / A1.2 / A1.1 / PreA1 / 判定不能 のどれか1つ", "good": "できている点を1つ（日本語・1文）", "fix": "直す点を1つ（日本語・具体的に・1〜2文）", "better": "生徒の解答を最小限だけ直した英語の言い直し例", "next": "次の1回で意識すること（日本語・1文）"';
const AI_A_EXTRA = 'Part A は fix で「読めなかった語・飛ばした部分」を具体的に挙げ、"missed": ["文字起こしと原文の差から読めていないと思われる語", …]（最大8語）も加える。better には原文に区切り（ / ）を入れたものを書く。';

function aiPromptOne(it, data, ans, set) {
  return [
    AI_HEAD, "",
    "[採点基準（要約）]", AI_RUBRIC[it.part], "",
    "[問題と解答]", aiItemBlock(it, data, ans, set), "",
    it.part === "A" ? AI_A_EXTRA : "",
    "次の形のJSONオブジェクトだけを返してください（前後に説明の文は不要）。",
    "{" + AI_ITEM_FIELDS + (it.part === "A" ? ', "missed": ["…"]' : "") + "}",
  ].join("\n");
}

function aiPromptAll(sess) {
  const parts = sess.parts.filter((p) => sess.items.some((it) => it.part === p));
  const blocks = sess.items.map((it) => {
    const data = itemData(it, sess.set);
    return aiItemBlock(it, data, sess.answers[data.id], sess.set);
  });
  return [
    AI_HEAD, "",
    "[採点基準（要約）]", ...parts.map((p) => AI_RUBRIC[p]), "",
    "[問題と解答の一覧]", blocks.join("\n\n"), "",
    "各問題を判定し、さらにPartごとの判定もしてください（Part B は5問全体で何問が適切だったかで判定。Part A は2問の平均的な出来）。",
    parts.includes("A") ? AI_A_EXTRA.replace("Part A は", "Part A の各問題は") : "",
    "次の形のJSONオブジェクトだけを返してください（前後に説明の文は不要）。",
    '{"parts": {' + parts.map((p) => `"${p}": "レベル"`).join(", ") + '}, "items": [{"id": "問題のid", ' + AI_ITEM_FIELDS + '}, …（全' + sess.items.length + '問）], "summary": "全体へのひとこと（日本語・1〜2文。次の授業で優先して直すこと）"}',
  ].join("\n");
}

function normLevel(v) {
  const s = String(v || "").trim();
  return AI_LEVELS.includes(s) ? s : "判定不能";
}
function normAi(o) {
  o = o && typeof o === "object" ? o : {};
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
  return {
    level: normLevel(o.level),
    good: str(o.good), fix: str(o.fix), better: str(o.better), next: str(o.next),
    missed: Array.isArray(o.missed) ? o.missed.map(str).filter(Boolean).slice(0, 8) : [],
  };
}
const lvClass = (lv) => "ai-lv-" + (lv === "判定不能" ? "none" : lv.replace(/\./g, ""));

function aiResultHtml(r) {
  if (!r) return "";
  return `
    <div class="ai-result">
      <div class="ai-head"><span class="ai-level ${lvClass(r.level)}">${esc(r.level)}</span><span class="ai-title">Claudeの判定（目安）</span></div>
      ${r.good ? `<p class="ai-line"><b>👍 できている点</b>${esc(r.good)}</p>` : ""}
      ${r.fix ? `<p class="ai-line"><b>🔧 直す点</b>${esc(r.fix)}</p>` : ""}
      ${r.missed && r.missed.length ? `<div class="key-row">${r.missed.map((w) => `<span class="key-chip">${esc(w)}</span>`).join("")}</div>` : ""}
      ${r.better ? `<div class="ai-line"><b>✏️ 言い直し例</b><p class="en-model strong">${esc(r.better)}</p><button class="btn tiny secondary" data-say="${esc(r.better)}">🔊 聞く</button></div>` : ""}
      ${r.next ? `<p class="ai-line"><b>🎯 次の1回</b>${esc(r.next)}</p>` : ""}
    </div>`;
}

// 1問ぶんの「解答の英語」パネル（どの端末でも出す）
// - 文字起こしを直す／講師が聞き取った英語を打ち込む → 「✅ この英語で自動採点」（ブラウザ内）
// - 🎙 声で入力（dictation が使える閲覧者だけ）
// - 🤖 Claudeに採点してもらう（sample が使える教室の端末だけ）
function aiSlotHtml(qid) {
  return `<div class="ai-slot" data-ai="item" data-qid="${esc(qid)}"></div>`;
}

function fillAnswerSlots() {
  document.querySelectorAll(".ai-slot").forEach((slot) => {
    const show = !!session && (slot.dataset.ai === "all" ? AI.on() : true);
    if (!show) { slot.innerHTML = ""; slot.classList.add("hidden"); return; }
    slot.classList.remove("hidden");
    if (slot.dataset.ai === "all") fillAiAll(slot);
    else fillAnswerItem(slot);
  });
}

function findItem(qid) {
  if (!session) return null;
  for (const it of session.items) {
    const data = itemData(it, session.set);
    if (data.id === qid) return { it, data };
  }
  return null;
}

/* ---------- 自己チェック（自動採点できなかった問題） ---------- */
function selfChecksOf(it, data) {
  if (it.part === "C") {
    return [`画面の書き出し「${data.opener}」から始めた`]
      .concat(data.points.map((p, i) => `ポイント${i + 1}：${p}`))
      .concat(["つなぎ語（Then / So / After that）と過去形を使った"]);
  }
  if (it.part === "D") {
    return ["① 意見をはっきり言えた（I think 〜.）", "② 理由を言えた（First, 〜. / Because 〜.）", "③ 具体例を言えた（For example, 〜.）", "④ まとめた（So, I think 〜.）"];
  }
  return CHECKS[it.part];
}

function selfCheckHtml(it, data, ans) {
  if (ans && ans.score) return "";
  const done = (ans && ans.self) || {};
  return `
    <div class="checks" data-qid="${esc(data.id)}">
      <div class="model-title">✔ 自己チェック（録音・お手本と比べて、できたことに印）</div>
      ${selfChecksOf(it, data).map((c, ci) => `
        <label class="check-row"><input type="checkbox" class="self-check" data-qid="${esc(data.id)}" data-ci="${ci}" ${done[ci] ? "checked" : ""}><span>${esc(c)}</span></label>`).join("")}
    </div>`;
}

// 自己チェックの印を解答に記録する（画面をまたいで最終画面に引きつぐ）
function bindSelfChecks(root, onChange) {
  root.querySelectorAll(".self-check").forEach((b) => {
    b.onchange = () => {
      const ans = session && session.answers[b.dataset.qid];
      if (ans) { ans.self = ans.self || {}; ans.self[b.dataset.ci] = b.checked; }
      if (onChange) onChange();
    };
  });
}

// 手入力・音声入力で直した英語で、ブラウザ内の自動採点をやり直す
function rescoreAnswer(it, data) {
  const ans = session.answers[data.id] || (session.answers[data.id] = {});
  const text = answerTextOf(ans);
  ans.score = scoreAnswer(it.part, { qid: data.id, setId: session.set.id, prev: prevAnswerText(it) }, data.text, text);
  refreshScoreViews(it, data);
}

function refreshScoreViews(it, data) {
  const ans = session.answers[data.id] || {};
  document.querySelectorAll(`.score-area[data-qid="${data.id}"]`).forEach((el) => {
    el.innerHTML = scoreCardHtml(ans) + (el.dataset.self === "1" ? selfCheckHtml(it, data, ans) : "");
    bindSelfChecks(el, () => updateFinalGrade());
  });
  document.querySelectorAll(`.self-area[data-qid="${data.id}"]`).forEach((el) => {
    el.innerHTML = selfCheckHtml(it, data, ans);
    bindSelfChecks(el, () => updateFinalGrade());
  });
  document.querySelectorAll(`.row-grade[data-qid="${data.id}"]`).forEach((el) => {
    el.innerHTML = ans.score ? `<span class="hist-grade g-${ans.score.grade}">${ans.score.grade}</span>` : "";
  });
  renderFinalTable();
  renderFinalResult();
}

function fillAnswerItem(slot) {
  const qid = slot.dataset.qid;
  const found = findItem(qid);
  if (!found) return;
  const { it, data } = found;
  const ans = session.answers[qid] || (session.answers[qid] = {});
  const val = typeof ans.manual === "string" ? ans.manual : (ans.transcript || "");
  const showDict = Dict.usable();
  const ai = AI.on();
  slot.innerHTML = `
    <div class="ai-panel">
      <div class="ai-panel-title">✍️ 解答の英語${ai ? "（🤖 Claude採点つき）" : ""}</div>
      <label class="ai-label">文字起こしを直す・聞き取れなかったときは講師が聞いた英語を入力${showDict ? "（🎙 で声でも入力できます）" : ""}</label>
      <textarea class="ai-text" rows="3" placeholder="例）It starts at one p.m.">${esc(val)}</textarea>
      <div class="ai-partial"></div>
      <div class="btn-row ai-btns">
        ${showDict ? '<button class="btn tiny ghost ai-dict" type="button">🎙 声で入力</button>' : ""}
        <button class="btn tiny ghost ans-rescore" type="button">✅ この英語で自動採点</button>
        ${ai ? '<button class="btn secondary ai-go" type="button">🤖 Claudeに採点してもらう</button>' : ""}
      </div>
      <div class="ai-status muted small"></div>
      ${ai ? `<div class="ai-out">${aiResultHtml(ans.ai)}</div><p class="ai-note">※ ${AI_NOTE}</p>` : ""}
    </div>`;
  const ta = slot.querySelector(".ai-text");
  const status = slot.querySelector(".ai-status");
  ta.addEventListener("input", () => { ans.manual = ta.value; });
  slot.querySelector(".ans-rescore").onclick = () => {
    ans.manual = ta.value;
    rescoreAnswer(it, data);
    status.textContent = ans.score ? "自動採点しました。" : "英語が入っていないので採点できません。";
  };
  const dictBtn = slot.querySelector(".ai-dict");
  if (dictBtn) {
    dictBtn.onclick = () => {
      // dictation の start() はクリックの中で同期的に呼ぶ（Dict.ensure の中で呼ぶ）
      if (Dict.route === ta) { Dict.route = null; Dict.paint(); status.textContent = ""; return; }
      Dict.route = ta;
      Dict.ensure();
      Dict.paint();
      status.textContent = "英語で話してください（もう一度押すとやめます）";
    };
  }
  const go = slot.querySelector(".ai-go");
  if (!go) return;
  bindSayButtons(slot.querySelector(".ai-out"));
  if (ans.aiBusy) { go.disabled = true; status.textContent = "🤖 Claudeが採点しています…"; }
  go.onclick = async () => {
    if (ans.aiBusy) return;
    ans.manual = ta.value;
    ans.aiBusy = true;
    go.disabled = true;
    const ctl = new AbortController();
    status.innerHTML = '🤖 Claudeが採点しています…（10〜60秒ほど） <button class="btn tiny ghost ai-stop" type="button">止める</button>';
    status.querySelector(".ai-stop").onclick = () => ctl.abort();
    try {
      const raw = await AI.sample.json(aiPromptOne(it, data, ans, session.set), { signal: ctl.signal });
      ans.ai = normAi(raw);
      // 画面を移動していても結果は記録しておく（最終画面の表に出る）
      const live = document.querySelector(`.ai-slot[data-ai="item"][data-qid="${qid}"]`);
      if (live && live.querySelector(".ai-out")) {
        live.querySelector(".ai-out").innerHTML = aiResultHtml(ans.ai);
        live.querySelector(".ai-status").textContent = "";
        bindSayButtons(live.querySelector(".ai-out"));
      }
      renderFinalTable();
    } catch (e) {
      const live = document.querySelector(`.ai-slot[data-ai="item"][data-qid="${qid}"] .ai-status`);
      AI.handleError(e, live);
    } finally {
      ans.aiBusy = false;
      const liveGo = document.querySelector(`.ai-slot[data-ai="item"][data-qid="${qid}"] .ai-go`);
      if (liveGo) liveGo.disabled = false;
    }
  };
}

// 最終画面：全問まとめて1回で採点（1問ずつループで呼ばない）
function fillAiAll(slot) {
  const res = session.aiAll;
  slot.innerHTML = `
    <div class="ai-panel all">
      <div class="ai-panel-title">🤖 Claude採点（教室の端末用）</div>
      <p class="muted small">全${session.items.length}問の文字起こし（下の各問の欄で直した内容を含む）を、令和8年度の採点基準でまとめて判定します。</p>
      <button class="btn secondary wide ai-go-all" type="button">🤖 全問まとめてClaudeに採点してもらう</button>
      <div class="ai-status muted small"></div>
      ${res && res.summary ? `<p class="score-advice">💬 ${esc(res.summary)}</p>` : ""}
      <p class="ai-note">※ ${AI_NOTE}</p>
    </div>`;
  const go = slot.querySelector(".ai-go-all");
  const status = slot.querySelector(".ai-status");
  if (AI.allBusy) { go.disabled = true; status.textContent = "🤖 Claudeが採点しています…"; }
  go.onclick = async () => {
    if (AI.allBusy) return;
    AI.allBusy = true;
    go.disabled = true;
    const ctl = new AbortController();
    status.innerHTML = '🤖 Claudeが採点しています…（30秒〜2分ほど） <button class="btn tiny ghost ai-stop" type="button">止める</button>';
    status.querySelector(".ai-stop").onclick = () => ctl.abort();
    const sess = session;
    try {
      const raw = await AI.sample.json(aiPromptAll(sess), { signal: ctl.signal });
      const o = raw && typeof raw === "object" ? raw : {};
      const parts = {};
      Object.keys(o.parts || {}).forEach((p) => { if (PART_META[p]) parts[p] = normLevel(o.parts[p]); });
      (Array.isArray(o.items) ? o.items : []).forEach((x) => {
        const id = x && String(x.id || "");
        if (id && sess.answers[id]) sess.answers[id].ai = normAi(x);
      });
      sess.aiAll = { parts: parts, summary: typeof o.summary === "string" ? o.summary.trim() : "" };
      if (session === sess) { fillAnswerSlots(); renderFinalTable(); }
    } catch (e) {
      AI.handleError(e, document.querySelector('.ai-slot[data-ai="all"] .ai-status'));
    } finally {
      AI.allBusy = false;
      const g = document.querySelector(".ai-go-all");
      if (g) g.disabled = false;
    }
  };
}

/* ---------- アプリ状態 ---------- */
let session = null; // { set, mode, parts, items, cur, answers, micOK }
let flowId = 0;     // 画面遷移ごとに増やし、古い非同期コールバックを無効化する
// 画面が変わったら、手入力欄への音声入力だけ切る（解答の文字起こしは finish() が片づける）
const bump = () => { if (Dict.route && Dict.route !== "answer") Dict.route = null; return ++flowId; };
const alive = (id) => id === flowId;

// window.confirm はサンドボックス内(iframe埋め込み等)で無効化されることがあるため自前モーダルを使う
function askConfirm(message, onYes) {
  const old = document.querySelector(".confirm-overlay");
  if (old) old.remove();
  const wrap = document.createElement("div");
  wrap.className = "confirm-overlay";
  wrap.innerHTML = `
    <div class="confirm-box">
      <p>${esc(message)}</p>
      <div class="btn-row">
        <button class="btn ghost" data-c="no">やめる</button>
        <button class="btn danger" data-c="yes">OK</button>
      </div>
    </div>`;
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b) { if (e.target === wrap) wrap.remove(); return; }
    wrap.remove();
    if (b.dataset.c === "yes") onYes();
  });
  document.body.appendChild(wrap);
}

function partOf(item) { return PART_META[item.part]; }
function itemLabel(item) {
  if (item.part === "A") return "Part A No." + (item.idx + 1);
  if (item.part === "B") return "Part B No." + (item.idx + 1);
  if (item.part === "C") return "Part C";
  return "Part D";
}
function itemData(item, set) {
  if (item.part === "A") return set.A[item.idx];
  if (item.part === "B") return set.B.questions[item.idx];
  if (item.part === "C") return set.C;
  return set.D;
}
// Part B No.2 は No.1 の答え（どれを選んだか）と合っているかを見るので、No.1 の解答を渡す
function prevAnswerText(item) {
  if (!session || item.part !== "B" || item.idx !== 1) return "";
  const first = session.set.B.questions[0];
  return answerTextOf(session.answers[first.id]);
}

// 問題ごとの時間（Part B は問題の種類で変わる）
function timingOf(item, data) {
  if (item.part === "B") {
    return {
      preview: data.kind === "fig" && item.idx === 0 ? TIMING.B.preview : 0,
      prep: data.kind === "ask" ? TIMING.B.askPrep : 0,
      ans: TIMING.B.ans,
    };
  }
  return TIMING[item.part];
}

/* =========================================================
   画面: ホーム
   ========================================================= */
function setCardHtml(set) {
  return `
    <div class="card set-card ${set.group === "course" ? "course" : ""}">
      <div class="set-head">
        <div>
          <div class="set-title">${esc(set.title)}</div>
          <div class="set-sub">${esc(set.subtitle)}</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" data-act="start" data-set="${set.id}" data-mode="exam">🎯 本番モード<span class="btn-note">通し・確認なし</span></button>
        <button class="btn secondary" data-act="start" data-set="${set.id}" data-mode="practice">📘 練習モード<span class="btn-note">1問ずつ確認</span></button>
      </div>
      <div class="drill-row">
        <span class="drill-label">パート別練習：</span>
        ${["A", "B", "C", "D"].map((p) => `<button class="chip" style="--c:${PART_META[p].color}" data-act="drill" data-set="${set.id}" data-part="${p}">${p}｜${PART_META[p].name}</button>`).join("")}
      </div>
    </div>`;
}

function showHome() {
  bump();
  Timer.stop();
  TTS.stop();
  Rec.release();
  Dict.stop();
  session = null;
  document.body.classList.remove("in-session");

  const course = SETS.filter((s) => s.group === "course");
  const jishu = SETS.filter((s) => s.group !== "course");

  const histHtml = History.list.length
    ? History.list.slice(0, 5).map((h) => `
        <div class="hist-row">
          <span class="hist-date">${esc(h.date)}</span>
          <span>${esc(h.title)}（${h.mode === "exam" ? "本番" : "練習"}）</span>
          <span class="hist-tag">${h.auto ? "自動採点" : "自己評価"}</span>
          <span class="hist-grade g-${esc(h.grade)}">${esc(h.grade)}</span>
        </div>`).join("")
    : '<p class="muted">まだ記録がありません。1回やってみよう！</p>';

  $app().innerHTML = `
    <div class="hero">
      <div class="hero-badge">都立入試スピーキング対策</div>
      <h1>ESAT-J トレーナー</h1>
      <p class="hero-sub">令和8年度の形式で録音 → その場で<b>自動採点</b>。<br>本試験：<b>2026年11月22日（日）</b></p>
      <div class="btn-row hero-row">
        <button class="btn ghost" data-act="guide">📖 テストの仕組みと攻略法</button>
        <button class="btn ghost" data-act="settings">⚙️ 設定</button>
      </div>
      <button class="btn tiny ghost mic-test" data-act="mictest">🎤 動作チェック（マイク・文字起こし・採点）</button>
      <div id="mictest-result"></div>
    </div>

    <div class="card course-guide">
      <h2>📅 講座での使い方</h2>
      <table class="guide-table">
        ${COURSE_GUIDE.map((g) => `<tr><th>${esc(g.when)}</th><td>${esc(g.what)}</td></tr>`).join("")}
      </table>
    </div>

    <h2 class="group-head">講座セット<small>授業と宿題で使う問題</small></h2>
    ${course.length ? course.map(setCardHtml).join("") : '<div class="card"><p class="muted">講座セット1〜3は準備中です。</p></div>'}

    <h2 class="group-head">自主練セット<small>前日の通し模試・自分での練習用</small></h2>
    ${jishu.map(setCardHtml).join("")}

    <div class="card">
      <h2>学習のきろく</h2>
      ${histHtml}
      ${History.list.length ? '<button class="btn tiny ghost" data-act="clear-hist">記録を消す</button>' : ""}
    </div>
    <p class="foot-note">※ 本アプリはオリジナル練習教材です。実際のESAT-Jの問題・音声・採点とは異なります。最新の実施情報は<a href="${OFFICIAL_URL}" target="_blank" rel="noopener">東京都教育委員会の特設ページ</a>で確認してください。</p>
  `;

  $app().onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "guide") showGuide();
    if (act === "settings") showSettings();
    if (act === "clear-hist") askConfirm("学習のきろくをすべて消しますか？", () => { History.clear(); showHome(); });
    if (act === "start") startSession(btn.dataset.set, btn.dataset.mode, ["A", "B", "C", "D"]);
    if (act === "drill") startSession(btn.dataset.set, "practice", [btn.dataset.part]);
    if (act === "mictest") runMicTest(btn);
  };
}

/* ---------- マイク・自動採点の動作チェック ----------
   端末やブラウザによって使える機能が違うため、練習前に確かめられるようにする
   ------------------------------------------------- */
async function runMicTest(btn) {
  const box = document.getElementById("mictest-result");
  if (!box) return;
  btn.disabled = true;
  Beep.init();
  const line = (ok, label, note) => `<div class="test-row ${ok ? "yes" : "no"}"><span class="mk">${ok ? "◎" : "✕"}</span><span><b>${esc(label)}</b><small>${esc(note)}</small></span></div>`;
  const aiLine = AI.on() ? line(true, "Claude採点", "この端末で使えます（振り返り画面と最終画面にボタンが出ます）") : "";
  const ttsLine = line(TTS.available(), "質問の読み上げ", TTS.available() ? "使えます" : "英語の音声が見つかりません（質問は文字で出します）");
  const where = `<p class="env-where">開き方：<b>${IN_ARTIFACT ? "Claudeのアーティファクト" : "ふつうのWebブラウザ"}</b></p>`;

  if (IN_ARTIFACT) {
    // アーティファクトでは生のマイク（録音・ブラウザの音声認識）は使えない。文字起こしは dictation で試す
    const noAi = AI.on() ? "" : line(false, "Claude採点", "この閲覧者では使えません（塾のClaudeアカウントでログインした教室の端末で使えます）");
    if (!Dict.usable()) {
      box.innerHTML = `<div class="card test-card">${where}
        ${line(false, "録音", "この開き方では録音できません")}
        ${line(false, "文字起こし（音声入力）", "この閲覧者・ブラウザでは使えません")}
        ${line(false, "自動採点", "文字起こしが無いので、講師が英語を入力したときだけ採点します")}
        ${aiLine}${noAi}${ttsLine}
        <p class="muted small">タイマー・お手本・自己チェック・講師の入力欄で練習できます。</p></div>`;
      btn.disabled = false;
      return;
    }
    btn.disabled = true;
    Dict.buf = "";
    Dict.route = "answer";
    Dict.ensure(); // クリックの中で始める
    box.innerHTML = `<div class="card test-card"><p class="test-say">英語で話しかけてください<br><b>"Hello, my name is ○○."</b></p><p class="rec-note"><span class="rec-dot"></span> 音声入力で聞き取り中… 6秒</p></div>`;
    await new Promise((r) => setTimeout(r, 6000));
    await new Promise((r) => setTimeout(r, 1500));
    const heard = Dict.buf.trim();
    Dict.stop();
    Dict.buf = "";
    box.innerHTML = `<div class="card test-card">${where}
      ${line(false, "録音", "この開き方では録音できません（聞き直しはできません）")}
      ${line(!!heard, "文字起こし（音声入力）", heard ? "声を英語として文字にできました" : (Dict.usable() ? "文字になりませんでした（許可・マイク・声の大きさを確認）" : "この閲覧者では使えません"))}
      ${line(!!heard, "自動採点", heard ? "文字起こしで採点できます" : "講師が英語を入力したときだけ採点します")}
      ${aiLine}${noAi}${ttsLine}
      ${heard ? `<p class="transcript">📝 聞き取り結果：<br>"${esc(heard)}"</p>` : ""}
      <button class="btn tiny ghost" data-act="mictest">もう一度ためす</button></div>`;
    btn.disabled = false;
    return;
  }

  box.innerHTML = `<div class="card test-card"><p>マイクを準備しています…<br><small class="muted">「許可」を押してください</small></p></div>`;
  const micOK = await Rec.init();
  if (!micOK) {
    box.innerHTML = `<div class="card test-card">${where}
      ${line(false, "録音", Rec.supported ? "マイクが使えません。ブラウザのマイク許可を確認してください" : "このブラウザは録音に対応していません")}
      ${line(false, "自動採点", "マイクが使えないため採点もできません")}
      ${line(false, "Claude採点", "アーティファクトで開いたときだけ使えます")}${ttsLine}
      <p class="muted small">Chromeで開き直すと解決することが多いです。録音なしでもタイマー練習はできます。</p></div>`;
    btn.disabled = false;
    return;
  }

  if (!SR_CTOR || !Settings.data.srOn) {
    box.innerHTML = `<div class="card test-card">${where}
      ${line(true, "録音", "使えます")}
      ${line(false, "自動採点", SR_CTOR ? "設定でオフになっています" : "このブラウザは音声認識に未対応です（Chrome推奨）")}
      ${line(false, "Claude採点", "アーティファクトで開いたときだけ使えます")}${ttsLine}
      <p class="muted small">録音の聞き直しと解答例での自己チェックは使えます。</p></div>`;
    Rec.release();
    btn.disabled = false;
    return;
  }

  // 実際に声を拾えるか5秒だけ試す
  box.innerHTML = `<div class="card test-card"><p class="test-say">英語で話しかけてください<br><b>"Hello, my name is ○○."</b></p><p class="rec-note"><span class="rec-dot"></span> 聞き取り中… 5秒</p></div>`;
  SR.failed = false;
  Beep.start();
  SR.start();
  await new Promise((r) => setTimeout(r, 5000));
  SR.stop();
  await new Promise((r) => setTimeout(r, 600));
  Beep.end();
  const heard = SR.text.trim();
  Rec.release();

  box.innerHTML = `<div class="card test-card">${where}
    ${line(true, "録音", "使えます")}
    ${line(!!heard, "文字起こし・自動採点（ブラウザの音声認識）", heard ? "声を英語として聞き取れました" : (SR.failed ? "音声認識がブロックされました" : "声を拾えませんでした"))}
    ${line(false, "Claude採点", "アーティファクトで開いたときだけ使えます")}${ttsLine}
    ${heard ? `<p class="transcript">📝 聞き取り結果：<br>"${esc(heard)}"</p>` : '<p class="muted small">マイクに近づく／静かな場所で／英語で話す、を試してください。それでもダメなら録音だけで練習できます。</p>'}
    <button class="btn tiny ghost" data-act="mictest">もう一度ためす</button></div>`;
  btn.disabled = false;
}

/* =========================================================
   画面: 攻略ガイド
   ========================================================= */
function tplHtml(list) {
  return list.map((t) => `<div class="tpl-row"><span class="tpl-en">${esc(t.en)}</span><span class="tpl-jp">${esc(t.jp)}</span></div>`).join("");
}

function showGuide() {
  bump();
  const partCards = ["A", "B", "C", "D"].map((p) => {
    const m = PART_META[p];
    return `
      <div class="card part-card" style="--c:${m.color}">
        <div class="part-tag">${esc(m.label)}</div>
        <div class="part-flow">${esc(m.flow)}｜${esc(m.count)}</div>
        <p>${esc(m.desc)}</p>
        <ul class="tips">${m.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>`;
  }).join("");

  $app().innerHTML = `
    <div class="page-head">
      <button class="btn tiny ghost" data-act="home">← もどる</button>
      <h1>テストの仕組みと攻略法</h1>
    </div>

    <div class="card">
      <h2>ESAT-J（YEAR 3）とは</h2>
      <p>都内の中学3年生が11月に受けるスピーキングテスト。タブレットとヘッドセットを使い、音声を録音する形式です（メモは取れません）。結果は <b>A〜Fの6段階</b>で評価され、<b>都立高校入試の調査書点に最大20点</b>加算されます。</p>
      <table class="score-table">
        <tr><th>評価</th><td>A</td><td>B</td><td>C</td><td>D</td><td>E</td><td>F</td></tr>
        <tr><th>入試加点</th><td>20</td><td>16</td><td>12</td><td>8</td><td>4</td><td>0</td></tr>
      </table>
      <p class="muted">令和7年度の結果は <b>A 47.2％・B 29.0％</b>（B以上が約8割）。Aを取りにいくテストです。採点の観点は「コミュニケーションの達成」「言語使用」「伝わる音声」の3つ。無言・英語でない・質問から外れた解答は点になりません。</p>
    </div>

    <div class="card">
      <h2>出題構成（令和8年度・9問）</h2>
      <table class="fmt-table">
        <tr><th></th><th>内容</th><th>問題数</th><th>準備</th><th>解答</th></tr>
        <tr><td class="pt" style="color:${PART_META.A.color}">A</td><td>英文の音読</td><td>2問</td><td>各30秒</td><td>各30秒</td></tr>
        <tr><td class="pt" style="color:${PART_META.B.color}">B</td><td>イラストについて答える2問／自分について答える2問／自分から質問する1問（最初にイラストを10秒見る）</td><td>5問</td><td>No.1〜4なし<br>No.5のみ10秒</td><td>各15秒以内</td></tr>
        <tr><td class="pt" style="color:${PART_META.C.color}">C</td><td>4コマのストーリー（画面の書き出しから）</td><td>1問</td><td>30秒</td><td>40秒以内</td></tr>
        <tr><td class="pt" style="color:${PART_META.D.color}">D</td><td>先生の説明を聞き、テーマとヒント3つから意見</td><td>1問</td><td>60秒</td><td>40秒以内</td></tr>
      </table>
    </div>

    ${partCards}

    <div class="card d-template" style="--c:${PART_META.C.color}">
      <h2>Part C の型（重要な5つのポイント＋つなぎ語）</h2>
      ${tplHtml(C_TEMPLATE)}
    </div>

    <div class="card d-template" style="--c:${PART_META.D.color}">
      <h2>Part D の型（意見→理由→具体例→補足→まとめ）</h2>
      ${tplHtml(D_TEMPLATE)}
    </div>

    <p class="foot-note">※ 形式・採点基準は東京都教育委員会が公開している令和8年度のサンプル問題・採点基準にもとづいて要約しています。詳細は<a href="${OFFICIAL_URL}" target="_blank" rel="noopener">公式ページ</a>を参照。</p>
    <button class="btn primary wide" data-act="home">ホームにもどる</button>
  `;
  $app().onclick = (e) => {
    const btn = e.target.closest("button[data-act='home']");
    if (btn) showHome();
  };
  window.scrollTo(0, 0);
}

/* =========================================================
   画面: 設定
   ========================================================= */
function showSettings() {
  bump();
  const s = Settings.data;
  $app().innerHTML = `
    <div class="page-head">
      <button class="btn tiny ghost" data-act="home">← もどる</button>
      <h1>設定</h1>
    </div>
    <div class="card">
      <label class="setting-row">
        <span>Part Bの質問文を画面にも表示する<small>リスニングが苦手な生徒・音を出せない場所向け（本番は音声のみ）</small></span>
        <input type="checkbox" id="set-showtext" ${s.showText ? "checked" : ""}>
      </label>
      <label class="setting-row">
        <span>自動採点を使う<small>話した英語を聞き取って、その場で採点します${SR_CTOR ? "" : "（このブラウザでは利用不可）"}</small></span>
        <input type="checkbox" id="set-sr" ${s.srOn ? "checked" : ""} ${SR_CTOR ? "" : "disabled"}>
      </label>
      <label class="setting-row">
        <span>英語音声の速さ</span>
        <select id="set-rate">
          <option value="0.8" ${s.rate === 0.8 ? "selected" : ""}>ゆっくり</option>
          <option value="0.95" ${s.rate === 0.95 ? "selected" : ""}>ふつう（本番相当）</option>
          <option value="1.1" ${s.rate === 1.1 ? "selected" : ""}>はやい</option>
        </select>
      </label>
      <p class="muted">開き方：<b>${IN_ARTIFACT ? "Claudeのアーティファクト（録音・ブラウザの音声認識は使えません。文字起こしは音声入力🎙）" : "ふつうのWebブラウザ"}</b><br>
      音声の読み上げ：${TTS.available() ? "✅ 利用できます" : "⚠️ このブラウザでは英語音声が見つかりません（質問は文字で表示されます）"}<br>
      録音機能：${Rec.supported ? "✅ 利用できます（開始時にマイク許可が必要）" : IN_ARTIFACT ? "— この開き方では録音できません" : "⚠️ このブラウザでは録音できません（タイマー練習のみ）"}<br>
      文字起こし：${IN_ARTIFACT ? (Dict.usable() ? "✅ 音声入力（🎙）で文字にします" : "— この閲覧者では使えません（講師の手入力と自己チェック）") : (SR_CTOR ? "✅ ブラウザの音声認識（Chrome）" : "⚠️ このブラウザでは利用できません（Chrome推奨）")}<br>
      Claude採点：${AI.on() ? "✅ この端末で使えます（教室用）" : "— この画面では使えません（塾のClaudeアカウントでログインした教室の端末で使えます）"}</p>
      <p class="muted small">録音ファイルと採点結果は端末の中だけに保存されます。聞き取り自体はブラウザの音声認識機能を使うため、Chromeでは音声がGoogleの認識サービスで処理されます。Claude採点は、ボタンを押したときだけ問題文と文字起こし（録音そのものや名前は送りません）をClaudeに送ります。</p>
    </div>
    <button class="btn primary wide" data-act="home">保存してもどる</button>
  `;
  const save = () => {
    Settings.data.showText = document.getElementById("set-showtext").checked;
    Settings.data.srOn = document.getElementById("set-sr").checked;
    Settings.data.rate = parseFloat(document.getElementById("set-rate").value);
    Settings.save();
  };
  $app().onchange = save;
  $app().onclick = (e) => {
    const btn = e.target.closest("button[data-act='home']");
    if (btn) { save(); showHome(); }
  };
  window.scrollTo(0, 0);
}

/* =========================================================
   セッション進行
   ========================================================= */
async function startSession(setId, mode, parts) {
  const set = SETS.find((s) => s.id === setId);
  if (!set) return;
  Dict.ensure(); // アーティファクト：クリックの中で音声入力を始める（使えない閲覧者では何もしない）
  Beep.init();
  TTS.warm();
  SR.failed = false;

  const items = [];
  if (parts.includes("A")) set.A.forEach((_, i) => items.push({ part: "A", idx: i }));
  if (parts.includes("B")) set.B.questions.forEach((_, i) => items.push({ part: "B", idx: i }));
  if (parts.includes("C")) items.push({ part: "C", idx: 0 });
  if (parts.includes("D")) items.push({ part: "D", idx: 0 });

  session = { set, mode, parts: parts.slice(), items, cur: 0, answers: {}, micOK: null, aiAll: null };
  document.body.classList.add("in-session");

  const id = bump();
  $app().innerHTML = `<div class="card center-card"><p class="big-icon">🎤</p><p>マイクの準備をしています…<br><small class="muted">「マイクの使用を許可」を押してください</small></p></div>`;
  // アーティファクトでは生のマイクを要求しない（確認なしで拒否されるため）
  session.micOK = IN_ARTIFACT ? false : await Rec.init();
  if (!alive(id)) return;
  showPartIntro();
}

function sessionHeader() {
  const it = session.items[session.cur];
  const m = partOf(it);
  return `
    <div class="ses-head">
      <span class="ses-chip" style="--c:${m.color}">${it.part}｜${esc(m.name)}</span>
      <span class="ses-progress">問 ${session.cur + 1} / ${session.items.length}</span>
      <span class="ses-mode">${session.mode === "exam" ? "🎯 本番" : "📘 練習"}</span>
      <button class="btn tiny ghost" data-act="quit">中断</button>
    </div>`;
}

function bindQuit(el) {
  el.querySelectorAll("button[data-act='quit']").forEach((b) => {
    b.onclick = () => askConfirm("練習を中断してホームにもどりますか？（録音は消えます）", () => showHome());
  });
}

function timeBadgesHtml(part) {
  if (part === "B") {
    return `<span class="time-badge">イラスト 10秒</span><span class="time-badge">準備 No.5のみ10秒</span><span class="time-badge rec">解答 各15秒以内</span>`;
  }
  const t = TIMING[part];
  return `<span class="time-badge">準備 ${t.prep}秒</span><span class="time-badge rec">解答 ${t.ans}秒</span>`;
}

function showPartIntro() {
  bump();
  Timer.stop();
  TTS.stop();
  const it = session.items[session.cur];
  const m = partOf(it);
  const micNote = IN_ARTIFACT
    ? `<div class="env-note">${envNoteHtml()}</div>`
    : session.micOK === false
      ? `<div class="warn-banner">🎤 マイクが使えないため<b>録音なし（タイマーのみ）</b>で練習します。${Rec.supported ? "ブラウザのマイク許可を確認してください。" : ""}</div>`
      : "";

  $app().innerHTML = `
    ${sessionHeader()}
    ${micNote}
    <div class="card part-card intro" style="--c:${m.color}">
      <div class="part-tag big">${esc(m.label)}</div>
      <div class="part-flow">${esc(m.flow)}</div>
      <p>${esc(m.desc)}</p>
      ${session.mode === "practice" ? `<ul class="tips">${m.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="time-badges">${timeBadgesHtml(it.part)}</div>
    </div>
    <button class="btn primary wide" data-act="go">はじめる</button>
  `;
  bindQuit($app());
  $app().querySelector("button[data-act='go']").onclick = () => { Dict.ensure(); Beep.init(); TTS.warm(); showQuestion(); };
  window.scrollTo(0, 0);
}

/* ---------- 出題画面 ---------- */
function stimulusHtml(it, data) {
  const practice = session.mode === "practice";
  if (it.part === "A") {
    return `
      ${data.situation ? `<div class="situation">${esc(data.situation)}</div>` : ""}
      <div class="card passage"><p class="en-passage">${esc(data.text)}</p></div>`;
  }
  if (it.part === "B") {
    const B = session.set.B;
    const lead = data.lead ? `<div class="lead">${esc(data.lead)}</div>` : "";
    if (data.kind === "ask") {
      return `
        <div class="situation">${esc(B.scene)}</div>
        ${lead}
        <div class="card ask-box">
          <div class="ask-label">${esc(data.jp.replace(/「.*」/, "次のこと"))}</div>
          <div class="ask-prompt">「${esc(data.prompt)}」</div>
        </div>`;
    }
    const showText = Settings.data.showText || !TTS.available();
    return `
      <div class="situation">${esc(B.scene)}</div>
      ${lead}
      ${data.kind === "fig" ? `<div class="card fig-card"><div class="fig-caption">${esc(B.figure.caption)}</div>${B.figure.svg}</div>` : `<div class="card self-card">🗣️ 相手があなた自身について質問します（音声のみ）</div>`}
      <div class="q-audio-row">
        <button class="btn secondary" data-act="replay" id="btn-replay" disabled>🔊 質問をもう一度聞く</button>
      </div>
      <div class="q-text ${showText ? "" : "hidden"}" id="q-text">${esc(data.q)}</div>`;
  }
  if (it.part === "C") {
    const pic = data.strip
      ? `<div class="card strip-card">${data.strip}</div>`
      : `<div class="panels">${data.panels.map((p) => p.svg).join("")}</div>`;
    return `
      <div class="situation">${esc(data.scene)}</div>
      <div class="opener-box">この表現から話し始めよう：<span class="opener-en">${esc(data.opener)} …</span></div>
      ${pic}
      ${practice ? `
        <details class="hint-box"><summary>💡 型と5つのポイントを見る</summary>
          ${tplHtml(C_TEMPLATE)}
          <ol class="point-list">${data.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
        </details>` : ""}`;
  }
  // D
  return `
    <div class="situation">先生の英語の説明が2回流れます。${esc(D_INSTRUCTION)}</div>
    <div class="card theme-card">
      <div class="theme-label">Theme</div>
      <p class="theme-en">${esc(data.theme)}</p>
      ${practice ? `<p class="jp-inline">${esc(data.themeJp)}</p>` : ""}
      <ul class="hint-list">
        ${data.hints.map((h, i) => `<li><span class="hint-en">${esc(h)}</span>${practice ? ` <span class="jp-inline">${esc(data.hintsJp[i])}</span>` : ""}</li>`).join("")}
        <li class="own"><span class="hint-en">your own idea</span>${practice ? ' <span class="jp-inline">自分の考え</span>' : ""}</li>
      </ul>
    </div>
    ${practice ? `
      <details class="hint-box"><summary>💡 型を見る</summary>${tplHtml(D_TEMPLATE)}</details>
      <details class="hint-box"><summary>📜 先生の説明（英文）</summary><p class="en-model">${esc(data.narration)} <i>Listen again.</i> …</p></details>` : ""}`;
}

function timerBlock() {
  return `
    <div class="timer-block" id="timer-block">
      <div class="phase-label" id="phase-label">じゅんび</div>
      <div class="ring-wrap">
        <svg viewBox="0 0 120 120" class="ring">
          <circle cx="60" cy="60" r="52" class="ring-bg"/>
          <circle cx="60" cy="60" r="52" class="ring-fg" id="ring-fg"/>
        </svg>
        <div class="ring-num" id="ring-num">--</div>
      </div>
      <div class="rec-note" id="rec-note"></div>
      <div class="btn-row center">
        <button class="btn secondary hidden" id="btn-skip">準備を終えて解答へ →</button>
        <button class="btn danger hidden" id="btn-stop">✅ 解答を終える</button>
      </div>
    </div>`;
}

const RING_C = 2 * Math.PI * 52;

function setRing(remain, total, cls) {
  const num = document.getElementById("ring-num");
  const fg = document.getElementById("ring-fg");
  const block = document.getElementById("timer-block");
  if (!num || !fg || !block) return;
  num.textContent = remain;
  fg.style.strokeDashoffset = String(RING_C * (1 - remain / total));
  block.className = "timer-block " + cls;
}

function setPhase(label, cls) {
  const el = document.getElementById("phase-label");
  if (el) el.textContent = label;
  const block = document.getElementById("timer-block");
  if (block) block.className = "timer-block " + cls;
}

function showQuestion() {
  const id = bump();
  Timer.stop();
  TTS.stop();
  const it = session.items[session.cur];
  const data = itemData(it, session.set);
  const T = timingOf(it, data);

  $app().innerHTML = `
    ${sessionHeader()}
    <div class="q-label">${esc(itemLabel(it))}</div>
    ${stimulusHtml(it, data)}
    ${timerBlock()}
  `;
  bindQuit($app());
  window.scrollTo(0, 0);

  const btnSkip = document.getElementById("btn-skip");
  const btnStop = document.getElementById("btn-stop");

  const startAnswerPhase = () => {
    if (!alive(id)) return;
    btnSkip.classList.add("hidden");
    Beep.start();
    let recording = false;
    if (session.micOK) recording = Rec.start();
    SR.start();
    // アーティファクト：解答中に確定した文字だけを集める
    const useDict = IN_ARTIFACT && Dict.usable();
    if (useDict) { Dict.buf = ""; Dict.route = "answer"; }
    const t0 = performance.now();
    const note = document.getElementById("rec-note");
    if (note) {
      note.innerHTML = recording ? '<span class="rec-dot"></span> 録音中… マイクに向かって話そう'
        : useDict ? (Dict.listening() ? '<span class="rec-dot"></span> 🎙 文字にしています… 英語で話そう' : "🎙 音声入力が止まっています（声に出して話そう。次の「はじめる」「次へ」で再開）")
        : IN_ARTIFACT ? "この開き方では録音できません（声に出して話そう）" : "🎤 録音なし（声に出して話そう）";
    }
    setPhase("かいとう！", "answering");
    btnStop.classList.remove("hidden");

    const finish = async () => {
      if (!alive(id)) return;
      const fid = bump(); // これ以降このフローを唯一の正とする
      Timer.stop();
      btnStop.disabled = true;
      Beep.end();
      SR.stop();
      const secs = Math.min(T.ans, Math.round((performance.now() - t0) / 1000));
      const rec = await Rec.stop();
      // 文字起こしの遅れ分待つ（音声入力は確定まで少し長め）
      await new Promise((r) => setTimeout(r, useDict ? 1500 : 400));
      let transcript = SR.text.trim();
      if (useDict) {
        if (Dict.route === "answer") Dict.route = null;
        transcript = Dict.buf.trim();
        Dict.buf = "";
      }
      if (!alive(fid)) return;
      session.answers[data.id] = {
        url: rec ? rec.url : null,
        mime: rec ? rec.mime : null,
        transcript: transcript,
        secs: secs,
        score: scoreAnswer(it.part, { qid: data.id, setId: session.set.id, prev: prevAnswerText(it) }, data.text, transcript),
      };
      if (session.mode === "practice") showReviewOne();
      else nextItem();
    };

    btnStop.onclick = finish;
    Timer.run(T.ans, (r) => setRing(r, T.ans, "answering"), finish);
  };

  const startPrepPhase = (label, sec, next, skipLabel) => {
    if (!alive(id)) return;
    setPhase(label, "prep");
    btnSkip.textContent = skipLabel || "準備を終えて解答へ →";
    btnSkip.classList.remove("hidden");
    btnSkip.onclick = () => { if (alive(id)) { Timer.stop(); next(); } };
    Timer.run(sec, (r) => setRing(r, sec, "prep"), next);
  };

  // Part B No.1〜4: 質問の音声を聞く → すぐ解答
  const startListenPhaseB = () => {
    if (!alive(id)) return;
    btnSkip.classList.add("hidden");
    setPhase("質問を聞こう", "listening");
    const num = document.getElementById("ring-num");
    if (num) num.textContent = "🔊";
    const replayBtn = document.getElementById("btn-replay");
    if (TTS.available()) {
      TTS.speak(data.q, {
        onend: () => {
          if (!alive(id)) return;
          if (replayBtn) {
            replayBtn.disabled = false;
            let replays = 0;
            replayBtn.onclick = () => {
              if (session.mode === "exam" && replays >= 1) return;
              replays += 1;
              if (session.mode === "exam") replayBtn.disabled = true;
              TTS.speak(data.q, {});
            };
          }
          setTimeout(() => { if (alive(id)) startAnswerPhase(); }, 500);
        },
      });
    } else {
      const qt = document.getElementById("q-text");
      if (qt) qt.classList.remove("hidden");
      setTimeout(() => { if (alive(id)) startAnswerPhase(); }, 2500);
    }
  };

  if (it.part === "D") {
    // 先生の説明（2回）→ 準備 → 解答
    setPhase("先生の説明を聞こう（2回流れます）", "listening");
    const num = document.getElementById("ring-num");
    if (num) num.textContent = "🔊";
    const goPrep = () => { if (alive(id)) startPrepPhase("考えをまとめよう", T.prep, startAnswerPhase); };
    // 本番と同じく、同じ説明を2回（間に "Listen again."）
    if (TTS.available()) TTS.speak(data.narration + " Listen again. " + data.narration, { onend: goPrep });
    else setTimeout(goPrep, 1500);
  } else if (it.part === "B") {
    if (data.kind === "ask") startPrepPhase("質問を考えよう", T.prep, startAnswerPhase);
    else if (T.preview) startPrepPhase("イラストを見よう", T.preview, startListenPhaseB, "イラストを見終えた →");
    else startListenPhaseB();
  } else if (it.part === "A") {
    startPrepPhase("黙読しよう", T.prep, startAnswerPhase);
  } else {
    startPrepPhase("イラストを見て準備", T.prep, startAnswerPhase);
  }
}

/* ---------- 練習モード: 1問ごとの振り返り ---------- */
function levelsHtml(levels) {
  return (levels || []).map((m) => `
    <div class="stance-box">
      <div class="stance">${esc(m.label)}の解答例</div>
      <p class="en-model strong">${esc(m.text)}</p>
      <p class="jp-model">${esc(m.jp)}</p>
      <button class="btn tiny secondary" data-say="${esc(m.text)}">🔊 聞く</button>
    </div>`).join("");
}

function pointHtml(data) {
  return data.point ? `<p class="watch point">🎯 採点のポイント：${esc(data.point)}</p>` : "";
}

function modelHtml(it, data) {
  if (it.part === "A") {
    // guide：「/」区切る・「//」一呼吸・**太字**＝強く読む（講座セット）。chunked：「/」区切りだけ（自主練セット）
    const guide = data.guide
      ? esc(data.guide).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      : esc(data.chunked || data.text);
    return `
      <div class="model-box">
        <div class="model-title">${data.guide ? "読み方ガイド（/ 区切る・// 一呼吸・太字＝強く読む）" : "区切りの例（/で息つぎ）"}</div>
        <p class="en-model guide">${guide}</p>
        ${data.jp ? `<p class="jp-model">${esc(data.jp)}</p>` : ""}
        <p class="watch">⚠️ 読みにくい語：${esc(data.watch)}</p>
        ${pointHtml(data)}
        <button class="btn tiny secondary" data-say="${esc(data.text)}">🔊 お手本を聞く</button>
      </div>`;
  }
  if (it.part === "B") {
    const head = data.kind === "ask"
      ? `<p class="en-model">指示：${esc(data.jp)}</p>`
      : `<p class="en-model">Q: ${esc(data.q)}<br><span class="jp-inline">${esc(data.jp)}</span></p>`;
    return `
      <div class="model-box">
        <div class="model-title">${data.kind === "ask" ? "指示と解答例" : "質問と解答例"}</div>
        ${head}
        ${levelsHtml(data.levels)}
        ${data.short ? `<p class="watch">💡 ${esc(data.short)}</p>` : ""}
        ${pointHtml(data)}
      </div>`;
  }
  if (it.part === "C") {
    return `
      <div class="model-box">
        <div class="model-title">重要な5つのポイント</div>
        <ol class="point-list">${data.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
        ${levelsHtml(data.levels)}
        ${pointHtml(data)}
      </div>`;
  }
  return `
    <div class="model-box">
      <div class="model-title">テーマ</div>
      <p class="en-model">${esc(data.theme)}<br><span class="jp-inline">${esc(data.themeJp)}</span></p>
      ${levelsHtml(data.levels)}
      ${pointHtml(data)}
    </div>`;
}

/* ---------- 採点結果の表示 ---------- */
function scoreCardHtml(ans) {
  if (ans && ans.score) {
    const s = ans.score;
    const ok = s.items.filter((i) => i.ok).length;
    return `
      <div class="score-box lv-${s.grade}">
        <div class="score-head">
          <span class="score-grade g-${s.grade}">${s.grade}</span>
          <div class="score-meta">
            <div class="score-title">自動採点</div>
            <div class="score-sub">${ok} / ${s.items.length} 項目クリア（${s.percent}%）</div>
          </div>
        </div>
        <ul class="score-items">
          ${s.items.map((i) => `<li class="${i.ok ? "yes" : "no"}"><span class="mk">${i.ok ? "◎" : "△"}</span><span><b>${esc(i.label)}</b><small>${esc(i.detail)}</small></span></li>`).join("")}
        </ul>
        <p class="score-advice">💬 ${esc(s.advice)}</p>
      </div>`;
  }
  // 文字起こしが取れなかったとき
  const why = IN_ARTIFACT
    ? (Dict.usable()
      ? "声が文字になりませんでした（音声入力が止まっていた／小さな声 など）。"
      : "この開き方では録音・音声の文字起こしができません。")
    : !SR_CTOR
      ? "このブラウザは音声認識に対応していません（Chrome推奨）。"
      : !Settings.data.srOn
        ? "設定で自動採点をオフにしています。"
        : "声が拾えませんでした。マイクの許可と、静かな場所かどうかを確認してください。";
  return `<div class="score-box none"><b>自動採点できませんでした</b><small>${esc(why)}</small><small>下の欄に英語を入れて「✅ この英語で自動採点」を押すか、解答例と比べて自己チェックしましょう。</small></div>`;
}

function bindSayButtons(root) {
  if (!root) return;
  root.querySelectorAll("button[data-say]").forEach((b) => {
    if (!TTS.available()) { b.style.display = "none"; return; }
    b.onclick = () => TTS.speak(b.dataset.say, {});
  });
}

function showReviewOne() {
  bump();
  const it = session.items[session.cur];
  const data = itemData(it, session.set);
  const ans = session.answers[data.id] || {};
  const m = partOf(it);

  $app().innerHTML = `
    ${sessionHeader()}
    <div class="q-label">${esc(itemLabel(it))} の振り返り</div>
    <div class="card review-card" style="--c:${m.color}">
      <div class="model-title">あなたの解答</div>
      ${ans.url ? `<audio controls src="${ans.url}" class="player"></audio>` : `<p class="muted">（録音なし${IN_ARTIFACT ? "：この開き方では録音できません" : ""}）</p>`}
      ${ans.transcript ? `<p class="transcript">📝 聞き取った内容：<br>"${esc(ans.transcript)}"</p>` : ""}
      <div class="score-area" data-qid="${esc(data.id)}" data-self="1">${scoreCardHtml(ans)}${selfCheckHtml(it, data, ans)}</div>
      ${aiSlotHtml(data.id)}
      ${modelHtml(it, data)}
    </div>
    <div class="btn-row">
      <button class="btn secondary" data-act="retry">🔁 もう一度この問題</button>
      <button class="btn primary" data-act="next">次へ →</button>
    </div>
  `;
  bindQuit($app());
  bindSayButtons($app());
  bindSelfChecks($app());
  fillAnswerSlots();
  // 「次へ」「もう一度」はクリックなので、止まっていた音声入力をここで再開できる
  $app().querySelector("button[data-act='retry']").onclick = () => { Dict.ensure(); showQuestion(); };
  $app().querySelector("button[data-act='next']").onclick = () => { Dict.ensure(); TTS.stop(); nextItem(); };
  window.scrollTo(0, 0);
}

function nextItem() {
  const prevPart = session.items[session.cur].part;
  session.cur += 1;
  if (session.cur >= session.items.length) { showFinal(); return; }
  if (session.items[session.cur].part !== prevPart) showPartIntro();
  else showQuestion();
}

/* ---------- 最終画面（振り返り＆自己チェック） ---------- */
function extOf(mime) {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

// 講師がチェックシートに写す用の一覧表
function finalTableHtml() {
  if (!session) return "";
  const aiParts = (session.aiAll && session.aiAll.parts) || {};
  const anyAi = AI.on() || session.items.some((it) => (session.answers[itemData(it, session.set).id] || {}).ai);
  const cell = (s, ans, it) => {
    if (s) return `<span class="hist-grade g-${s.grade}">${s.grade}</span> <small class="pct">${s.percent}%</small>`;
    const n = selfChecksOf(it, itemData(it, session.set)).length;
    const k = ans && ans.self ? Object.values(ans.self).filter(Boolean).length : 0;
    return k ? `<small>自己✔ ${k}/${n}</small>` : '<span class="muted">—</span>';
  };
  const aiCell = (r) => (r ? `<span class="ai-level sm ${lvClass(r.level)}">${esc(r.level)}</span>` : '<span class="muted">—</span>');
  const rows = [];
  ["A", "B", "C", "D"].forEach((p) => {
    const its = session.items.filter((it) => it.part === p);
    if (!its.length) return;
    its.forEach((it) => {
      const ans = session.answers[itemData(it, session.set).id] || {};
      const n = ans.score && ans.score.words != null ? ans.score.words : (answerTextOf(ans) ? answerTextOf(ans).split(/\s+/).length : 0);
      rows.push(`<tr><td class="lbl">${esc(itemLabel(it).replace("Part ", ""))}</td><td>${cell(ans.score, ans, it)}</td>${anyAi ? `<td>${aiCell(ans.ai)}</td>` : ""}<td class="num">${ans.secs != null ? ans.secs + "秒" : "—"}</td><td class="num">${n}語</td></tr>`);
    });
    const ss = its.map((it) => (session.answers[itemData(it, session.set).id] || {}).score).filter(Boolean);
    const avg = ss.length ? Math.round(ss.reduce((s, x) => s + x.ratio, 0) / ss.length * 100) : null;
    rows.push(`<tr class="part-row" style="--c:${PART_META[p].color}"><td class="lbl">Part ${p} 全体</td><td>${avg != null ? avg + "%" : "—"}</td>${anyAi ? `<td>${aiParts[p] ? `<span class="ai-level sm ${lvClass(aiParts[p])}">${esc(aiParts[p])}</span>` : "—"}</td>` : ""}<td></td><td></td></tr>`);
  });
  return `
    <div class="card table-card">
      <h2>Part別の結果（チェックシート用）</h2>
      <table class="final-table">
        <tr><th>問題</th><th>自動採点</th>${anyAi ? "<th>Claude</th>" : ""}<th>時間</th><th>語数</th></tr>
        ${rows.join("")}
      </table>
      <p class="muted small">自動採点＝ブラウザ内の目安（A〜F。採点できなかった問題は自己チェックの数）。${anyAi ? "Claude＝令和8年度採点基準のレベル（目安）。" : ""}時間＝話していた秒数。</p>
    </div>`;
}

function renderFinalTable() {
  const box = document.getElementById("final-table");
  if (box) box.innerHTML = finalTableHtml();
}

function finalOverall() {
  return overallScore(session.items.map((it) => (session.answers[itemData(it, session.set).id] || {}).score));
}

function finalResultHtml() {
  const overall = finalOverall();
  // パートごとの達成率（自動採点できた問題だけで平均）
  const byPart = ["A", "B", "C", "D"].map((p) => {
    const ss = session.items.filter((it) => it.part === p)
      .map((it) => (session.answers[itemData(it, session.set).id] || {}).score).filter(Boolean);
    if (!ss.length) return null;
    const r = ss.reduce((s, x) => s + x.ratio, 0) / ss.length;
    return { part: p, ratio: r, percent: Math.round(r * 100), meta: PART_META[p] };
  }).filter(Boolean);
  if (overall) {
    return `
      <div class="card result-card lv-${overall.grade}">
        <div class="result-head">
          <div class="result-grade g-${overall.grade}">${overall.grade}</div>
          <div>
            <div class="result-title">自動採点の結果</div>
            <div class="result-sub">${overall.count}問の平均 ${overall.percent}％</div>
            <div class="result-pt">入試換算 <b>${overall.points}点</b> / 20点 の目安</div>
          </div>
        </div>
        ${byPart.length > 1 ? `<div class="bars">${byPart.map((b) => `
          <div class="bar-row">
            <span class="bar-label" style="color:${b.meta.color}">${b.part}｜${esc(b.meta.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${b.percent}%;background:${b.meta.color}"></span></span>
            <span class="bar-num">${b.percent}%</span>
          </div>`).join("")}</div>` : ""}
        <p class="muted small">※ 話した内容の文字起こしで判定した目安です。発音の良し悪しは判定していません。実際のESAT-Jの採点とは異なります。</p>
      </div>`;
  }
  return `
    <div class="card grade-card">
      <h2>振り返り</h2>
      <p class="muted">自動採点ができなかったので、${IN_ARTIFACT ? "" : "録音を聞き直し、"}解答例と比べて、できたことに ✔ を入れよう（講師が英語を入力して「✅ この英語で自動採点」を押してもOK）。</p>
      <div class="grade-line">自己チェック達成率 <b id="rate-num">0%</b> → 評価の目安 <span class="hist-grade big" id="grade-est">–</span></div>
    </div>`;
}

function renderFinalResult() {
  const box = document.getElementById("final-result");
  if (!box) return;
  box.innerHTML = finalResultHtml();
  updateFinalGrade();
}

// 自動採点が1問も無いときは、自己チェックの割合で評価の目安を出す
function updateFinalGrade() {
  if (!session || !document.getElementById("final-result")) return null;
  const overall = finalOverall();
  if (overall) return { rate: overall.ratio, grade: overall.grade, auto: true };
  const boxes = Array.from($app().querySelectorAll(".self-check"));
  const rate = boxes.length ? boxes.filter((b) => b.checked).length / boxes.length : 0;
  const g = GRADE_TABLE.find((x) => rate >= x.min) || GRADE_TABLE[GRADE_TABLE.length - 1];
  const num = document.getElementById("rate-num");
  const est = document.getElementById("grade-est");
  if (num) num.textContent = Math.round(rate * 100) + "%";
  if (est) { est.textContent = g.grade; est.className = "hist-grade big g-" + g.grade; }
  renderFinalTable();
  return { rate, grade: g.grade, auto: false };
}

function showFinal() {
  bump();
  Timer.stop();
  TTS.stop();
  Rec.release();
  Dict.stop(); // 練習が終わったら音声入力も止める

  const rows = session.items.map((it) => {
    const data = itemData(it, session.set);
    const ans = session.answers[data.id] || {};
    const m = partOf(it);
    return `
      <div class="card review-card" style="--c:${m.color}">
        <div class="q-head">
          <span class="q-label small">${esc(itemLabel(it))}</span>
          <span class="row-grade" data-qid="${esc(data.id)}">${ans.score ? `<span class="hist-grade g-${ans.score.grade}">${ans.score.grade}</span>` : ""}</span>
        </div>
        ${ans.url ? `
          <audio controls src="${ans.url}" class="player"></audio>
          <a class="dl-link" href="${ans.url}" download="ESATJ_${esc(session.set.title)}_${esc(itemLabel(it)).replace(/[\s.]/g, "")}.${extOf(ans.mime)}">⬇️ 録音を保存</a>` : '<p class="muted">（録音なし）</p>'}
        ${ans.transcript ? `<p class="transcript">📝 "${esc(ans.transcript)}"</p>` : ""}
        ${aiSlotHtml(data.id)}
        <details class="model-details"><summary>採点の内訳と解答例を見る</summary><div class="score-area" data-qid="${esc(data.id)}">${scoreCardHtml(ans)}</div>${modelHtml(it, data)}</details>
        <div class="self-area" data-qid="${esc(data.id)}">${selfCheckHtml(it, data, ans)}</div>
      </div>`;
  }).join("");

  $app().innerHTML = `
    <div class="ses-head">
      <span class="ses-chip" style="--c:#0f766e">おつかれさま！</span>
      <span class="ses-progress">${esc(session.set.title)}・${session.mode === "exam" ? "本番モード" : "練習モード"}</span>
    </div>
    <div id="final-result">${finalResultHtml()}</div>
    <div id="final-table">${finalTableHtml()}</div>
    <div class="ai-slot" data-ai="all"></div>
    ${rows}
    <div class="btn-row">
      <button class="btn primary wide" data-act="save">記録して終わる</button>
    </div>
    ${IN_ARTIFACT ? "" : '<p class="foot-note">⚠️ 録音はこの画面を閉じると消えます。残したい録音は「⬇️ 録音を保存」を押してください。</p>'}
  `;
  bindSayButtons($app());
  bindSelfChecks($app(), () => updateFinalGrade());
  fillAnswerSlots();
  updateFinalGrade();

  $app().querySelector("button[data-act='save']").onclick = () => {
    const r = updateFinalGrade() || { rate: 0, grade: "F", auto: false };
    const d = new Date();
    History.add({
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      title: session.set.title + (session.parts.length < 4 ? "（パート別）" : ""),
      mode: session.mode,
      rate: Math.round(r.rate * 100),
      grade: r.grade,
      auto: r.auto,
    });
    showHome();
  };
  window.scrollTo(0, 0);
}

/* ---------- 起動 ---------- */
if (!document.documentElement.lang) document.documentElement.lang = "ja"; // 日本語の折り返しを文節単位に
Settings.load();
History.load();
TTS.init();
showHome();
AI.init(); // Claude採点が使える端末なら、あとからボタンが出る
