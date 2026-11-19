/* =========================================================
   Web版（github.io）のClaude採点：中継サーバー（Cloudflare Worker・grader/）を呼ぶ
   - 中継の仕様：POST {code, pass, prompt, meta} → 200 {text, code}／エラーは {code}
     code＝生徒コード（先生が決める。例 S1）、pass＝その子の合言葉。meta＝記録用（セット・Part・問題id）。
     名前と録音は送らない。meta には名前・英文・録音を入れない（英文は採点依頼の prompt の中だけ）
   - Content-Type は text/plain（CORS のプレフライトを避ける）。本文は JSON 文字列
   - Claude版（アーティファクト）では使わない（app.js の AI.init が IN_ARTIFACT で分ける）
   - ブラウザに依存しない純粋な関数だけ。tests/relay.test.js で偽の fetch を入れて確かめる
   ========================================================= */

"use strict";

// 返答の文字からJSONを取り出す（```json で囲まれていても、前後に文があってもよい）
function extractJsonValue(text) {
  const t = String(text == null ? "" : text);
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw { code: "invalid_json", message: "no JSON object in reply", text: t };
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch (e) {
    throw { code: "invalid_json", message: "JSON.parse failed", text: t };
  }
}

// 中継のエラー → アプリのエラーコード（AI.handleError が文言にする）
const RELAY_CODES = ["bad_passcode", "daily_limit", "student_limit", "too_many_fails", "rate_limited", "prompt_too_large", "audio_too_large", "refused", "empty_completion"];
function relayErrorCode(status, body) {
  const c = body && typeof body.code === "string" ? body.code : "";
  if (RELAY_CODES.includes(c)) return c;
  if (status === 401) return "bad_passcode";
  if (status === 413) return "prompt_too_large";
  if (status === 429) return "rate_limited";
  if (status === 422) return "refused";
  return "upstream_error"; // 403・400・502・その他
}

/* ---------- ログイン（生徒コード＋その子の合言葉） ----------
   保存先は設定（data.gradeCode / data.gradePass）。画面には生徒の名前を出さない（コードだけ） */

// 生徒コードをそろえる：全角→半角・前後の空白を取る・大文字に（"ｓ１ " → "S1"）
function normCode(v) {
  let s = String(v == null ? "" : v);
  if (s.normalize) s = s.normalize("NFKC");
  return s.trim().toUpperCase();
}
function isLoggedIn(data) {
  return !!(data && data.gradeCode && data.gradePass);
}
// ログインを保存する。コードか合言葉が空なら保存せず false
function saveLogin(data, code, pass) {
  const c = normCode(code);
  const p = String(pass == null ? "" : pass).trim();
  if (!c || !p) return false;
  data.gradeCode = c;
  data.gradePass = p;
  return true;
}
// 「切り替え」・bad_passcode のとき：保存を消す
function clearLogin(data) {
  data.gradeCode = "";
  data.gradePass = "";
}
// 記録用の meta（名前・英文・録音は入れない）
function buildMeta(kind, setTitle, part, qid) {
  if (kind === "all") return { kind: "all", set: String(setTitle || "") };
  return { kind: "one", set: String(setTitle || ""), part: String(part || ""), qid: String(qid || "") };
}

// 中継に1回だけ送る（再試行しない）。auth＝{code, pass}。成功なら返答から取り出したJSON、失敗なら {code} で reject
async function relayJson(url, auth, prompt, meta, opts) {
  opts = opts || {};
  const f = opts.fetch || (typeof fetch === "function" ? fetch : null);
  if (!f) throw { code: "upstream_error", message: "fetch is not available" };
  if (opts.signal && opts.signal.aborted) throw { code: "cancelled" };
  let res;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        code: normCode(auth && auth.code),
        pass: String((auth && auth.pass) || ""),
        prompt: String(prompt || ""),
        meta: meta && typeof meta === "object" ? meta : {},
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e && e.name === "AbortError") || (opts.signal && opts.signal.aborted)) throw { code: "cancelled" };
    throw { code: "upstream_error", message: String(e && e.message ? e.message : e) };
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) throw { code: relayErrorCode(res.status, body), status: res.status };
  if (!body || typeof body.text !== "string") throw { code: "invalid_json", message: "no text in relay reply" };
  return extractJsonValue(body.text);
}

