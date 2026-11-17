# Claude Hub

One page in your browser for all your Claude Code chats. You don't need a pile of Terminal windows anymore.

- **Every chat in one list**, newest first, searchable. Your existing Claude Code chats show up on their own. Nothing to import.
- **Reply from the page.** Closed chats answer in the background, so you can close Terminal windows without losing anything.
- **Today page:** what needs you right now, plus dates and deadlines found in your chats ("board meeting Thursday", "renew by Nov 28"). One click turns them into reminders.
- **Reminders** with Mac notifications. Type them in plain words: "fri 3pm call the bank", "in 2h send the notes".
- **Alerts** when Claude needs your approval or finishes a long reply.
- **Context:** how full each chat's memory is, and a one-click hand-off to a fresh chat when it gets too full.
- **Voice typing** (optional, Apple Silicon Macs). Hold Space to talk. It runs on your Mac and nothing is sent anywhere.

It shows chats from Claude Code, the Terminal version of Claude. Chats from the Claude desktop or web app aren't stored on your Mac, so they don't appear.

## Install (about 2 minutes, once)

You need a Mac, Claude Code, and [Node.js](https://nodejs.org) 18 or newer (the free LTS download). If you don't have Claude Code yet, paste this into Terminal:

```
curl -fsSL https://claude.ai/install.sh | bash
```

1. On this page, click **Code**, then **Download ZIP**, and unzip it somewhere you'll keep it, such as your Documents folder. (Or `git clone` it.)
2. Open Terminal and type `cd ` (with a space), drag the unzipped folder onto the Terminal window, and press Return.
3. Run:

   ```
   sh install.sh
   ```

The Hub opens in your browser. Bookmark it: http://127.0.0.1:4517

From then on, typing `claude` in Terminal also opens the Hub if it isn't already running. Open a new Terminal window once after installing so this takes effect.

**The first time you use a few features, your Mac asks for permission.** Say OK:
- "Go to tab" and "Open in Terminal" ask to control Terminal.
- Reminders and alerts ask to show notifications.
- Voice typing asks for the microphone.

## Everyday use

- Type `claude` in Terminal like before, or click **New chat** in the Hub.
- Open the Hub any time from your bookmark, or type `claude-hub` in Terminal.
- `claude-hub stop` stops it. It starts again the next time you type `claude`.

## Optional: tags

To color-code chats by topic, add tags to `~/.session-dashboard/config.json`, or ask Claude to do it for you ("add a Hub tag called Board for chats about the board"). Example:

```json
{ "tags": [ { "name": "Board", "match": "board|investor|quarterly", "color": "#2f6fdd" } ] }
```

## What it changes on your Mac

The installer backs up each file before changing it:

- Adds the `claude-hub` command in `~/.local/bin`.
- Adds a short block to `~/.zshrc` so typing `claude` also starts the Hub.
- Adds two hooks to `~/.claude/settings.json` so Claude can tell the Hub when it needs you.

The Hub only listens on your own Mac (127.0.0.1), reads your Claude Code history without changing it, and keeps its own notes and reminders in `~/.session-dashboard`.

## Uninstall

```
sh uninstall.sh
```

Removes the command, the shell block and the hooks. Your chats are never touched. To also remove the Hub's notes and reminders, delete the `~/.session-dashboard` folder.

## Updating

Download the new version, replace the folder, and run `sh install.sh` again. Your reminders and notes stay.
