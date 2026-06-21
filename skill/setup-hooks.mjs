#!/usr/bin/env node
// Agent Watch — cross-platform hook installer (Windows / macOS / Linux).
//
// Writes HTTP hooks into ~/.claude/settings.json so every Claude Code session
// streams its events to the local bridge. This is the Node replacement for
// setup-hooks.sh (which needs bash + python3 and does not run on Windows).
//
// Usage:
//   node setup-hooks.mjs [port]      install (default port 7860)
//   node setup-hooks.mjs --remove    remove the Agent Watch hooks

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const arg = process.argv[2];
const isRemove = arg === "--remove";
const port = !isRemove && arg ? arg : "7860";
const BRIDGE_URL = `http://127.0.0.1:${port}`;
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

// A hook entry belongs to Agent Watch if any of its hooks points at our /hooks/ routes.
function isWatchHook(entry) {
  return (entry.hooks || []).some(
    (h) =>
      typeof h.url === "string" &&
      h.url.startsWith("http://127.0.0.1:") &&
      h.url.includes("/hooks/")
  );
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
}

// ── Remove mode ──────────────────────────────────────────────────────────────
if (isRemove) {
  if (!fs.existsSync(SETTINGS)) {
    console.log(`No settings file at ${SETTINGS}`);
    process.exit(0);
  }
  const settings = loadSettings();
  const hooks = settings.hooks || {};
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const filtered = hooks[event].filter((entry) => !isWatchHook(entry));
    if (filtered.length !== hooks[event].length) {
      changed = true;
      if (filtered.length) hooks[event] = filtered;
      else delete hooks[event];
    }
  }
  if (changed) {
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    else settings.hooks = hooks;
    saveSettings(settings);
    console.log(`Agent Watch hooks removed from ${SETTINGS}`);
  } else {
    console.log("No Agent Watch hooks found.");
  }
  process.exit(0);
}

// ── Install mode ─────────────────────────────────────────────────────────────
console.log("Installing Agent Watch hooks...");
console.log(`  Bridge URL: ${BRIDGE_URL}`);
console.log(`  Settings:   ${SETTINGS}`);
console.log("");

const newHooks = {
  PostToolUse: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/tool-output`, timeout: 5 }] }],
  PreToolUse: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/tool-output`, timeout: 5 }] }],
  PermissionRequest: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/permission`, timeout: 600 }] }],
  Stop: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/stop`, timeout: 5 }] }],
  PostToolUseFailure: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/error`, timeout: 5 }] }],
  StopFailure: [{ hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/error`, timeout: 5 }] }],
  Notification: [
    {
      matcher: "idle_prompt|permission_prompt",
      hooks: [{ type: "http", url: `${BRIDGE_URL}/hooks/stop`, timeout: 5 }],
    },
  ],
};

const settings = loadSettings();
const existing = settings.hooks || {};

for (const [event, entries] of Object.entries(newHooks)) {
  if (!existing[event]) existing[event] = [];
  // Drop any previous Agent Watch hooks for this event, then add fresh ones.
  existing[event] = existing[event].filter((entry) => !isWatchHook(entry));
  existing[event].push(...entries);
}
settings.hooks = existing;
saveSettings(settings);

console.log("Hooks installed successfully!");
console.log("");
console.log("Events hooked:");
for (const e of Object.keys(newHooks)) console.log(`  • ${e}`);
console.log("");
console.log("Next:");
console.log("  1. Start the bridge:  node skill/bridge/server.js");
console.log("  2. Use Claude Code normally — events auto-forward to the bridge.");
console.log("");
console.log("Remove later with:  node skill/setup-hooks.mjs --remove");
