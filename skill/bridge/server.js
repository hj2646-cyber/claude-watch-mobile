import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { spawn as childSpawn } from "node:child_process";
import { Bonjour } from "bonjour-service";
import webpush from "web-push";

// ---------------------------------------------------------------------------
// Logging (must be defined before use)
// ---------------------------------------------------------------------------

function log(level, msg, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (args.length) {
    console.log(prefix, msg, ...args);
  } else {
    console.log(prefix, msg);
  }
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

function findBinary(name, candidates) {
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* continue */ }
  }
  const isWin = process.platform === "win32";
  try {
    const out = execSync(isWin ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    if (out) {
      const lines = out.split(/\r?\n/).filter(Boolean);
      // On Windows `where` lists every match; prefer an executable launcher.
      const preferred = isWin ? lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) : null;
      return preferred || lines[0];
    }
  } catch { /* fall through */ }
  return null;
}

const NPM_GLOBAL_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "npm"
); // Windows npm global install dir (claude.cmd / codex.cmd live here)

const CLAUDE_BIN = findBinary("claude", [
  `${os.homedir()}/.local/bin/claude`,
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  path.join(NPM_GLOBAL_DIR, "claude.cmd"),
]);

const CODEX_BIN = findBinary("codex", [
  `${os.homedir()}/.local/bin/codex`,
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex",
  path.join(NPM_GLOBAL_DIR, "codex.cmd"),
]);

if (!CLAUDE_BIN) {
  log("warn", "Could not find 'claude' binary — Claude sessions will not be available.");
}
if (CODEX_BIN) {
  log("info", `Codex binary found: ${CODEX_BIN}`);
} else {
  log("info", "Codex not found — Codex sessions will not be available.");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT_RANGE_START = 7860;
const PORT_RANGE_END = 7869;
const PAIRING_CODE_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const SSE_HEARTBEAT_INTERVAL_MS = 10_000;
const SSE_BUFFER_SIZE = 500;
const PERMISSION_TIMEOUT_MS = 600_000; // 10 minutes
const CODEX_SESSION_SCAN_INTERVAL_MS = 1_500;
const CODEX_SESSION_BOOTSTRAP_LOOKBACK_MS = 30 * 60 * 1000;
const CODEX_SESSION_SCAN_LIMIT = 25;
const CODEX_SESSION_ROOT = path.join(os.homedir(), ".codex", "sessions");
const CODEX_LOG_FILE = path.join(os.homedir(), ".codex", "log", "codex-tui.log");
const BRIDGE_ID = crypto.randomUUID();

// Persistence (token + push subscriptions + VAPID keys survive restarts)
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(BRIDGE_DIR, ".auth.json");
const SUBS_FILE = path.join(BRIDGE_DIR, ".subs.json");
const VAPID_FILE = path.join(BRIDGE_DIR, ".vapid.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionToken = null;
let pairingCode = null;
let pairingCodeExpiresAt = 0;

// Rate limiting
let rateLimitAttempts = 0;
let rateLimitWindowStart = Date.now();

// Bridge-level state: "idle" | "connected"
let bridgeState = "idle";

// Web push state
let pushSubscriptions = [];
let vapidKeys = null;
let lastStopPushAt = 0;

// Multi-session: each entry is a session slot
// { id, agent, cwd, folderName, ptyProcess, state, createdAt }
/** @type {Map<string, {id: string, agent: string, cwd: string, folderName: string, ptyProcess: import("child_process").ChildProcess | null, state: string, createdAt: number}>} */
const sessions = new Map();

// SSE
let sseEventId = 0;
/** @type {Array<{id: number, event: string, data: string}>} */
const sseBuffer = [];
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

// Permission flow
/** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>, sessionId: string | null}>} */
const pendingPermissions = new Map();
/** @type {Map<string, Array>} */
const pendingPermissionBodies = new Map();
/** @type {Map<string, {offset: number, remainder: string, sessionId: string | null, cwd?: string, createdAt?: number, initialized: boolean}>} */
const codexSessionFiles = new Map();
/** @type {Map<string, {sessionId: string, name: string, args: Record<string, any>}>} */
const codexPendingToolCalls = new Map();
/** @type {Map<string, {command: string, justification: string, workdir: string, prefixRule: string[], createdAt: number}>} */
const codexExecApprovalCandidates = new Map();
/** @type {Map<string, {sessionId: string, optionCount: number, payload: Record<string, any>}>} */
const codexSyntheticPermissions = new Map();
/** @type {Map<string, string>} */
const codexSyntheticPermissionBySession = new Map();
const codexLogState = { offset: 0, remainder: "", initialized: false };
let codexMonitorInterval = null;

// Bonjour
let bonjourInstance = null;
let bonjourService = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePairingCode() {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  pairingCode = code;
  pairingCodeExpiresAt = Date.now() + PAIRING_CODE_TTL_MS;
  log("info", `Pairing code generated: ${code} (expires in 5 minutes)`);
  return code;
}

function generateSessionToken() {
  const token = crypto.randomBytes(32).toString("hex");
  sessionToken = token;
  return token;
}

function isRateLimited() {
  const now = Date.now();
  if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitAttempts = 0;
    rateLimitWindowStart = now;
  }
  return rateLimitAttempts >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordRateLimitAttempt() {
  const now = Date.now();
  if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitAttempts = 0;
    rateLimitWindowStart = now;
  }
  rateLimitAttempts++;
}

function requireAuth(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  return token === sessionToken && sessionToken !== null;
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function availableAgentsList() {
  const agents = [];
  if (CLAUDE_BIN) agents.push("claude");
  if (CODEX_BIN) agents.push("codex");
  return agents;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function pushSseEvent(event, data, sessionId = null) {
  sseEventId++;

  // Inject sessionId into the data payload
  let payload;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch {
      payload = { raw: data };
    }
  } else {
    payload = { ...data };
  }
  if (sessionId !== null) {
    payload.sessionId = sessionId;
  }

  const entry = { id: sseEventId, event, data: JSON.stringify(payload) };

  // Ring buffer
  if (sseBuffer.length >= SSE_BUFFER_SIZE) {
    sseBuffer.shift();
  }
  sseBuffer.push(entry);

  // Broadcast to connected clients
  const formatted = formatSseMessage(entry);
  for (const client of sseClients) {
    try {
      client.write(formatted);
    } catch {
      sseClients.delete(client);
    }
  }

  // Notify phones (even when the app is closed) for actionable events.
  maybePush(event, payload);
}

function formatSseMessage(entry) {
  let msg = `id: ${entry.id}\n`;
  msg += `event: ${entry.event}\n`;
  for (const line of entry.data.split("\n")) {
    msg += `data: ${line}\n`;
  }
  msg += "\n";
  return msg;
}

// ---------------------------------------------------------------------------
// Persistence + Web Push
// ---------------------------------------------------------------------------

function loadJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}

function saveJsonFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (err) { log("warn", `Failed to write ${file}: ${err.message}`); }
}

function persistToken() { saveJsonFile(AUTH_FILE, { token: sessionToken }); }
function persistSubs() { saveJsonFile(SUBS_FILE, pushSubscriptions); }

