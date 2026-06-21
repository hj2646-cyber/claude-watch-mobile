"use strict";

const $ = (id) => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

// ── state ──
let token = localStorage.getItem("cw_token") || null;
let lastEventId = null;
let reconnectDelay = 1000;
const folders = new Map();      // cwd -> {cwd, folderName, sessionId, title, lastMessage, lastRole, mtime}
let currentCwd = null;
let currentSessionId = null;
const permissionEls = new Map();
const recentSent = [];          // {text, t} for echo dedupe
let audioCtx = null;

// ── audio cue ──
function unlockAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* */ } }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq = 880, dur = 0.15) {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur);
  } catch { /* */ }
}
function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* */ } }

// ── api (same-origin relative URLs) ──
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (token) headers["Authorization"] = "Bearer " + token;
  if (opts.body) headers["Content-Type"] = "application/json";
  return fetch(path, Object.assign({}, opts, { headers }));
}

// ── screens ──
function show(name) {
  $("connect-screen").classList.toggle("hidden", name !== "connect");
  $("list-screen").classList.toggle("hidden", name !== "list");
  $("chat-screen").classList.toggle("hidden", name !== "chat");
}

// ── pairing ──
async function pair() {
  unlockAudio();
  const code = $("code-input").value.trim();
  if (!/^\d{6}$/.test(code)) { $("connect-error").textContent = "6자리 숫자를 입력하세요."; return; }
  $("connect-error").textContent = ""; $("pair-btn").disabled = true;
  try {
    const res = await fetch("/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) { $("connect-error").textContent = data.error || "페어링에 실패했습니다."; return; }
    token = data.token; localStorage.setItem("cw_token", token);
    show("list"); loadFolders(); connect();
  } catch { $("connect-error").textContent = "서버에 연결할 수 없습니다."; }
  finally { $("pair-btn").disabled = false; }
}

// ── folder list ──
async function loadFolders() {
  try {
    const res = await api("/folders");
    if (res.status === 401) { token = null; localStorage.removeItem("cw_token"); show("connect"); return; }
    if (!res.ok) return;
    const j = await res.json();
    for (const f of (j.folders || [])) {
      const prev = folders.get(f.cwd) || {};
      folders.set(f.cwd, Object.assign(prev, f));
    }
    renderFolders();
  } catch { /* */ }
}
function renderFolders() {
  const host = $("folder-list"); host.innerHTML = "";
  const arr = [...folders.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  if (!arr.length) { host.appendChild(el("div", "empty", "아직 대화가 없어요.\nPC에서 Claude Code를 실행하면 여기에 폴더가 나타납니다.")); return; }
  for (const f of arr) host.appendChild(folderItem(f));
}
function folderItem(f) {
  const d = el("div", "folder");
  const name = el("div", "fname"); name.appendChild(el("span", null, "📁")); name.appendChild(el("span", null, f.folderName || "(폴더)"));
  d.appendChild(name);
  if (f.title) d.appendChild(el("div", "ftitle", f.title));
  const last = el("div", "flast");
  if (f.lastMessage) {
    const who = f.lastRole === "user" ? "나: " : (f.lastRole === "assistant" ? "Claude: " : "");
    if (who) last.appendChild(el("b", null, who));
    last.appendChild(document.createTextNode((f.lastMessage || "").replace(/\n/g, " ").slice(0, 90)));
  } else last.textContent = "…";
  d.appendChild(last);
  d.onclick = () => openFolder(f.cwd);
  return d;
}

// ── chat view ──
async function openFolder(cwd) {
  unlockAudio();
  const f = folders.get(cwd); if (!f) return;
  currentCwd = cwd; currentSessionId = f.sessionId;
  $("chat-title").textContent = f.title || f.folderName;
  $("chat-sub").textContent = f.folderName;
  $("chat-log").innerHTML = ""; $("chat-status").textContent = "불러오는 중…";
  show("chat");
  await loadHistory();
}
async function loadHistory() {
  if (!currentSessionId) { $("chat-status").textContent = ""; return; }
  try {
    const res = await api(`/history?sessionId=${encodeURIComponent(currentSessionId)}&limit=140`);
    if (!res.ok) { $("chat-status").textContent = ""; return; }
    const j = await res.json();
    $("chat-log").innerHTML = "";
    for (const m of (j.messages || [])) appendMsg(m.role, m.text, true);
    $("chat-status").textContent = "";
    scrollChat(true);
  } catch { $("chat-status").textContent = ""; }
}
function appendMsg(role, text, bulk) {
  const log = $("chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  const cls = role === "user" ? "user" : role === "tool" ? "tool" : "assistant";
  const row = el("div", "msg " + cls);
  row.appendChild(el("div", "bubble", role === "tool" ? "🔧 " + text : text));
  log.appendChild(row);
  while (log.children.length > 600) log.removeChild(log.firstChild);
  if (!bulk && atBottom) log.scrollTop = log.scrollHeight;
}
function scrollChat(force) { const log = $("chat-log"); if (force) log.scrollTop = log.scrollHeight; }

function consumeRecentSent(text) {
  const now = Date.now(), t = (text || "").trim();
  for (let i = recentSent.length - 1; i >= 0; i--) {
    if (now - recentSent[i].t > 30000) { recentSent.splice(i, 1); continue; }
    if (recentSent[i].text === t) { recentSent.splice(i, 1); return true; }
  }
  return false;
}

async function sendCommand() {
  const input = $("cmd-input"); const text = input.value;
  if (!text.trim() || !currentCwd) return;
  input.value = "";
  appendMsg("user", text); scrollChat(true);
  recentSent.push({ text: text.trim(), t: Date.now() });
  try {
    const res = await api("/command", { method: "POST", body: JSON.stringify({ command: text + "\r", cwd: currentCwd, sessionId: currentSessionId }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); appendMsg("tool", "⚠️ 전송 실패: " + (e.error || res.status)); }
    else $("chat-status").textContent = "전송됨 · 응답 대기…";
  } catch { appendMsg("tool", "⚠️ 전송 실패"); }
}

// ── SSE ──
async function connect() {
  if (!token) return;
  setStatus("connecting");
  let res;
  try {
    const headers = { Authorization: "Bearer " + token };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    res = await fetch("/events", { headers });
  } catch { return scheduleReconnect(); }
  if (res.status === 401) { token = null; localStorage.removeItem("cw_token"); setStatus("offline"); show("connect"); return; }
  if (!res.ok || !res.body) return scheduleReconnect();
  setStatus("online"); reconnectDelay = 1000;
  loadFolders();
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) { dispatchFrame(buf.slice(0, idx)); buf = buf.slice(idx + 2); }
    }
  } catch { /* */ }
  scheduleReconnect();
}
function scheduleReconnect() { setStatus("offline"); setTimeout(() => { if (token) connect(); }, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 15000); }
function dispatchFrame(frame) {
  let event = "message", dataStr = "", id = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).replace(/^ /, "");
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (id) lastEventId = id;
  if (!dataStr) return;
  let d; try { d = JSON.parse(dataStr); } catch { d = { raw: dataStr }; }
  handleEvent(event, d);
}
function handleEvent(event, d) {
  switch (event) {
    case "chat": {
      const cwd = d.cwd; if (!cwd) break;
      let f = folders.get(cwd);
      if (!f) { f = { cwd, folderName: d.folderName || cwd.split(/[\\/]/).pop(), sessionId: d.sessionId, title: null, lastMessage: null, lastRole: null, mtime: 0 }; folders.set(cwd, f); }
      if (d.sessionId) f.sessionId = d.sessionId;
      if (d.role !== "tool") { f.lastMessage = d.text; f.lastRole = d.role; }
      f.mtime = Date.now();
      if (!$("list-screen").classList.contains("hidden")) renderFolders();
      if (!$("chat-screen").classList.contains("hidden") && cwd === currentCwd) {
        if (d.role === "user" && consumeRecentSent(d.text)) break;
        appendMsg(d.role, d.text);
        if (d.role === "assistant") $("chat-status").textContent = "";
      }
      break;
    }
    case "permission-request": renderPermission(d); break;
    case "permission-cleared": removePermission(d.permissionId); break;
    // tool-output / pty-output / stop / task-complete intentionally ignored (conversation comes from "chat")
  }
}
function setStatus(s) { const dot = $("status-dot"); if (dot) dot.className = "dot " + s; }

