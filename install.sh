#!/bin/sh
# Installs the Hub for the person running it. Safe to run again.
#   ./install.sh            install and open the Hub
#   ./install.sh --no-open  install without opening the browser
# It changes three things, each backed up first:
#   ~/.local/bin/claude-hub   the command that starts and opens the Hub
#   ~/.zshrc                  typing `claude` also starts the Hub
#   ~/.claude/settings.json   two hooks so the Hub knows when Claude needs you
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BIN="$HOME/.local/bin"
SETTINGS="$HOME/.claude/settings.json"
ZSHRC="$HOME/.zshrc"

say() { printf '%s\n' "$*"; }

if [ "$(uname)" != "Darwin" ]; then
  say "The Hub only works on a Mac."
  exit 1
fi

NODE="$(command -v node || true)"
for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"; done
if [ -z "$NODE" ]; then
  say "The Hub needs Node.js (free). Opening the download page now."
  say "Install the LTS version, then run ./install.sh again."
  open "https://nodejs.org/en/download"
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "The Hub needs Node.js 18 or newer (this Mac has $("$NODE" --version)). Update it from https://nodejs.org, then run ./install.sh again."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  say "Note: Claude Code isn't installed yet. The Hub shows Claude Code chats, so install it first:"
  say "  curl -fsSL https://claude.ai/install.sh | bash"
  say ""
fi

# 1. The claude-hub command.
mkdir -p "$BIN"
sed -e "s|__APP_DIR__|$DIR|" -e "s|__NODE__|$NODE|" "$DIR/bin/claude-hub" > "$BIN/claude-hub"
chmod 755 "$BIN/claude-hub"
say "Added the claude-hub command."

# 2. Typing `claude` also starts the Hub (and opens it if it wasn't running).
MARK_START="# >>> claude-hub >>>"
MARK_END="# <<< claude-hub <<<"
touch "$ZSHRC"
if grep -qF "$MARK_START" "$ZSHRC"; then
  say "Your shell is already set up."
else
  cp "$ZSHRC" "$ZSHRC.bak-claude-hub-$STAMP"
  # Make sure the block starts on its own line.
  [ -s "$ZSHRC" ] && [ -n "$(tail -c1 "$ZSHRC")" ] && echo >> "$ZSHRC"
  cat >> "$ZSHRC" <<'EOF'
# >>> claude-hub >>>
# Typing `claude` also makes sure the Hub is running. The page opens only when the Hub
# was not already running. Scripted runs (-p, --print, --version, --help) skip it.
# Remove this block (or run uninstall.sh) to turn it off.
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
claude() {
  case " $* " in
    *" -p "*|*" --print "*|*" -v "*|*" --version "*|*" -h "*|*" --help "*) ;;
    *)
      if ! curl -s -o /dev/null --max-time 0.3 http://127.0.0.1:4517/api/ping 2>/dev/null; then
        ( "$HOME/.local/bin/claude-hub" >/dev/null 2>&1 & ) 2>/dev/null
      fi
      ;;
  esac
  command claude "$@"
}
# <<< claude-hub <<<
EOF
  say "Set up your shell (backup: $ZSHRC.bak-claude-hub-$STAMP)."
fi

# 3. Hooks: Claude tells the Hub when it needs approval, is waiting, or finishes a reply.
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-claude-hub-$STAMP"
"$NODE" "$DIR/scripts/hooks.js" install "$SETTINGS"

# 4. Optional: voice typing (Apple Silicon only). Runs on this Mac, nothing is sent anywhere.
if [ "$(uname -m)" = "arm64" ]; then
  if command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ] || [ -x /opt/homebrew/bin/uv ]; then
    say "Voice typing is ready (the speech model downloads the first time you use the mic)."
  else
    say "Voice typing is optional and needs a small free tool called uv."
    say "To add it later, run: curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
fi

say ""
say "Done. Bookmark http://127.0.0.1:4517"
say "From now on, typing claude in Terminal also opens the Hub."
say "Open a new Terminal window first so the change takes effect."

if [ "$1" != "--no-open" ]; then
  "$BIN/claude-hub" >/dev/null
fi
