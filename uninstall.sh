#!/bin/sh
# Removes the Hub's command, shell block and hooks. Your chats are never touched.
# The Hub's own notes and reminders stay in ~/.session-dashboard unless you delete that folder.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ZSHRC="$HOME/.zshrc"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -x "$HOME/.local/bin/claude-hub" ] && "$HOME/.local/bin/claude-hub" stop >/dev/null 2>&1 || true
rm -f "$HOME/.local/bin/claude-hub"
echo "Removed the claude-hub command."

if [ -f "$ZSHRC" ] && grep -qF "# >>> claude-hub >>>" "$ZSHRC"; then
  cp "$ZSHRC" "$ZSHRC.bak-claude-hub-$STAMP"
  awk '/^# >>> claude-hub >>>$/{skip=1} !skip{print} /^# <<< claude-hub <<<$/{skip=0}' "$ZSHRC.bak-claude-hub-$STAMP" > "$ZSHRC"
  echo "Removed the shell block (backup: $ZSHRC.bak-claude-hub-$STAMP)."
fi

if [ -f "$HOME/.claude/settings.json" ] && command -v node >/dev/null 2>&1; then
  node "$DIR/scripts/hooks.js" uninstall "$HOME/.claude/settings.json"
fi

echo "Done. Open a new Terminal window for it to take effect."