// ── permission cards ──
function renderPermission(d) {
  if (!d.permissionId || permissionEls.has(d.permissionId)) return;
  beep(880); setTimeout(() => beep(660), 120); buzz([90, 50, 90]);
  const cwd = d.cwd || d.session_cwd || ""; const folder = cwd ? cwd.split(/[\\/]/).pop() : "";
  const card = el("div", "perm-card");
  card.appendChild(el("div", "perm-head", "⚠️ 권한 요청" + (folder ? " · " + folder : "")));
  card.appendChild(el("div", "perm-tool", d.tool_name || "Tool"));
  const ti = d.tool_input || {}; const q = ti.questions && ti.questions[0];
  const detail = ti.command || ti.file_path || ti.path || (q && q.question) || "";
  if (detail) card.appendChild(el("pre", "perm-detail", String(detail)));
  const btns = el("div", "perm-btns");
  const options = q && Array.isArray(q.options) ? q.options : null;
  if (options && options.length) {
    options.forEach((opt, idx) => { const b = el("button", "perm-opt", opt.label || ("옵션 " + (idx + 1))); b.onclick = () => respond(d.permissionId, "allow", opt.label, idx); btns.appendChild(b); });
  } else {
    const a = el("button", "perm-allow", "✅ 허용"); a.onclick = () => respond(d.permissionId, "allow");
    const n = el("button", "perm-deny", "✋ 거부"); n.onclick = () => respond(d.permissionId, "deny");
    btns.appendChild(a); btns.appendChild(n);
    if (Array.isArray(d.permission_suggestions) && d.permission_suggestions.length) {
      const al = el("button", "perm-allowall", "✅ 항상"); al.onclick = () => respond(d.permissionId, "allow", undefined, undefined, true); btns.appendChild(al);
    }
  }
  card.appendChild(btns);
  $("permissions").appendChild(card); permissionEls.set(d.permissionId, card);
}
function removePermission(id) { const c = permissionEls.get(id); if (c) { c.remove(); permissionEls.delete(id); } }
async function respond(permissionId, behavior, selectedOption, optionIndex, allowAll) {
  const card = permissionEls.get(permissionId); if (card) card.classList.add("resolving");
  const body = { permissionId, decision: { behavior } };
  if (selectedOption !== undefined) body.selectedOption = selectedOption;
  if (Number.isInteger(optionIndex)) body.optionIndex = optionIndex;
  if (allowAll) body.allowAll = true;
  try {
    const res = await api("/command", { method: "POST", body: JSON.stringify(body) });
    if (res.ok) removePermission(permissionId); else if (card) card.classList.remove("resolving");
  } catch { if (card) card.classList.remove("resolving"); }
}