/* ---------- 文字起こし（中継の /stt・Whisper） ----------
   iPhone/Android では録音とブラウザの音声認識が同時にマイクを使えないため、
   Web版でログイン済みなら、録音をそのまま中継へ送って文字にしてもらう（録音は文字にしたあと中継に残らない） */
const STT_MAX_CHARS = 4000000; // 中継の上限（base64 の文字数）

function sttUrl(url) {
  return String(url || "").replace(/\/$/, "") + "/stt";
}

// 録音（Blob）→ base64。arrayBuffer が無い古いブラウザは FileReader で
async function blobToBase64(blob) {
  if (blob && typeof blob.arrayBuffer === "function") {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return btoa(bin);
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// 中継へ1回だけ送る（自動の送り直しなし）。成功なら文字（無音なら ""）、失敗なら {code} で reject
async function transcribe(o) {
  o = o || {};
  const f = o.fetch || (typeof fetch === "function" ? fetch : null);
  if (!f) throw { code: "upstream_error", message: "fetch is not available" };
  if (o.signal && o.signal.aborted) throw { code: "cancelled" };
  if (!o.blob) throw { code: "bad_request", message: "no audio" };
  let audio;
  try { audio = await blobToBase64(o.blob); } catch (e) { throw { code: "upstream_error", message: "could not read audio" }; }
  if (audio.length > STT_MAX_CHARS) throw { code: "audio_too_large" };
  let res;
  try {
    res = await f(sttUrl(o.url), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ code: normCode(o.code), pass: String(o.pass || ""), audio: audio, hint: String(o.hint || "").slice(0, 300) }),
      signal: o.signal,
    });
  } catch (e) {
    if ((e && e.name === "AbortError") || (o.signal && o.signal.aborted)) throw { code: "cancelled" };
    throw { code: "upstream_error", message: String(e && e.message ? e.message : e) };
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) throw { code: relayErrorCode(res.status, body), status: res.status };
  if (!body || typeof body.text !== "string") throw { code: "upstream_error", message: "no text in stt reply" };
  return body.text.trim();
}

// 音声認識への手がかり：その問題の文に出てくる固有名詞（Mr. Sato・Osaka など）。生徒の発音があいまいでも綴りが合いやすくなる
// （原文そのものは渡さない：読み飛ばした部分まで補われて、採点が甘くなるため）
function sttHint(texts) {
  const seen = []; const add = (w) => { if (w && seen.indexOf(w) < 0) seen.push(w); };
  (texts || []).forEach((t) => {
    const toks = String(t || "").split(/\s+/).filter(Boolean);
    toks.forEach((tok, i) => {
      const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "");
      if (/^(Mr|Ms|Mrs)\.$/.test(w)) { add(w); return; }
      const word = w.replace(/\.$/, "");
      if (!/^[A-Z][a-z]{2,}$/.test(word)) return;
      const prev = i > 0 ? toks[i - 1] : "";
      const sentenceStart = i === 0 || (/[.!?]["')]*$/.test(prev) && !/^(Mr|Ms|Mrs)\.$/.test(prev.replace(/^[^A-Za-z]+/, "")));
      if (!sentenceStart) add(word);
    });
  });
  return seen.join(", ").slice(0, 250);
}

// Whisper（中継の文字起こし）を使う条件：Web版（アーティファクトでない）・中継URLあり・ログイン済み・録音できる
function canUseWhisper(c) {
  c = c || {};
  return !c.inArtifact && !!String(c.url || "").trim() && !!c.loggedIn && !!c.recSupported;
}

// 文字起こしの待ち：まだ届いていない問題の数
function pendingStt(answers) {
  return Object.values(answers || {}).filter((a) => a && a.sttBusy).length;
}
// 各問の「🤖 Claudeに採点してもらう」：文字起こし中・採点中は押せない
function oneButtonDisabled(ans) {
  return !!(ans && (ans.sttBusy || ans.aiBusy));
}
// 「🤖 全問まとめて…」：全部の文字起こしが届くまで押せない
function allButtonState(answers, allBusy) {
  const n = pendingStt(answers);
  return { disabled: n > 0 || !!allBusy, pending: n, note: n > 0 ? "文字起こしが終わると押せます" : "" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { sttHint,
    extractJsonValue, relayErrorCode, relayJson, normCode, isLoggedIn, saveLogin, clearLogin, buildMeta,
    sttUrl, blobToBase64, transcribe, canUseWhisper, pendingStt, oneButtonDisabled, allButtonState, STT_MAX_CHARS,
  };
}
