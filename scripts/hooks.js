#!/usr/bin/env node
'use strict';
// Adds or removes the Hub's two hooks and its status line in ~/.claude/settings.json,
// keeping everything else.
//   node hooks.js install   <settings.json>
//   node hooks.js uninstall <settings.json>
// Notification (approval needed / waiting for you) and Stop (a reply finished) post the
// event to the Hub on 127.0.0.1. They run in the background and never block Claude.
// The status line sends the Hub your plan usage (5-hour and weekly %) and prints nothing.
// It is only added when you don't already have a status line of your own.

const fs = require('node:fs');

const [action, file] = process.argv.slice(2);
if (!['install', 'uninstall'].includes(action) || !file) {
  console.error('Usage: node hooks.js install|uninstall <settings.json>');
  process.exit(2);
}

const MARK = '127.0.0.1:4517/api/event';
const COMMAND = "curl -s -m 2 -X POST -H 'x-sessions: 1' -H 'content-type: application/json' --data-binary @- http://" + MARK + ' >/dev/null 2>&1 || true';
const WANT = {
  Notification: { matcher: 'permission_prompt|idle_prompt', hooks: [{ type: 'command', command: COMMAND, async: true }] },
  Stop: { hooks: [{ type: 'command', command: COMMAND, async: true }] },
};

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch (err) {
      console.error(`${file} has a formatting error, so it was left alone: ${err.message}`);
      process.exit(1);
    }
  }
}

const STATUS = { type: 'command', command: "curl -s -m 1 -X POST -H 'x-sessions: 1' -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4517/api/statusline >/dev/null 2>&1; true", padding: 0 };
const ourStatus = (x) => !!(x && String(x.command || '').includes('127.0.0.1:4517/api/statusline'));
const ours = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARK));
settings.hooks = settings.hooks || {};
let changed = false;

for (const [event, group] of Object.entries(WANT)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = list.filter((g) => !ours(g));
  if (action === 'install') {
    if (kept.length === list.length) changed = true;
    settings.hooks[event] = [...kept, group];
  } else {
    if (kept.length !== list.length) changed = true;
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

let statusNote = '';
if (action === 'install') {
  if (!settings.statusLine) { settings.statusLine = STATUS; changed = true; }
  else if (!ourStatus(settings.statusLine)) statusNote = 'You already have a status line, so it was left alone. Usage still shows from replies in the Hub.';
} else if (ourStatus(settings.statusLine)) { delete settings.statusLine; changed = true; }

if (changed) {
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(action === 'install' ? 'Added the Hub hooks to Claude Code settings.' : 'Removed the Hub hooks from Claude Code settings.');
} else {
  console.log(action === 'install' ? 'Claude Code hooks were already set up.' : 'No Hub hooks to remove.');
}
if (statusNote) console.log(statusNote);