// ── push notifications ──
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function setPushBtn(state) {
  const b = $("push-btn"); if (!b) return;
  if (state === "on") { b.textContent = "🔔"; b.classList.add("on"); b.title = "알림 켜짐"; }
  else { b.textContent = "🔕"; b.classList.remove("on"); b.title = "알림 켜기"; }
}
async function enablePush() {
  unlockAudio();
  try {
    if (!window.isSecureContext) { alert("알림은 HTTPS 연결에서만 켤 수 있어요.\nTailscale HTTPS 주소(https://...ts.net)로 접속하세요."); return; }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) { alert("이 브라우저/버전은 웹 푸시를 지원하지 않습니다. (iOS 16.4+ + 홈 화면에 추가)"); return; }
    const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
    if (!standalone) { alert("알림은 '홈 화면에 추가'한 앱에서만 작동합니다.\nSafari 공유 → 홈 화면에 추가 후 다시 시도하세요."); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setPushBtn("off"); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch("/push/key")).json();
    if (!publicKey) { alert("서버 푸시 키를 가져오지 못했습니다."); return; }
    // Always rebuild a FRESH subscription — stale ones report success on the server
    // but silently stop delivering to the phone.
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      try { await api("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch { /* */ }
      try { await sub.unsubscribe(); } catch { /* */ }
    }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const res = await api("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub }) });
    if (res.ok) { localStorage.setItem("cw_push", "1"); setPushBtn("on"); alert("알림이 켜졌습니다! 🔔"); } else alert("구독 등록 실패 (서버).");
  } catch (e) { alert("알림 설정 실패: " + (e && e.message ? e.message : e)); }
}

// ── init ──
$("origin").textContent = location.host;
$("pair-btn").onclick = pair;
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") pair(); });
$("send-btn").onclick = () => { unlockAudio(); sendCommand(); };
$("cmd-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { unlockAudio(); sendCommand(); } });
$("back-btn").onclick = () => { currentCwd = null; currentSessionId = null; show("list"); loadFolders(); };
$("refresh-btn").onclick = loadFolders;
$("push-btn").onclick = enablePush;
$("menu-btn").onclick = () => { if (confirm("연결을 해제하고 코드를 다시 입력할까요?")) { token = null; localStorage.removeItem("cw_token"); location.reload(); } };

if (("Notification" in window) && Notification.permission === "granted" && localStorage.getItem("cw_push")) setPushBtn("on"); else setPushBtn("off");
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

if (token) { show("list"); loadFolders(); connect(); } else show("connect");