function initPersistenceAndPush() {
  // Restore the session token so paired phones keep working across restarts.
  const auth = loadJsonFile(AUTH_FILE, null);
  if (auth && auth.token) {
    sessionToken = auth.token;
    bridgeState = "connected";
    log("info", "Restored session token from disk (no re-pairing needed)");
  }

  // VAPID keys — generate once, then reuse.
  vapidKeys = loadJsonFile(VAPID_FILE, null);
  if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webpush.generateVAPIDKeys();
    saveJsonFile(VAPID_FILE, vapidKeys);
    log("info", "Generated new VAPID keys for push");
  }
  try {
    // VAPID `sub` must be a valid email/URL — Apple rejects fake domains (e.g. @local) with 403.
    // Override with the VAPID_SUBJECT env var if you like.
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:claude-watch@example.com", vapidKeys.publicKey, vapidKeys.privateKey);
  } catch (err) {
    log("warn", `VAPID setup failed: ${err.message}`);
  }

  pushSubscriptions = loadJsonFile(SUBS_FILE, []) || [];
  log("info", `Loaded ${pushSubscriptions.length} push subscription(s)`);
}

async function sendPush(title, body, tag) {
  if (!pushSubscriptions.length) return 0;
  // Unique tag per push: with a fixed tag, iOS silently coalesces (replaces the
  // old notification without re-alerting). A unique tag makes every push alert.
  const payload = JSON.stringify({ title, body, tag: (tag || "claude-watch") + ":" + Date.now() });
  const dead = [];
  let ok = 0;
  await Promise.all(pushSubscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      else log("warn", `Push send failed (status ${err.statusCode}): ${String(err.body || err.message || "").slice(0, 140)}`);
    }
  }));
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((s) => !dead.includes(s.endpoint));
    persistSubs();
    log("info", `Pruned ${dead.length} dead push subscription(s)`);
  }
  return ok;
}

