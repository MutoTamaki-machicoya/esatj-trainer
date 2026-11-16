/* =========================================================
   ESAT-J トレーナー 自動採点エンジン
   - 音声認識で文字にした解答を、パートごとの観点で判定する
   - すべてブラウザ内で完結（外部送信なし・APIキー不要）
   - 発音の良し悪しは判定できない。「何を言えたか」を見る採点
   ========================================================= */

"use strict";

/* ---------- 表記ゆれの吸収 ---------- */

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty"];

// 音声認識は "1:00" "500" のように数字で返すことが多いので、英単語へ寄せて比較する
function canon(text) {
  let t = String(text || "").toLowerCase().replace(/[‘’]/g, "'");
  t = t.replace(/(\d{1,2}):(\d{2})/g, (m, h, mi) => (mi === "00" ? h : h + " " + mi));
  t = t.replace(/\ba\.?\s?m\.?\b/g, " am ").replace(/\bp\.?\s?m\.?\b/g, " pm ");
  t = t.replace(/[^a-z0-9'\s]/g, " ");
  t = t.replace(/\b(\d+)\b/g, (m, d) => {
    const n = parseInt(d, 10);
    if (n <= 20) return NUM_WORDS[n];
    if (n < 1000 && n % 100 === 0) return NUM_WORDS[n / 100] + " hundred";
    if (n === 1000) return "one thousand";
    return m;
  });
  return t.replace(/\s+/g, " ").trim();
}

function words(text) {
  const c = canon(text);
  return c ? c.split(" ") : [];
}

function hasPhrase(hay, phrase) {
  const p = canon(phrase);
  if (!p) return false;
  return (" " + hay + " ").indexOf(" " + p + " ") >= 0;
}

// グループ内のどれか1つが言えていればOK
function matchAny(hay, group) {
  return group.some((p) => hasPhrase(hay, p));
}

/* ---------- Part A用：どこまで読めたかの照合 ---------- */

// 最長共通部分列。読み飛ばし・言い直しがあっても「順番通りに読めた語」を数える
function lcsMatched(ref, said) {
  const n = ref.length, m = said.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = ref[i - 1] === said[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hit = new Array(n).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === said[j - 1]) { hit[i - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return hit;
}

/* ---------- 問題ごとの採点キー ----------
   B: keys（すべて必要。any のどれか1つでOK）/ past（過去形で答える問題）/ ask（No.5：質問の形）
      keys の pick ＝ No.1 の答え（dependsOn）で選んだものに合わせて need のどれかが必要。No.1 から分からなければ、どれか1つに合っていればOK
   C: opener（指定の書き出し）/ points（重要な5つのポイント。どれか1語でもその場面に触れていればOK）
   D: topic（テーマ・ヒントに沿っているか）
   キー名：B＝問題id、C＝セットid＋"C"、D＝セットid＋"D"
   ------------------------------------- */

const SUBJECTS = ["english", "math", "maths", "mathematics", "science", "music", "history", "japanese",
  "art", "p e", "pe", "physical education", "social studies", "home economics", "technology", "geography", "calligraphy"];
const ANIMALS = ["panda", "pandas", "lion", "lions", "elephant", "elephants", "monkey", "monkeys", "giraffe",
  "giraffes", "tiger", "tigers", "koala", "koalas", "penguin", "penguins", "bear", "bears", "zebra", "zebras", "animal", "animals"];
const HOBBIES = ["read", "reading", "play", "playing", "watch", "watching", "listen", "listening", "cook", "cooking",
  "draw", "drawing", "sing", "singing", "dance", "dancing", "swim", "swimming", "sleep", "sleeping", "game", "games",
  "music", "book", "books", "study", "studying", "walk", "walking", "run", "running", "shopping"];
const TRANSPORT = ["walk", "walking", "bike", "bicycle", "bus", "train", "car", "foot", "subway", "run", "ride"];

const SCORE_KEYS = {
  // ===== 自主練セット1 =====
  j1b1: { keys: [{ label: "開始時刻（1時）", any: ["one", "one o'clock", "thirteen"] }] },
  j1b2: { keys: [{ label: "値段（500円）", any: ["five hundred"] }] },
  j1b3: { keys: [{ label: "通学の方法", any: TRANSPORT }] },
  j1b4: { past: true, keys: [] },
  j1b5: { ask: true, keys: [{ label: "話題（音楽）", any: ["music", "song", "songs", "singer", "singers", "band", "bands"] }] },
  j1C: {
    opener: "last week",
    points: [
      { label: "公園でサッカーをしていた", any: ["soccer", "football", "park"] },
      { label: "ボールが木に引っかかって取れなかった", any: ["tree", "couldn't", "could not", "stuck", "went up", "up in"] },
      { label: "背の高い男の人が来た", any: ["man", "tall", "someone", "person"] },
      { label: "男の人がボールを取ってくれた", any: ["took", "got the ball", "get the ball", "gave", "helped", "picked"] },
      { label: "お礼を言って一緒にサッカーをした", any: ["thank", "thanks", "together", "played with"] },
    ],
  },
  j1D: { topic: ["weekend", "weekends", "sport", "sports", "book", "books", "reading", "read", "family", "play", "playing", "go out", "going out"] },

  // ===== 自主練セット2 =====
  j2b1: {
    keys: [
      { label: "曜日1（Tuesday）", any: ["tuesday", "tuesdays"] },
      { label: "曜日2（Friday）", any: ["friday", "fridays"] },
    ],
  },
  j2b2: { keys: [{ label: "終了時刻（6時）", any: ["six", "eighteen"] }] },
  j2b3: { keys: [{ label: "好きな教科", any: SUBJECTS }] },
  j2b4: { past: true, keys: [] },
  j2b5: { ask: true, keys: [{ label: "話題（テニスを始めた時期）", any: ["tennis"] }] },
  j2C: {
    opener: "last sunday",
    points: [
      { label: "母の誕生日のケーキを作っていた", any: ["cake", "birthday", "mother", "mom", "making"] },
      { label: "砂糖がないことに気づいた", any: ["sugar", "didn't have", "did not have", "no sugar", "there was no"] },
      { label: "お店に行った", any: ["store", "shop", "supermarket", "went"] },
      { label: "砂糖を買ってケーキを完成させた", any: ["bought", "buy", "finished", "made the cake", "made a cake"] },
      { label: "母がとても喜んだ", any: ["happy", "glad", "smiled", "delicious", "liked", "loved"] },
    ],
  },
  j2D: { topic: ["healthy", "health", "breakfast", "eat", "eating", "sleep", "sleeping", "walk", "walking", "exercise", "body", "bodies"] },

  // ===== 自主練セット3 =====
  j3b1: { keys: [{ label: "開始時刻（11時）", any: ["eleven"] }] },
  j3b2: { keys: [{ label: "見たい動物", any: ANIMALS }] },
  j3b3: { keys: [{ label: "好きなこと", any: HOBBIES }] },
  j3b4: { past: true, keys: [] },
  j3b5: { ask: true, keys: [{ label: "話題（好きな動物）", any: ANIMALS }] },
  j3C: {
    opener: "last saturday",
    points: [
      { label: "こんでいる電車に座っていた", any: ["train", "crowded", "sitting", "was on"] },
      { label: "おばあさんが乗ってきた", any: ["woman", "old", "lady", "grandmother", "got on"] },
      { label: "立ち上がって席をゆずった", any: ["seat", "stood up", "stand up", "sit down", "offered"] },
      { label: "おばあさんがお礼を言った", any: ["thank", "thanks", "thanked"] },
      { label: "一緒に話してうれしかった", any: ["happy", "glad", "talked", "talking", "enjoyed"] },
    ],
  },
  j3D: { topic: ["town", "city", "park", "parks", "clean", "cleaning", "old people", "help", "helping", "event", "events", "festival", "local", "people"] },

  // ===== 講座セット1（図：ワークショップのパンフレット）=====
  // No.1 はどれを選んでもよい。No.2 の理由は No.1 で選んだワークショップと合っていること（pick）
  c1b1: { keys: [{ label: "参加したいワークショップ", any: ["bread", "bread making", "bird", "birds", "bird watching", "t shirt", "shirt", "painting"] }] },
  c1b2: {
    dependsOn: "c1b1",
    keys: [{ label: "選んだワークショップに合う理由", pick: [
      { when: ["bread"], need: ["bread", "cook", "cooking", "make", "making", "eat", "eating", "kitchen", "apron", "food"] },
      { when: ["bird", "birds", "watching"], need: ["bird", "birds", "nature", "lake", "animal", "animals", "morning", "free", "watch", "watching"] },
      { when: ["t shirt", "shirt", "painting"], need: ["paint", "painting", "art", "t shirt", "shirt", "draw", "drawing", "design", "picture", "pictures"] },
    ] }],
  },
  c1b3: { keys: [{ label: "放課後にすること", any: HOBBIES.concat(["practice", "club", "homework", "soccer", "tennis", "baseball", "basketball", "piano", "cram school", "juku"]) }] },
  c1b4: { past: true, keys: [] },
  c1b5: { ask: true, keys: [
    { label: "場所（Where）", any: ["where", "place", "places"] },
    { label: "休みの日", any: ["weekend", "weekends", "holiday", "holidays", "day off", "days off", "free time", "sunday", "sundays", "saturday", "saturdays", "vacation", "free day", "free days"] },
  ] },
  c1C: {
    opener: "last week",
    points: [
      { label: "教室で文化祭のポスターをかいていた", any: ["poster", "painting", "drawing", "festival"] },
      { label: "友達が転んで水をこぼした", any: ["fell", "fell down", "dropped", "bucket", "spilled", "water"] },
      { label: "ポスターがぬれてしまった", any: ["wet", "got wet", "ruined", "broken"] },
      { label: "クラスメイトといっしょに新しいポスターをかいた", any: ["new poster", "together", "again", "another poster", "classmates"] },
      { label: "文化祭の日にポスターがはられ、みんな喜んだ", any: ["happy", "glad", "on the wall", "day of the festival", "everyone was", "liked"] },
    ],
  },
  c1D: { topic: ["friend", "friends", "school events", "event", "events", "video", "video calls", "call", "calls", "sport", "sports", "play", "talk", "country", "countries"] },

  // ===== 講座セット2（図：スポーツセンターのフロアガイド）=====
  c2b1: { keys: [{ label: "行きたい階・施設", any: ["floor", "first", "second", "third", "fourth", "climbing", "wall", "pool", "swimming", "swim", "badminton", "cafe", "café", "shop"] }] },
  c2b2: {
    dependsOn: "c2b1",
    // 閉まる時刻：4F 5:00 p.m.／3F 8:00 p.m.／2F・1F 9:00 p.m.
    keys: [{ label: "選んだ階の閉まる時刻", pick: [
      { when: ["fourth", "climbing", "wall"], need: ["five", "seventeen"] },
      { when: ["third", "swimming", "pool", "swim"], need: ["eight", "twenty"] },
      { when: ["second", "badminton"], need: ["nine", "twenty one"] },
      { when: ["first", "cafe", "café", "shop"], need: ["nine", "twenty one"] },
    ] }],
  },
  c2b3: { keys: [{ label: "季節", any: ["spring", "summer", "fall", "autumn", "winter"] }] },
  c2b4: { keys: [{ label: "通学の方法", any: TRANSPORT }] },
  c2b5: { ask: true, keys: [
    { label: "時間（What time / When）", any: ["what time", "when"] },
    { label: "夕食", any: ["dinner", "supper"] },
    { label: "家族と", any: ["family"] },
  ] },
  c2C: {
    opener: "last sunday",
    points: [
      { label: "家族と公園へピクニックに行った", any: ["picnic", "park"] },
      { label: "急に雨が降ってきた", any: ["rain", "rained", "raining", "rainy"] },
      { label: "屋根のある場所へ走って行った", any: ["roof", "ran", "run", "shelter", "went to a place"] },
      { label: "そこでお昼（サンドイッチ）を食べた", any: ["ate", "sandwich", "sandwiches", "lunch"] },
      { label: "雨がやんで虹が出て、みんな喜んだ", any: ["rainbow", "stopped"] },
    ],
  },
  c2D: { topic: ["trash", "garbage", "bag", "bags", "recycle", "recycling", "bottle", "bottles", "food", "eat", "eating", "reduce", "plastic"] },

  // ===== 講座セット3（図：町の地図とバスの時刻表）=====
  c3b1: { keys: [{ label: "行き先", any: ["flower", "garden", "tulip", "tulips", "fruit", "farm", "strawberry", "strawberries", "lake", "boat", "boats"] }] },
  c3b2: {
    dependsOn: "c3b1",
    // Flower Garden＝Bus 1／Fruit Farm＝Bus 2／Blue Lake＝Bus 3
    keys: [{ label: "行き先に合うバスの番号", pick: [
      { when: ["flower", "garden", "tulip", "tulips"], need: ["bus one", "number one", "first bus"] },
      { when: ["fruit", "farm", "strawberry", "strawberries"], need: ["bus two", "number two", "second bus"] },
      { when: ["lake", "boat", "boats"], need: ["bus three", "number three", "third bus"] },
    ] }],
  },
  c3b3: { keys: [{ label: "したいこと", any: ["want to", "go", "visit", "play", "ski", "skiing", "see", "study", "watch", "read", "travel", "eat", "make", "enjoy", "sleep", "snowboarding"] }] },
  c3b4: { past: true, keys: [{ label: "起きた時刻", any: ["four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "o'clock"] }] },
  c3b5: { ask: true, keys: [
    { label: "いちばん楽しかったこと", any: ["fun", "enjoy", "enjoyed", "favorite", "best", "most", "interesting", "like", "liked", "exciting"] },
    { label: "日本で", any: ["japan"] },
  ] },
  c3C: {
    opener: "yesterday",
    points: [
      { label: "学校から歩いて帰っていた", any: ["walking", "walked", "school", "way home"] },
      { label: "木の下の箱の中に小さなネコを見つけた", any: ["cat", "kitten", "box"] },
      { label: "ネコを家に連れて帰った", any: ["took", "brought", "carried", "took it home"] },
      { label: "ネコにミルクをあげた", any: ["milk"] },
      { label: "家族でネコを飼うことになり、みんな喜んだ", any: ["keep", "decided", "happy", "glad", "pet"] },
    ],
  },
  c3D: { topic: ["spring", "summer", "fall", "autumn", "winter", "season", "trip", "school trip"] },
};

/* ---------- 評価 ---------- */

const PAST_VERBS = ["was", "were", "went", "came", "took", "said", "got", "made", "found",
  "bought", "gave", "stood", "felt", "had", "did", "saw", "ate", "ran", "put", "told",
  "couldn't", "could not", "began", "brought", "left", "met", "read", "sat", "spoke", "thought",
  "kicked", "won", "lost", "wrote", "drank", "slept", "swam", "sang", "rode", "caught", "taught", "fell", "forgot"];

function hasPastTense(hay) {
  if (PAST_VERBS.some((v) => hasPhrase(hay, v))) return true;
  return /\b[a-z]{4,}ed\b/.test(hay);
}

// Part B No.5：質問の形
const ASK_FORMS = ["what", "where", "when", "which", "who", "why", "how", "do you", "did you", "are you",
  "is there", "are there", "can you", "could you", "will you", "have you", "would you", "is it", "is your"];

// Part C：出来事をつなぐ表現
const CONNECTORS = ["then", "so", "after that", "but", "when", "because", "finally", "later", "first", "and then", "suddenly"];

const GRADES = [
  { min: 0.9, grade: "A" }, { min: 0.75, grade: "B" }, { min: 0.6, grade: "C" },
  { min: 0.45, grade: "D" }, { min: 0.25, grade: "E" }, { min: 0, grade: "F" },
];

function gradeOf(ratio) {
  return (GRADES.find((g) => ratio >= g.min) || GRADES[GRADES.length - 1]).grade;
}

function pack(ratio, items, advice, extra) {
  const r = Math.max(0, Math.min(1, ratio));
  return Object.assign({
    ratio: r,
    percent: Math.round(r * 100),
    grade: gradeOf(r),
    items: items,
    advice: advice,
  }, extra || {});
}

/* ---------- パート別の採点 ---------- */

function scoreA(passage, said) {
  const ref = words(passage);
  const hit = lcsMatched(ref, words(said));
  const read = hit.filter(Boolean).length;
  const ratio = ref.length ? read / ref.length : 0;
  const missed = ref.filter((w, i) => !hit[i] && w.length > 2).slice(0, 8);

  const items = [
    { ok: ratio >= 0.8, label: "英文をひと通り読めた", detail: `${ref.length}語のうち ${read}語 を読めています` },
    { ok: ratio >= 0.6, label: "止まらずに読み進められた", detail: ratio >= 0.6 ? "大きな飛ばしはありません" : "途中で止まった／飛ばした部分がありそうです" },
  ];
  if (missed.length) {
    items.push({ ok: false, label: "読めていない可能性がある語", detail: missed.join(" / ") });
  }

  let advice = "この調子です。次は区切りと強く読む語を意識してみましょう。";
  if (ratio < 0.5) advice = "まずは1文ずつ、ゆっくりでいいので最後まで読み切る練習をしましょう。評価に十分な量を読むことが最優先です。";
  else if (ratio < 0.8) advice = "読めています。読めなかった語を確認して、もう一度チャレンジしてみましょう。";

  return pack(ratio, items, advice, { read: read, total: ref.length, missed: missed });
}

// prev ＝ 同じ場面の No.1 の解答（No.2 が No.1 の選択と合っているかを見る）
function scoreB(qid, said, prev) {
  const key = SCORE_KEYS[qid];
  if (!key) return null;
  const hay = canon(said);
  const n = words(said).length;
  const prevHay = canon(prev || "");

  const items = (key.keys || []).map((k) => {
    let any = k.any || [];
    let chosen = null;
    if (k.pick) {
      const hits = prevHay ? k.pick.filter((p) => matchAny(prevHay, p.when)) : [];
      chosen = hits.length === 1 ? hits[0] : null;
      any = chosen ? chosen.need : k.pick.reduce((a, p) => a.concat(p.need), []);
    }
    const ok = matchAny(hay, any);
    return {
      ok: ok,
      label: k.label + (key.ask ? "に触れた" : "を答えられた"),
      detail: ok ? (key.ask ? "たずねる中身が合っています" : (chosen ? "No.1 で選んだものと合っています" : "聞かれた情報が言えています"))
        : (chosen ? "No.1 で選んだものと合っていないか、聞き取れませんでした（図をもう一度確認）" : "この情報が聞き取れませんでした"),
    };
  });
  if (key.past) {
    const ok = n > 0 && hasPastTense(hay);
    items.push({ ok: ok, label: "過去形で答えられた", detail: ok ? "did の質問に過去形で答えています" : "did で聞かれたら過去形（went / played など）で答えましょう" });
  }

  // 聞かれた情報が言えていれば合格。文の形はそこからの上積み
  const content = n === 0 ? 0 : (items.length ? items.filter((i) => i.ok).length / items.length : 1);
  let ratio;
  if (key.ask) {
    const ok = matchAny(hay, ASK_FORMS);
    items.push({
      ok: ok,
      label: "質問の形で言えた",
      detail: ok ? "What / When / Do you などで質問できています" : "What 〜? / When 〜? / Do you 〜? の形で質問しましょう",
    });
    ratio = content === 1 ? (ok ? 1 : 0.75) : content * 0.7;
  } else {
    const ok = n >= 3;
    items.push({
      ok: ok,
      label: "文の形で答えられた",
      detail: ok ? "単語だけでなく文で答えられています" : "単語でも答えにはなりますが、文で言えると上の段に届きます",
    });
    ratio = content === 1 ? (ok ? 1 : 0.9) : content * 0.9;
  }

  let advice = "よく答えられています。もう1つ情報を足せるとさらに良くなります。";
  if (n === 0) advice = "5問すべてに答えることが最上位の条件です。単語1語でもいいので必ず声に出しましょう。";
  else if (ratio < 0.6) advice = key.ask ? "画面の日本語の内容を、What / When / Do you … ? の質問にしてみましょう。" : "質問の最初の語（What time / How much / Where など）を聞き取り、解答例と見比べましょう。";

  return pack(ratio, items, advice, { words: n });
}

function scoreC(setId, said) {
  const key = SCORE_KEYS[setId + "C"];
  if (!key) return null;
  const hay = canon(said);
  const w = words(said);
  const n = w.length;

  const pts = key.points.map((p) => {
    const ok = matchAny(hay, p.any);
    return { ok: ok, label: "ポイント：" + p.label, detail: ok ? "話せています" : "このポイントに触れられていません" };
  });
  const told = pts.filter((p) => p.ok).length;

  const opener = !!key.opener && hasPhrase(w.slice(0, 6).join(" "), key.opener);
  const usedConn = CONNECTORS.filter((c) => hasPhrase(hay, c));
  const connect = usedConn.length >= 2;
  const past = n > 0 && hasPastTense(hay);
  const enough = n >= 30;

  const items = pts.concat([
    { ok: opener, label: "画面の書き出しから始めた", detail: opener ? "指定の表現から話し始めています" : `最初に「${key.opener}」と言ってから話しましょう` },
    { ok: connect, label: "つなぎ語で順序立てた", detail: usedConn.length ? `使えた語：${usedConn.join(" / ")}（2種類以上が目安）` : "Then / So / After that / but でつなぎましょう" },
    { ok: past, label: "過去形で話せた", detail: past ? "was / went などが使えています" : "起きたことなので過去形（was 〜ing, went など）で話しましょう" },
    { ok: enough, label: "40秒を使って話せた", detail: `${n}語 話せています（目安30語以上）` },
  ]);

  const ratio = (told / 5) * 0.6 + (connect ? 0.15 : 0) + (past ? 0.1 : 0) + (enough ? 0.1 : 0) + (opener ? 0.05 : 0);
  let advice = "5つのポイントとつなぎ語がそろっています。最後に気持ちを1文足すと完成です。";
  if (n === 0) advice = "まず画面の書き出しから、1コマ1文でいいので声に出してみましょう。";
  else if (told < 4) advice = "触れていないポイントがあります。5つのポイントを指で数えながら話しましょう。";
  else if (!connect) advice = "内容は言えています。Then / So / After that でつなぐと上の段に届きます。";
  else if (!past) advice = "内容は言えています。あとは過去形にそろえると得点が伸びます。";

  return pack(ratio, items, advice, { words: n, told: told });
}

function scoreD(setId, said) {
  const key = SCORE_KEYS[setId + "D"];
  const hay = canon(said);
  const n = words(said).length;

  const opinion = matchAny(hay, ["i think", "i don't think", "i do not think", "in my opinion", "i believe", "i agree", "i disagree", "is the best", "is a good"]);
  const reason = matchAny(hay, ["first", "because", "one reason", "the reason", "the first reason", "if we", "without"]);
  const example = matchAny(hay, ["for example", "for instance", "such as"]);
  const more = matchAny(hay, ["also", "second", "secondly", "another reason", "in addition", "besides", "after that", "after the game", "if we", "when we"]);
  // まとめ：決まった言い方か、最後の文が So / That's why などで始まっている
  const tail = words(said).slice(-14).join(" ");
  const closing = matchAny(hay, ["so i think", "that's why", "therefore", "this is why", "so in my opinion", "so we should", "so students should", "so i believe"])
    || matchAny(tail, ["so", "that's why", "this is an easy way", "this is a good way", "that is why"]);
  const onTopic = n > 0 && (key ? matchAny(hay, key.topic) : true);
  const enough = n >= 30;

  const items = [
    { ok: opinion, label: "① 意見をはっきり言えた", detail: opinion ? "I think 〜 が言えています" : "まず I think 〜. で意見を宣言しましょう" },
    { ok: onTopic, label: "テーマ・ヒントに沿っていた", detail: onTopic ? "テーマに沿って話せています" : "テーマから外れているかもしれません" },
    { ok: reason, label: "② 理由を言えた", detail: reason ? "First / Because が使えています" : "First, 〜. か Because 〜. で理由を言いましょう" },
    { ok: example, label: "③ 具体例を言えた", detail: example ? "For example が使えています" : "For example, 〜. で自分の体験を1つ" },
    { ok: more, label: "④ 補足を足せた", detail: more ? "Also / Second で説明を足せています" : "Also, 〜. でもう1つ足すと最上位に近づきます" },
    { ok: closing, label: "⑤ まとめられた", detail: closing ? "So, I think 〜 で締められています" : "最後に So, I think 〜. をもう一度" },
    { ok: enough, label: "40秒を使って話せた", detail: `${n}語 話せています（目安30語以上）` },
  ];

  const score = (opinion ? 0.2 : 0) + (onTopic ? 0.1 : 0) + (reason ? 0.2 : 0) + (example ? 0.15 : 0)
    + (more ? 0.1 : 0) + (closing ? 0.1 : 0) + (enough ? 0.15 : 0);

  let advice = "型どおりに話せています。この形を本番でも使いましょう。";
  if (n === 0) advice = "型を見ながらで大丈夫です。まず I think 〜. だけでも声に出しましょう。";
  else if (!opinion) advice = "内容より先に「I think 〜.」で意見を宣言するのが最優先です。";
  else if (!reason || !example) advice = "意見のあとに First, 〜. For example, 〜. を続ける型を体にしみこませましょう。";
  else if (!more || !closing) advice = "あと一歩。Also, 〜. で補足し、So, I think 〜. で締めましょう。";

  return pack(score, items, advice, { words: n });
}

/* ---------- 外から呼ぶ入口 ---------- */

// transcript が空（音声認識が使えない等）なら null を返す＝採点しない
function scoreAnswer(part, ids, refText, transcript) {
  if (!transcript || !transcript.trim()) return null;
  try {
    if (part === "A") return scoreA(refText, transcript);
    if (part === "B") return scoreB(ids.qid, transcript, ids.prev);
    if (part === "C") return scoreC(ids.setId, transcript);
    if (part === "D") return scoreD(ids.setId, transcript);
  } catch (e) {
    return null;
  }
  return null;
}

// セッション全体の総合評価。ESAT-Jは4点刻みで最大20点
function overallScore(list) {
  const scored = list.filter(Boolean);
  if (!scored.length) return null;
  const avg = scored.reduce((s, x) => s + x.ratio, 0) / scored.length;
  const grade = gradeOf(avg);
  const points = { A: 20, B: 16, C: 12, D: 8, E: 4, F: 0 }[grade];
  return { ratio: avg, percent: Math.round(avg * 100), grade: grade, points: points, count: scored.length };
}