// Decide which SSE events deserve a phone push (works even when the app is closed).
function maybePush(event, payload) {
  const cwd = payload && (payload.cwd || payload.session_cwd || payload.folderName);
  const folder = cwd ? String(cwd).split(/[\\/]/).pop() : "";
  const tag = folder ? `cw-${folder}` : "claude-watch";
  const label = folder ? `[${folder}] ` : "";
  if (event === "permission-request") {
    const tool = (payload && payload.tool_name) || "";
    sendPush(`⚠️ ${label}권한 요청`, tool ? `${tool} 승인이 필요해요` : "승인이 필요해요", tag);
  } else if (event === "stop") {
    const now = Date.now();
    if (now - lastStopPushAt > 5000) {
      lastStopPushAt = now;
      sendPush(`⏹ ${label}Claude 대기 중`, "응답이 필요할 수 있어요", tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-session PTY management
// ---------------------------------------------------------------------------

function spawnInteractiveProcess(agent, cwd, args = []) {
  const bin = agent === "codex" ? CODEX_BIN : CLAUDE_BIN;
  if (!bin) {
    return null;
  }
  const cols = parseInt(process.env.COLUMNS, 10) || 120;
  const rows = parseInt(process.env.LINES, 10) || 40;

  return childSpawn("script", ["-q", "/dev/null", bin, ...args], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function bindPtyProcess(slot, proc) {
  const sessionId = slot.id;
  slot.ptyProcess = proc;

  proc.stdout.on("data", (data) => {
    pushSseEvent("pty-output", { text: data.toString() }, sessionId);
  });

  proc.stderr.on("data", (data) => {
    pushSseEvent("pty-output", { text: data.toString() }, sessionId);
  });

  proc.on("close", (exitCode, signal) => {
    log("info", `Session ${sessionId} (${slot.agent}) PTY exited: code=${exitCode} signal=${signal}`);
    slot.state = "ended";
    slot.ptyProcess = null;
    clearCodexSyntheticPermissionForSession(sessionId, "pty-closed");
    pushSseEvent("session", { state: "ended", exitCode, signal, agent: slot.agent, folderName: slot.folderName }, sessionId);
  });

  proc.on("error", (err) => {
    log("error", `Session ${sessionId} PTY spawn error: ${err.message}`);
    slot.state = "ended";
    slot.ptyProcess = null;
    clearCodexSyntheticPermissionForSession(sessionId, "pty-error");
    pushSseEvent("session", { state: "ended", error: err.message, agent: slot.agent, folderName: slot.folderName }, sessionId);
  });
}

function spawnSession(agent, cwd) {
  const sessionId = crypto.randomUUID();
  const folderName = path.basename(cwd) || cwd;

  log("info", `Spawning ${agent} session ${sessionId} in PTY (cwd: ${cwd})`);

  const proc = spawnInteractiveProcess(agent, cwd);
  if (!proc) {
    const msg = `Cannot spawn ${agent}: binary not found`;
    log("error", msg);
    pushSseEvent("error", { error: msg });
    return null;
  }

  log("info", `Using binary: ${agent === "codex" ? CODEX_BIN : CLAUDE_BIN}`);

  const slot = {
    id: sessionId,
    agent,
    cwd,
    folderName,
    ptyProcess: proc,
    state: "running",
    createdAt: Date.now(),
  };
  sessions.set(sessionId, slot);
  bindPtyProcess(slot, proc);

  pushSseEvent("session", { state: "running", agent, cwd, folderName }, sessionId);

  log("info", `${agent} session ${sessionId} started (${folderName}), pid: ${proc.pid}`);
  return sessionId;
}

function attachPtyToSession(slot) {
  if (slot.ptyProcess) return slot.ptyProcess;

  const args = slot.agent === "codex"
    ? ["resume", slot.id, "--no-alt-screen"]
    : [];

  const proc = spawnInteractiveProcess(slot.agent, slot.cwd, args);
  if (!proc) return null;

  bindPtyProcess(slot, proc);
  log("info", `Attached PTY to session ${slot.id} (${slot.agent}), pid: ${proc.pid}`);
  return proc;
}

function killSession(sessionId) {
  const slot = sessions.get(sessionId);
  if (!slot) return false;
  if (slot.ptyProcess) {
    try { slot.ptyProcess.kill(); } catch { /* ignore */ }
  }
  slot.state = "ended";
  slot.ptyProcess = null;
  pushSseEvent("session", { state: "ended", agent: slot.agent, folderName: slot.folderName, killed: true }, sessionId);
  log("info", `Session ${sessionId} killed`);
  return true;
}

function findSessionByCwd(cwd) {
  if (!cwd) return null;
  for (const [, slot] of sessions) {
    if (slot.cwd === cwd && slot.state === "running") return slot;
  }
  return null;
}

function findMostRecentActiveSession() {
  let best = null;
  for (const [, slot] of sessions) {
    if (slot.state === "running" && slot.ptyProcess) {
      if (!best || slot.createdAt > best.createdAt) {
        best = slot;
      }
    }
  }
  return best;
}

function findMostRecentRunningSession() {
  let best = null;
  for (const [, slot] of sessions) {
    if (slot.state === "running") {
      if (!best || slot.createdAt > best.createdAt) {
        best = slot;
      }
    }
  }
  return best;
}

function getSessionsSnapshot() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    agent: s.agent,
    cwd: s.cwd,
    folderName: s.folderName,
    state: s.state,
    createdAt: s.createdAt,
  }));
}

function safeStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function listRecentCodexSessionFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stat = safeStat(fullPath);
      if (!stat) continue;
      results.push({ filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, CODEX_SESSION_SCAN_LIMIT);
}

function readFileSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function touchExternalSession(sessionId, cwd, createdAt) {
  const resolvedCwd = cwd || process.env.HOME || process.cwd();
  const folderName = path.basename(resolvedCwd) || resolvedCwd;
  const existing = sessions.get(sessionId);

  if (existing) {
    const wasEnded = existing.state !== "running";
    existing.agent = "codex";
    existing.cwd = resolvedCwd;
    existing.folderName = folderName;
    existing.state = "running";
    existing.createdAt = createdAt || existing.createdAt || Date.now();
    if (wasEnded) {
      pushSseEvent("session", { state: "running", agent: "codex", cwd: resolvedCwd, folderName }, sessionId);
      log("info", `Revived Codex session ${sessionId} (${folderName}) from local session data`);
    }
    return existing;
  }

  const slot = {
    id: sessionId,
    agent: "codex",
    cwd: resolvedCwd,
    folderName,
    ptyProcess: null,
    state: "running",
    createdAt: createdAt || Date.now(),
  };
  sessions.set(sessionId, slot);
  pushSseEvent("session", { state: "running", agent: "codex", cwd: resolvedCwd, folderName }, sessionId);
  log("info", `Detected Codex session ${sessionId} (${folderName}) from local session data`);
  return slot;
}

function endExternalSession(sessionId, reason = "codex-exit") {
  const slot = sessions.get(sessionId);
  if (!slot || slot.state === "ended") return;
  slot.state = "ended";
  slot.ptyProcess = null;
  clearCodexSyntheticPermissionForSession(sessionId, reason);
  pushSseEvent("session", { state: "ended", agent: slot.agent, folderName: slot.folderName, reason }, sessionId);
  log("info", `Marked external session ${sessionId} as ended (${reason})`);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseFunctionCallArgs(rawArgs) {
  if (typeof rawArgs !== "string") return {};
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractPatchPaths(rawPatch) {
  if (typeof rawPatch !== "string" || rawPatch.length === 0) return [];
  const paths = [];
  for (const line of rawPatch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (match) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function emitCodexToolEvent(sessionId, toolName, toolInput = {}, toolOutput = null) {
  pushSseEvent("tool-output", {
    source: "codex",
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
  }, sessionId);
}

function emitCodexToolResult(sessionId, pendingCall, output) {
  if (!pendingCall || !sessionId) return;

  switch (pendingCall.name) {
    case "exec_command":
      emitCodexToolEvent(sessionId, "Bash", { command: pendingCall.args.cmd || "" }, output);
      break;
    case "apply_patch": {
      const patchPaths = extractPatchPaths(pendingCall.args.patch);
      if (patchPaths.length === 0) {
        emitCodexToolEvent(sessionId, "Edit", {}, output);
        break;
      }
      for (const filePath of patchPaths) {
        emitCodexToolEvent(sessionId, "Edit", { file_path: filePath }, output);
      }
      break;
    }
    default:
      emitCodexToolEvent(sessionId, pendingCall.name, pendingCall.args, output);
      break;
  }
}

function truncateText(value, maxLength = 80) {
  if (typeof value !== "string") return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function buildCodexApprovalOptions(prefixRule = []) {
  const options = [
    {
      label: "Yes, proceed",
      description: "Run this command once",
    },
  ];

  if (Array.isArray(prefixRule) && prefixRule.length > 0) {
    options.push({
      label: "Yes, don't ask again",
      description: `Trust ${prefixRule.join(" ")} in future`,
    });
  }

  options.push({
    label: "No",
    description: "Deny this command and return to Codex",
  });

  return options;
}

function recordCodexExecApprovalCandidate(line) {
  const match = line.match(/ToolCall: exec_command (\{.*\}) thread_id=([0-9a-f-]+)/i);
  if (!match) return;

  let args;
  try {
    args = JSON.parse(match[1]);
  } catch {
    return;
  }

  if (args?.sandbox_permissions !== "require_escalated") return;

  codexExecApprovalCandidates.set(match[2], {
    command: args.cmd || "",
    justification: args.justification || "Would you like to run this command?",
    workdir: args.workdir || "",
    prefixRule: Array.isArray(args.prefix_rule) ? args.prefix_rule : [],
    createdAt: Date.now(),
  });
}

function surfaceCodexExecApproval(sessionId) {
  const slot = sessions.get(sessionId);
  const candidate = codexExecApprovalCandidates.get(sessionId);
  if (!slot || !candidate) return;

  const existingId = codexSyntheticPermissionBySession.get(sessionId);
  if (existingId) return;

  const permissionId = crypto.randomUUID();
  const options = buildCodexApprovalOptions(candidate.prefixRule);
  const payload = {
    permissionId,
    source: "codex",
    tool_name: "ExecApproval",
    tool_input: {
      command: candidate.command,
      workdir: candidate.workdir,
      questions: [
        {
          header: truncateText(`Run: ${candidate.command}`, 72),
          question: candidate.justification || "Would you like to run this command?",
          options,
        },
      ],
    },
  };
  codexSyntheticPermissions.set(permissionId, { sessionId, optionCount: options.length, payload });
  codexSyntheticPermissionBySession.set(sessionId, permissionId);

  pushSseEvent("permission-request", payload, sessionId);

  log("info", `Surfaced Codex approval ${permissionId} for session ${sessionId}`);
}

function clearCodexSyntheticPermissionForSession(sessionId, reason = "cleared") {
  const permissionId = codexSyntheticPermissionBySession.get(sessionId);
  if (!permissionId) return false;

  codexSyntheticPermissionBySession.delete(sessionId);
  codexSyntheticPermissions.delete(permissionId);
  codexExecApprovalCandidates.delete(sessionId);
  pushSseEvent("permission-cleared", { permissionId, reason }, sessionId);
  return true;
}

function resolveCodexSyntheticPermission(permissionId, selectedOption, optionIndex) {
  const synthetic = codexSyntheticPermissions.get(permissionId);
  if (!synthetic) return false;

  const slot = sessions.get(synthetic.sessionId);
  if (!slot) return false;

  const proc = slot.ptyProcess || attachPtyToSession(slot);
  if (!proc || !proc.stdin) return false;

  let input = "\u001b";
  const normalizedIndex = Number.isInteger(optionIndex) ? optionIndex : -1;

  if (normalizedIndex === 0 || /^yes,?\s*proceed/i.test(String(selectedOption || ""))) {
    input = "y";
  } else if (
    synthetic.optionCount === 3
    && (normalizedIndex === 1 || /^yes,?\s*don't ask again/i.test(String(selectedOption || "")))
  ) {
    input = "2\n";
  }

  proc.stdin.write(input);
  clearCodexSyntheticPermissionForSession(synthetic.sessionId, "resolved");
  log("info", `Resolved Codex approval ${permissionId} for session ${synthetic.sessionId}`);
  return true;
}

function handleCodexJsonlLine(line, fileState, options = {}) {
  const parsed = parseJsonLine(line);
  if (!parsed) return;

  const bootstrap = options.bootstrap === true;

  if (parsed.type === "session_meta") {
    const sessionId = parsed.payload?.id;
    if (!sessionId) return;

    fileState.sessionId = sessionId;
    fileState.cwd = parsed.payload?.cwd || fileState.cwd;
    fileState.createdAt = Date.parse(parsed.payload?.timestamp || parsed.timestamp || "") || fileState.createdAt || Date.now();

    if (bootstrap && options.allowBootstrap !== true) return;

    touchExternalSession(sessionId, fileState.cwd, fileState.createdAt);
    return;
  }

  const sessionId = fileState.sessionId;
  if (!sessionId || bootstrap) return;
  if (!sessions.has(sessionId) || sessions.get(sessionId)?.state !== "running") {
    touchExternalSession(sessionId, fileState.cwd, fileState.createdAt);
  }

  if (parsed.type === "response_item" && parsed.payload?.type === "function_call") {
    const callId = parsed.payload.call_id;
    if (!callId) return;
    codexPendingToolCalls.set(callId, {
      sessionId,
      name: parsed.payload.name,
      args: parseFunctionCallArgs(parsed.payload.arguments),
    });
    return;
  }

  if (parsed.type === "response_item" && parsed.payload?.type === "function_call_output") {
    const pendingCall = codexPendingToolCalls.get(parsed.payload.call_id);
    emitCodexToolResult(sessionId, pendingCall, parsed.payload.output ?? null);
    if (parsed.payload.call_id) {
      codexPendingToolCalls.delete(parsed.payload.call_id);
    }
    return;
  }

  if (parsed.type !== "event_msg") return;

  const payloadType = parsed.payload?.type;
  if (payloadType === "task_started") {
    touchExternalSession(sessionId, fileState.cwd, fileState.createdAt);
    return;
  }
  if (payloadType === "agent_message" && parsed.payload?.message) {
    emitCodexToolEvent(sessionId, "CodexMessage", {}, parsed.payload.message);
    return;
  }
  if (payloadType === "exec_command_end") {
    const pendingCall = codexPendingToolCalls.get(parsed.payload.call_id);
    const command = pendingCall?.args?.cmd
      || (Array.isArray(parsed.payload.command) ? parsed.payload.command.join(" ") : "");
    emitCodexToolEvent(sessionId, "Bash", { command }, parsed.payload.aggregated_output ?? null);
    if (parsed.payload.call_id) {
      codexPendingToolCalls.delete(parsed.payload.call_id);
    }
    return;
  }
  if (payloadType === "task_complete") {
    pushSseEvent("task-complete", { source: "codex" }, sessionId);
  }
}

function initializeCodexSessionFile(filePath, stat, fileState) {
  const headerSize = Math.min(stat.size, 64 * 1024);
  const header = headerSize > 0 ? readFileSlice(filePath, 0, headerSize) : "";
  const allowBootstrap = Date.now() - stat.mtimeMs <= CODEX_SESSION_BOOTSTRAP_LOOKBACK_MS;

  for (const line of header.split("\n")) {
    if (!line.trim()) continue;
    handleCodexJsonlLine(line, fileState, { bootstrap: true, allowBootstrap });
    if (fileState.sessionId) break;
  }

  fileState.offset = stat.size;
  fileState.remainder = "";
  fileState.initialized = true;
}

function readCodexSessionFileDelta(filePath, stat, fileState) {
  if (stat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.remainder = "";
  }
  if (stat.size === fileState.offset) return;

  const delta = readFileSlice(filePath, fileState.offset, stat.size - fileState.offset);
  fileState.offset = stat.size;

  let chunk = fileState.remainder + delta;
  const lines = chunk.split("\n");
  fileState.remainder = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    handleCodexJsonlLine(line, fileState);
  }
}

function scanCodexSessionFiles() {
  const statRoot = safeStat(CODEX_SESSION_ROOT);
  if (!statRoot || !statRoot.isDirectory()) return;

  const seen = new Set();
  for (const entry of listRecentCodexSessionFiles(CODEX_SESSION_ROOT)) {
    seen.add(entry.filePath);
    const fileState = codexSessionFiles.get(entry.filePath) || {
      offset: 0,
      remainder: "",
      sessionId: null,
      cwd: undefined,
      createdAt: undefined,
      initialized: false,
    };

    if (!fileState.initialized) {
      initializeCodexSessionFile(entry.filePath, entry, fileState);
      codexSessionFiles.set(entry.filePath, fileState);
      continue;
    }

    readCodexSessionFileDelta(entry.filePath, entry, fileState);
    codexSessionFiles.set(entry.filePath, fileState);
  }

  for (const filePath of codexSessionFiles.keys()) {
    if (!seen.has(filePath)) {
      codexSessionFiles.delete(filePath);
    }
  }
}

function consumeCodexLogChunk(text) {
  const combined = codexLogState.remainder + text;
  const lines = combined.split("\n");
  codexLogState.remainder = lines.pop() ?? "";

  for (const line of lines) {
    recordCodexExecApprovalCandidate(line);

    const approvalMatch = line.match(/thread_id=([0-9a-f-]+).*codex\.op="exec_approval".*codex_core::codex: (new|close)/i);
    if (approvalMatch) {
      const [, sessionId, state] = approvalMatch;
      if (state === "new") {
        surfaceCodexExecApproval(sessionId);
      } else {
        clearCodexSyntheticPermissionForSession(sessionId, "closed");
      }
    }

    if (line.includes("Shutting down Codex instance")) {
      const match = line.match(/thread_id=([0-9a-f-]+)/i);
      if (match) {
        clearCodexSyntheticPermissionForSession(match[1], "codex-shutdown");
        endExternalSession(match[1], "codex-shutdown");
      }
    }
  }
}

function scanCodexLog() {
  const stat = safeStat(CODEX_LOG_FILE);
  if (!stat || !stat.isFile()) return;

  if (!codexLogState.initialized) {
    const lookbackSize = Math.min(stat.size, 128 * 1024);
    const startOffset = Math.max(0, stat.size - lookbackSize);
    const bootstrapText = lookbackSize > 0 ? readFileSlice(CODEX_LOG_FILE, startOffset, lookbackSize) : "";
    codexLogState.offset = stat.size;
    codexLogState.remainder = "";
    codexLogState.initialized = true;
    if (bootstrapText) {
      consumeCodexLogChunk(bootstrapText);
    }
    return;
  }

  if (stat.size < codexLogState.offset) {
    codexLogState.offset = 0;
    codexLogState.remainder = "";
  }
  if (stat.size === codexLogState.offset) return;

  const text = readFileSlice(CODEX_LOG_FILE, codexLogState.offset, stat.size - codexLogState.offset);
  codexLogState.offset = stat.size;
  consumeCodexLogChunk(text);
}

function startCodexMonitor() {
  if (codexMonitorInterval) return;

  scanCodexSessionFiles();
  scanCodexLog();

  codexMonitorInterval = setInterval(() => {
    try {
      scanCodexSessionFiles();
      scanCodexLog();
    } catch (err) {
      log("warn", `Codex monitor scan failed: ${err.message}`);
    }
  }, CODEX_SESSION_SCAN_INTERVAL_MS);
}

function stopCodexMonitor() {
  if (codexMonitorInterval) {
    clearInterval(codexMonitorInterval);
    codexMonitorInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code transcript monitor — reads the REAL conversation that Claude Code
// writes to ~/.claude/projects/<folder>/<session>.jsonl, grouped by folder.
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const CLAUDE_SCAN_INTERVAL_MS = 1500;
const CLAUDE_SCAN_LIMIT = 40;

/** @type {Map<string, {offset:number, remainder:string, sessionId:string|null, cwd:string|null}>} */
const claudeFiles = new Map();
/** @type {Map<string, string>} sessionId -> ai title */
const claudeTitles = new Map();
let claudeMonitorInterval = null;

function listRecentClaudeFiles() {
  const results = [];
  let projectDirs;
  try { projectDirs = fs.readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true }); }
  catch { return results; }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLAUDE_PROJECTS_ROOT, d.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f.name);
      const st = safeStat(fp);
      if (!st) continue;
      results.push({ filePath: fp, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, CLAUDE_SCAN_LIMIT);
}

function toolChip(name, input) {
  input = input || {};
  const d = input.command || input.file_path || input.path || input.pattern || input.url || "";
  return d ? `${name}: ${String(d).slice(0, 90)}` : name;
}

// Turn one transcript line into chat items [{role, text}] (real conversation only).
function parseClaudeMessage(o) {
  if (!o || (o.type !== "user" && o.type !== "assistant")) return [];
  const m = o.message || {};
  const items = [];
  if (o.type === "user") {
    if (o.toolUseResult) return []; // tool result, not a typed message
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n");
    }
    text = (text || "").trim();
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return [];
    items.push({ role: "user", text });
  } else {
    if (!Array.isArray(m.content)) return [];
    for (const b of m.content) {
      if (b.type === "text" && b.text && b.text.trim()) items.push({ role: "assistant", text: b.text.trim() });
      else if (b.type === "tool_use" && b.name) items.push({ role: "tool", text: toolChip(b.name, b.input) });
    }
  }
  return items;
}

function processClaudeLine(line, fileState) {
  const o = parseJsonLine(line);
  if (!o) return;
  if (o.sessionId) fileState.sessionId = o.sessionId;
  if (o.cwd && !fileState.cwd) fileState.cwd = o.cwd; // keep the launch cwd (don't drift)
  if (o.type === "ai-title" && o.aiTitle && fileState.sessionId) {
    claudeTitles.set(fileState.sessionId, o.aiTitle);
    return;
  }
  const items = parseClaudeMessage(o);
  if (!items.length) return;
  const cwd = fileState.cwd || "";
  const folderName = cwd ? path.basename(cwd) : "claude";
  for (const it of items) {
    pushSseEvent("chat", { role: it.role, text: it.text, cwd, folderName }, fileState.sessionId);
  }
}

function initClaudeFileState(filePath, size) {
  // Only tail NEW content; read a small head to learn sessionId + cwd.
  const fileState = { offset: size, remainder: "", sessionId: null, cwd: null };
  try {
    const head = readFileSlice(filePath, 0, Math.min(size, 16 * 1024));
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      const o = parseJsonLine(line);
      if (o && o.sessionId) fileState.sessionId = o.sessionId;
      if (o && o.cwd) fileState.cwd = o.cwd;
      if (fileState.sessionId && fileState.cwd) break;
    }
  } catch { /* ignore */ }
  return fileState;
}

function scanClaudeFiles() {
  const seen = new Set();
  for (const entry of listRecentClaudeFiles()) {
    seen.add(entry.filePath);
    let fileState = claudeFiles.get(entry.filePath);
    if (!fileState) {
      fileState = initClaudeFileState(entry.filePath, entry.size);
      claudeFiles.set(entry.filePath, fileState);
      continue; // no replay — history is fetched on demand via /history
    }
    if (entry.size < fileState.offset) { fileState.offset = 0; fileState.remainder = ""; }
    if (entry.size === fileState.offset) continue;
    let delta;
    try { delta = readFileSlice(entry.filePath, fileState.offset, entry.size - fileState.offset); }
    catch { continue; }
    fileState.offset = entry.size;
    const chunk = fileState.remainder + delta;
    const lines = chunk.split("\n");
    fileState.remainder = lines.pop() ?? "";
    for (const line of lines) { if (line.trim()) processClaudeLine(line, fileState); }
  }
  for (const fp of claudeFiles.keys()) if (!seen.has(fp)) claudeFiles.delete(fp);
}

function startClaudeMonitor() {
  if (claudeMonitorInterval) return;
  try { scanClaudeFiles(); } catch (err) { log("warn", `Claude monitor init failed: ${err.message}`); }
  claudeMonitorInterval = setInterval(() => {
    try { scanClaudeFiles(); } catch (err) { log("warn", `Claude monitor scan failed: ${err.message}`); }
  }, CLAUDE_SCAN_INTERVAL_MS);
  log("info", `Claude transcript monitor watching ${CLAUDE_PROJECTS_ROOT}`);
}

function stopClaudeMonitor() {
  if (claudeMonitorInterval) { clearInterval(claudeMonitorInterval); claudeMonitorInterval = null; }
}

// Read a session file's tail and summarize (for the folder list).
function readClaudeSessionMeta(filePath, size) {
  // Folder identity = the LAUNCH cwd (first cwd in the file). The per-line cwd can
  // drift mid-session (e.g. shell `cd`), so never trust the latest one for grouping.
  let sessionId = null, cwd = null, title = null, lastMessage = null, lastRole = null;
  try {
    const head = readFileSlice(filePath, 0, Math.min(size, 16 * 1024));
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      const o = parseJsonLine(line);
      if (!o) continue;
      if (o.sessionId && !sessionId) sessionId = o.sessionId;
      if (o.cwd && !cwd) cwd = o.cwd;
      if (sessionId && cwd) break;
    }
  } catch { /* */ }
  try {
    const cap = Math.min(size, 32 * 1024);
    const tail = cap > 0 ? readFileSlice(filePath, Math.max(0, size - cap), cap) : "";
    for (const line of tail.split("\n")) {
      if (!line.trim()) continue;
      const o = parseJsonLine(line);
      if (!o) continue;
      if (o.sessionId && !sessionId) sessionId = o.sessionId;
      if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;
      for (const it of parseClaudeMessage(o)) {
        if (it.role === "user" || it.role === "assistant") { lastMessage = it.text; lastRole = it.role; }
      }
    }
  } catch { /* */ }
  return { sessionId, cwd, folderName: cwd ? path.basename(cwd) : "", title, lastMessage, lastRole };
}

function buildFolderList() {
  const byFolder = new Map(); // cwd -> {...}
  for (const entry of listRecentClaudeFiles()) {
    const meta = readClaudeSessionMeta(entry.filePath, entry.size);
    if (!meta.cwd || !meta.sessionId) continue;
    const prev = byFolder.get(meta.cwd);
    if (!prev || entry.mtimeMs > prev.mtime) {
      byFolder.set(meta.cwd, {
        cwd: meta.cwd,
        folderName: path.basename(meta.cwd) || meta.cwd,
        sessionId: meta.sessionId,
        title: meta.title || claudeTitles.get(meta.sessionId) || null,
        lastMessage: meta.lastMessage,
        lastRole: meta.lastRole,
        mtime: entry.mtimeMs,
      });
    }
  }
  return [...byFolder.values()].sort((a, b) => b.mtime - a.mtime);
}

function findClaudeFileBySession(sessionId) {
  if (!sessionId) return null;
  for (const entry of listRecentClaudeFiles()) {
    if (path.basename(entry.filePath) === `${sessionId}.jsonl`) return entry.filePath;
  }
  return null;
}

function readClaudeHistory(sessionId, limit) {
  const fp = findClaudeFileBySession(sessionId);
  if (!fp) return null;
  const dir = path.dirname(fp);
  // All sessions for one folder live in the same project dir — merge the recent
  // ones by timestamp so continued/forked sessions don't make history "vanish".
  let names;
  try {
    names = fs.readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ n, m: (safeStat(path.join(dir, n)) || { mtimeMs: 0 }).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 6)
      .map((x) => x.n);
  } catch { names = [path.basename(fp)]; }

  const all = [];
  let cwd = null;
  for (const name of names) {
    const full = path.join(dir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    const cap = Math.min(st.size, 1024 * 1024);
    let text = "";
    try { text = readFileSlice(full, Math.max(0, st.size - cap), cap); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const o = parseJsonLine(line);
      if (!o) continue;
      if (o.cwd && !cwd) cwd = o.cwd;
      const ts = Date.parse(o.timestamp || "") || 0;
      for (const it of parseClaudeMessage(o)) all.push({ role: it.role, text: it.text, ts });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const messages = all.slice(-limit).map(({ role, text }) => ({ role, text }));
  return { sessionId, cwd, folderName: cwd ? path.basename(cwd) : "", messages };
}

// ---------------------------------------------------------------------------
// Permission flow
// ---------------------------------------------------------------------------

function waitForPermission(permissionId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(permissionId);
      log("warn", `Permission ${permissionId} timed out after ${PERMISSION_TIMEOUT_MS / 1000}s, auto-denying`);
      resolve({ behavior: "deny", reason: "Timed out waiting for watch response" });
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(permissionId, { resolve, timer });
  });
}

function resolvePermission(permissionId, decision) {
  const pending = pendingPermissions.get(permissionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingPermissions.delete(permissionId);
  pending.resolve(decision);
  return true;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePair(req, res) {
  if (req.method !== "POST") {
    return jsonResponse(res, 405, { error: "Method not allowed" });
  }

  if (isRateLimited()) {
    return jsonResponse(res, 429, { error: "Too many pairing attempts. Try again later." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  recordRateLimitAttempt();

  const { code } = body;
  if (!code || typeof code !== "string") {
    return jsonResponse(res, 400, { error: "Missing 'code' field" });
  }

  if (Date.now() > pairingCodeExpiresAt) {
    generatePairingCode();
    return jsonResponse(res, 401, { error: "Pairing code expired. A new code has been generated." });
  }

  if (code !== pairingCode) {
    return jsonResponse(res, 401, { error: "Invalid pairing code" });
  }

  // Success
  const token = generateSessionToken();
  persistToken();
  pairingCode = null;
  pairingCodeExpiresAt = 0;
  bridgeState = "connected";
  pushSseEvent("session", { state: "connected" });

  log("info", "Watch paired successfully");
  return jsonResponse(res, 200, {
    token,
    bridgeId: BRIDGE_ID,
    sessionId: BRIDGE_ID, // backward compat
    availableAgents: availableAgentsList(),
    sessions: getSessionsSnapshot(),
  });
}

async function handleCommand(req, res) {
  if (req.method !== "POST") {
    return jsonResponse(res, 405, { error: "Method not allowed" });
  }
  if (!requireAuth(req)) {
    return jsonResponse(res, 401, { error: "Unauthorized" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  const {
    command,
    permissionId,
    decision,
    allowAll,
    agent,
    sessionId,
    spawn: spawnRequest,
    kill: killRequest,
    selectedOption,
    optionIndex,
  } = body;

  // --- Spawn a new session ---
  if (spawnRequest) {
    const validAgents = ["claude", "codex"];
    if (!validAgents.includes(spawnRequest)) {
      return jsonResponse(res, 400, { error: `Invalid agent: ${spawnRequest}. Use: ${validAgents.join(", ")}` });
    }
    const cwd = body.cwd || process.argv[2] || process.env.HOME || process.cwd();
    const newId = spawnSession(spawnRequest, cwd);
    if (!newId) {
      return jsonResponse(res, 500, { error: `Failed to spawn ${spawnRequest}` });
    }
    return jsonResponse(res, 200, { ok: true, sessionId: newId, agent: spawnRequest });
  }

  // --- Kill a session ---
  if (killRequest && sessionId) {
    const killed = killSession(sessionId);
    if (!killed) {
      return jsonResponse(res, 404, { error: "No session with that ID" });
    }
    return jsonResponse(res, 200, { ok: true });
  }

  // --- Permission response ---
  if (permissionId && (decision || selectedOption !== undefined || Number.isInteger(optionIndex))) {
    if (decision) {
      if (allowAll && decision.behavior === "allow") {
        decision.updatedPermissions = pendingPermissionBodies.get(permissionId) || [];
      }
      pendingPermissionBodies.delete(permissionId);

      // Forward the watch's selected option so the hook response can include it
      if (selectedOption !== undefined) decision.selectedOption = selectedOption;
      if (Number.isInteger(optionIndex)) decision.optionIndex = optionIndex;

      const resolved = resolvePermission(permissionId, decision);
      if (resolved) {
        log("info", `Permission ${permissionId} resolved: ${decision.behavior}${allowAll ? " (allow all)" : ""}`);
        return jsonResponse(res, 200, { ok: true });
      }
    }

    const resolvedSynthetic = resolveCodexSyntheticPermission(permissionId, selectedOption, optionIndex);
    if (resolvedSynthetic) {
      return jsonResponse(res, 200, { ok: true });
    }

    return jsonResponse(res, 404, { error: "No pending permission with that ID" });
  }

  // --- PTY command injection ---
  if (command !== undefined) {
    // Find the target session
    let targetSession = null;

    if (sessionId) {
      targetSession = sessions.get(sessionId);
      if (!targetSession) {
        // Adopt a Claude transcript session so the phone can continue that folder's chat.
        const fp = findClaudeFileBySession(sessionId);
        if (fp) {
          const meta = readClaudeSessionMeta(fp, (safeStat(fp) || { size: 0 }).size);
          const cwd = body.cwd || (meta && meta.cwd) || process.cwd();
          targetSession = {
            id: sessionId, agent: "claude", cwd,
            folderName: path.basename(cwd) || cwd, ptyProcess: null,
            state: "running", createdAt: Date.now(),
          };
          sessions.set(sessionId, targetSession);
          log("info", `Adopted Claude transcript session ${sessionId} (${targetSession.folderName})`);
        }
      }
      if (targetSession && !targetSession.ptyProcess) {
        // Session exists but has no PTY (external hook-created session).
        // Run the prompt via CLI in non-interactive mode — hooks will forward output.
        const promptText = command.replace(/\n$/, "").trim();
        if (!promptText) {
          return jsonResponse(res, 400, { error: "Empty command" });
        }

        const bin = targetSession.agent === "codex" ? CODEX_BIN : CLAUDE_BIN;
        if (!bin) {
          return jsonResponse(res, 500, { error: `No binary found for ${targetSession.agent}` });
        }

        const args = targetSession.agent === "codex"
          ? ["exec", promptText]
          : ["-p", promptText, "--continue"];

        log("info", `Running ${targetSession.agent} prompt in ${targetSession.cwd}: "${promptText.slice(0, 80)}"`);

        targetSession.state = "running";
        pushSseEvent("session", { state: "running", agent: targetSession.agent, cwd: targetSession.cwd, folderName: targetSession.folderName }, sessionId);

        const proc = childSpawn(bin, args, {
          cwd: targetSession.cwd,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          // Windows: `claude` resolves to claude.cmd, which needs a shell to spawn.
          shell: process.platform === "win32",
        });

        let stderrBuf = "";
        proc.stdout.on("data", () => { /* assistant reply is captured via the transcript monitor */ });
        proc.stderr.on("data", (data) => { stderrBuf += data.toString(); });
        proc.on("close", (exitCode) => {
          log("info", `Prompt process exited (code ${exitCode}) for session ${sessionId}`);
          if (exitCode !== 0) {
            let reason = (stderrBuf.trim().split("\n").find((l) => l.trim()) || `종료 코드 ${exitCode}`).slice(0, 200);
            if (/oauth|403|not allowed|permission_error/i.test(stderrBuf)) {
              reason = "이 계정에선 폰→Claude 메시지 전송이 막혀 있어요 (headless 403). 보기·권한 승인·알림은 정상입니다.";
            }
            pushSseEvent("chat", { role: "tool", text: "⚠️ " + reason, cwd: targetSession.cwd, folderName: targetSession.folderName }, sessionId);
          }
        });
        proc.on("error", (err) => {
          log("error", `Prompt process error for session ${sessionId}: ${err.message}`);
        });

        return jsonResponse(res, 200, { ok: true, sessionId, agent: targetSession.agent, prompt: true });
      }
      if (!targetSession) {
        return jsonResponse(res, 404, { error: "No session with that ID" });
      }
    } else {
      // Backward compat: route to the most recent active session
      targetSession = findMostRecentActiveSession() || findMostRecentRunningSession();
    }

    if (!targetSession) {
      // Auto-spawn a new session
      const requestedAgent = agent || "claude";
      const cwd = body.cwd || process.argv[2] || process.env.HOME || process.cwd();
      const newId = spawnSession(requestedAgent, cwd);
      if (!newId) {
        return jsonResponse(res, 500, { error: `Failed to spawn ${requestedAgent}` });
      }
      const slot = sessions.get(newId);
      setTimeout(() => {
        if (slot && slot.ptyProcess) {
          slot.ptyProcess.stdin.write(command);
          log("info", `Command injected into new ${requestedAgent} session ${newId} (${command.length} chars)`);
        }
      }, 500);
      return jsonResponse(res, 200, { ok: true, sessionId: newId, agent: requestedAgent, spawned: true });
    }

    try {
      targetSession.ptyProcess.stdin.write(command);
      log("info", `Command injected into session ${targetSession.id} (${command.length} chars)`);
      return jsonResponse(res, 200, { ok: true, sessionId: targetSession.id, agent: targetSession.agent });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  return jsonResponse(res, 400, { error: "Missing 'command', 'spawn', 'kill', or 'permissionId'+'decision'" });
}

function handleEvents(req, res) {
  if (req.method !== "GET") {
    return jsonResponse(res, 405, { error: "Method not allowed" });
  }
  if (!requireAuth(req)) {
    return jsonResponse(res, 401, { error: "Unauthorized" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay from Last-Event-ID if provided
  const lastIdHeader = req.headers["last-event-id"];
  if (lastIdHeader) {
    const lastId = parseInt(lastIdHeader, 10);
    if (!isNaN(lastId)) {
      for (const entry of sseBuffer) {
        if (entry.id > lastId) {
          res.write(formatSseMessage(entry));
        }
      }
    }
  }

  sseClients.add(res);
  log("info", `SSE client connected (total: ${sseClients.size})`);

  // Send current sessions state so late-connecting clients see existing sessions
  for (const [sid, slot] of sessions) {
    if (slot.state === "running") {
      const syncEntry = formatSseMessage({
        id: sseEventId++,
        event: "session",
        data: JSON.stringify({
          state: "running",
          agent: slot.agent,
          cwd: slot.cwd,
          folderName: slot.folderName,
          sessionId: sid,
        }),
      });
      try { res.write(syncEntry); } catch { /* ignore */ }
    }
  }

  for (const [permissionId, synthetic] of codexSyntheticPermissions) {
    const syncEntry = formatSseMessage({
      id: sseEventId++,
      event: "permission-request",
      data: JSON.stringify({
        ...synthetic.payload,
        permissionId,
        sessionId: synthetic.sessionId,
      }),
    });
    try { res.write(syncEntry); } catch { /* ignore */ }
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    log("info", `SSE client disconnected (total: ${sseClients.size})`);
  });
}

// --- Hook handlers ---
// Hooks come from Claude Code instances. We match by cwd to find the session.

function resolveHookSession(body) {
  const cwd = body.session_cwd || body.cwd || null;
  const source = body.source || "claude";

  // Try exact cwd match first
  const match = findSessionByCwd(cwd);
  if (match) return match.id;

  // Fallback: if exactly one running session, use it
  const active = findMostRecentActiveSession();
  if (active) return active.id;

  // No session exists — auto-create one for this external Claude/Codex instance
  const agent = source === "codex" ? "codex" : "claude";
  const resolvedCwd = cwd || process.argv[2] || process.env.HOME || process.cwd();
  const folderName = path.basename(resolvedCwd) || resolvedCwd;
  const sessionId = crypto.randomUUID();

  const slot = {
    id: sessionId,
    agent,
    cwd: resolvedCwd,
    folderName,
    ptyProcess: null, // External process — no PTY owned by bridge
    state: "running",
    createdAt: Date.now(),
  };
  sessions.set(sessionId, slot);

  log("info", `Auto-created session ${sessionId} for external ${agent} (${folderName})`);
  pushSseEvent("session", { state: "running", agent, cwd: resolvedCwd, folderName }, sessionId);

  return sessionId;
}

async function handleHookToolOutput(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  const sid = resolveHookSession(body);
  const source = body.source || "claude";
  log("info", `Hook: ${source === "codex" ? "Codex" : "PostToolUse"} received [${source}]${sid ? ` session=${sid}` : ""}`, body.tool_name || "");
  pushSseEvent("tool-output", { ...body, source }, sid);
  return jsonResponse(res, 200, { ok: true });
}

async function handleHookPermission(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  // Disable Node.js default 5-minute requestTimeout for this long-lived blocking request.
  // The hook waits up to PERMISSION_TIMEOUT_MS (10 min) for a watch response.
  req.socket.setTimeout(0);

  const sid = resolveHookSession(body);
  const permissionId = crypto.randomUUID();
  log("info", `Hook: PermissionRequest received (id: ${permissionId})${sid ? ` session=${sid}` : ""}`, body.tool_name || "");

  if (body.permission_suggestions) {
    pendingPermissionBodies.set(permissionId, body.permission_suggestions);
  }

  pushSseEvent("permission-request", { permissionId, ...body }, sid);

  const decision = await waitForPermission(permissionId);

  log("info", `Hook: PermissionRequest resolved (id: ${permissionId}): ${decision.behavior}`);

  const hookResponse = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: decision.behavior },
    },
  };

  if (decision.updatedPermissions && decision.updatedPermissions.length > 0) {
    hookResponse.hookSpecificOutput.decision.updatedPermissions = decision.updatedPermissions;
  }

  if (decision.behavior === "deny" && decision.message) {
    hookResponse.hookSpecificOutput.decision.message = decision.message;
  }

  // For AskUserQuestion: forward the watch-selected option as the answer so Claude
  // Code doesn't fall back to waiting for terminal input.
  if (decision.selectedOption !== undefined && body.tool_name === "AskUserQuestion") {
    const questions = body.tool_input?.questions;
    if (questions && questions.length > 0 && questions[0]?.question) {
      const answers = { [questions[0].question]: decision.selectedOption };
      hookResponse.hookSpecificOutput.decision.updatedInput = { questions, answers };
      log("info", `AskUserQuestion answer forwarded: "${decision.selectedOption}"`);
    }
  }

  return jsonResponse(res, 200, hookResponse);
}

async function handleHookStop(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  const sid = resolveHookSession(body);
  log("info", `Hook: Stop received${sid ? ` session=${sid}` : ""}`);
  pushSseEvent("stop", body, sid);
  return jsonResponse(res, 200, { ok: true });
}

async function handleHookTaskComplete(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  const sid = resolveHookSession(body);
  log("info", `Hook: TaskCompleted received${sid ? ` session=${sid}` : ""}`);
  pushSseEvent("task-complete", body, sid);
  return jsonResponse(res, 200, { ok: true });
}

async function handleHookError(req, res) {
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON" });
  }

  const sid = resolveHookSession(body);
  log("info", `Hook: Error received${sid ? ` session=${sid}` : ""}`, body.error || "");
  pushSseEvent("error", body, sid);
  return jsonResponse(res, 200, { ok: true });
}

function handleStatus(_req, res) {
  const mostRecentRunningSession = findMostRecentRunningSession();
  return jsonResponse(res, 200, {
    bridgeId: BRIDGE_ID,
    sessionId: BRIDGE_ID, // backward compat
    state: bridgeState,
    availableAgents: availableAgentsList(),
    sessions: getSessionsSnapshot(),
    sseClients: sseClients.size,
    pendingPermissions: pendingPermissions.size + codexSyntheticPermissions.size,
    eventBufferSize: sseBuffer.length,
    // Backward compat: expose the most recent active session's info
    hasPty: findMostRecentActiveSession() !== null,
    activeAgent: mostRecentRunningSession?.agent || null,
  });
}

// ---------------------------------------------------------------------------
// Static PWA serving (the iPhone web app lives in ./web and is served by the
// bridge itself, so it is same-origin with the API — no CORS, token + SSE work)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  // Resolve within WEB_DIR and block path traversal.
  const filePath = path.join(WEB_DIR, path.normalize(rel));
  if (!filePath.startsWith(WEB_DIR)) {
    return jsonResponse(res, 403, { error: "Forbidden" });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return jsonResponse(res, 404, { error: "Not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Push notification routes
// ---------------------------------------------------------------------------

function handlePushKey(_req, res) {
  return jsonResponse(res, 200, { publicKey: vapidKeys ? vapidKeys.publicKey : null });
}

async function handlePushSubscribe(req, res) {
  if (!requireAuth(req)) return jsonResponse(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }
  const sub = body && body.subscription ? body.subscription : body;
  if (!sub || !sub.endpoint) return jsonResponse(res, 400, { error: "Missing subscription" });
  if (!pushSubscriptions.some((s) => s.endpoint === sub.endpoint)) {
    pushSubscriptions.push(sub);
    persistSubs();
    log("info", `Push subscription added (total: ${pushSubscriptions.length})`);
  }
  return jsonResponse(res, 200, { ok: true });
}

async function handlePushUnsubscribe(req, res) {
  if (!requireAuth(req)) return jsonResponse(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }
  const endpoint = body && (body.endpoint || (body.subscription && body.subscription.endpoint));
  if (endpoint) {
    pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
    persistSubs();
  }
  return jsonResponse(res, 200, { ok: true });
}

async function handlePushTest(req, res) {
  if (!requireAuth(req)) return jsonResponse(res, 401, { error: "Unauthorized" });
  const delivered = await sendPush("🔔 테스트 알림", "Claude Watch 알림이 정상 작동합니다!");
  return jsonResponse(res, 200, { ok: true, delivered, subscriptions: pushSubscriptions.length });
}

// ---------------------------------------------------------------------------
// Conversation routes (folder list + per-session history)
// ---------------------------------------------------------------------------

function handleFolders(req, res) {
  if (!requireAuth(req)) return jsonResponse(res, 401, { error: "Unauthorized" });
  const folders = buildFolderList().map((f) => ({
    cwd: f.cwd,
    folderName: f.folderName,
    sessionId: f.sessionId,
    title: f.title,
    lastMessage: f.lastMessage,
    lastRole: f.lastRole,
    mtime: f.mtime,
  }));
  return jsonResponse(res, 200, { folders });
}

function handleHistory(req, res) {
  if (!requireAuth(req)) return jsonResponse(res, 401, { error: "Unauthorized" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 100, 400);
  if (!sessionId) return jsonResponse(res, 400, { error: "Missing sessionId" });
  const hist = readClaudeHistory(sessionId, limit);
  if (!hist) return jsonResponse(res, 404, { error: "Session not found" });
  return jsonResponse(res, 200, hist);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {
  "POST /pair": handlePair,
  "POST /command": handleCommand,
  "GET /events": handleEvents,
  "POST /hooks/tool-output": handleHookToolOutput,
  "POST /hooks/permission": handleHookPermission,
  "POST /hooks/stop": handleHookStop,
  "POST /hooks/task-complete": handleHookTaskComplete,
  "POST /hooks/error": handleHookError,
  "GET /status": handleStatus,
  "GET /push/key": handlePushKey,
  "POST /push/subscribe": handlePushSubscribe,
  "POST /push/unsubscribe": handlePushUnsubscribe,
  "POST /push/test": handlePushTest,
  "GET /folders": handleFolders,
  "GET /history": handleHistory,
};

async function onRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;

  const handler = routes[routeKey];
  if (handler) {
    try {
      await handler(req, res);
    } catch (err) {
      log("error", `Unhandled error in ${routeKey}:`, err.message);
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: "Internal server error" });
      }
    }
  } else if (req.method === "GET") {
    // Anything not an API route is treated as a PWA asset request.
    serveStatic(req, res, url.pathname);
  } else {
    jsonResponse(res, 404, { error: "Not found" });
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve(port);
    });
  });
}

async function startServer() {
  initPersistenceAndPush();
  const server = http.createServer(onRequest);

  let boundPort = null;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      boundPort = await tryListen(server, port);
      break;
    } catch (err) {
      if (err.code === "EADDRINUSE") {
        log("warn", `Port ${port} in use, trying next...`);
        continue;
      }
      throw err;
    }
  }

  if (boundPort === null) {
    log("error", `No available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
    process.exit(1);
  }

  log("info", `Bridge server listening on 0.0.0.0:${boundPort}`);

  const code = generatePairingCode();

  // Bonjour
  bonjourInstance = new Bonjour();
  bonjourService = bonjourInstance.publish({
    name: `Agent Watch Bridge (${os.hostname()})`,
    type: "claude-watch",
    protocol: "tcp",
    port: boundPort,
    txt: {
      version: "2",
      bridgeId: BRIDGE_ID,
      sessionId: BRIDGE_ID, // backward compat
      machineName: os.hostname(),
    },
  });

  log("info", `Bonjour advertising _claude-watch._tcp on port ${boundPort}`);
  startCodexMonitor();
  startClaudeMonitor();

  const agents = [];
  if (CLAUDE_BIN) agents.push("Claude");
  if (CODEX_BIN) agents.push("Codex");
  log("info", `Bridge ready. Available agents: ${agents.join(", ") || "none"}. Sessions spawn on demand.`);

  // Get LAN IP
  const interfaces = os.networkInterfaces();
  let lanIP = "127.0.0.1";
  for (const [, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        lanIP = addr.address;
        break;
      }
    }
    if (lanIP !== "127.0.0.1") break;
  }

  const agentLine = agents.length ? agents.join(" + ") : "none";
  console.log("");
  console.log("╔═══════════════════════════════════════╗");
  console.log("║        AGENT WATCH BRIDGE             ║");
  console.log("╠═══════════════════════════════════════╣");
  console.log(`║  Pairing Code:  ${code}                ║`);
  console.log(`║  IP Address:    ${lanIP.padEnd(20)}║`);
  console.log(`║  Port:          ${String(boundPort).padEnd(20)}║`);
  console.log(`║  Agents:        ${agentLine.padEnd(20)}║`);
  console.log("╚═══════════════════════════════════════╝");
  console.log("");

  // --- Graceful shutdown ---

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `Received ${signal}, shutting down gracefully...`);

    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();

    // Kill all session PTYs
    for (const [id, slot] of sessions) {
      if (slot.ptyProcess) {
        try { slot.ptyProcess.kill(); } catch { /* ignore */ }
        log("info", `Killed session ${id} (${slot.agent})`);
      }
    }
    sessions.clear();
    stopCodexMonitor();
    stopClaudeMonitor();

    if (bonjourService) {
      try { bonjourInstance.unpublishAll(); } catch { /* ignore */ }
    }
    if (bonjourInstance) {
      try { bonjourInstance.destroy(); } catch { /* ignore */ }
    }

    for (const [id, pending] of pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", reason: "Server shutting down" });
    }
    pendingPermissions.clear();

    server.close(() => {
      log("info", "Server closed");
      process.exit(0);
    });

    setTimeout(() => {
      log("warn", "Forced exit after timeout");
      process.exit(1);
    }, 5000);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, port: boundPort };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

startServer().catch((err) => {
  log("error", "Failed to start server:", err.message);
  process.exit(1);
});
