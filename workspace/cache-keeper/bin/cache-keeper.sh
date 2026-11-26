#!/bin/sh
# The Node check: every hook command enters here and runs cache-keeper.ts only
# under a `node` on PATH that runs .ts (22.18 or later); without one the hooks
# do nothing and exit 0. At session start it then says so in every session, and
# once per machine asks the model to offer setting Node up. Keeper turned off
# (`"enabled": false` or CTX_KEEPER_DISABLED=1) stays silent.

# WORKAROUND: Claude Code brings no Node of its own (the native install is one binary)
# and `/plugin install` checks none, so a missing or old one would fail without a word.
v=$(node --version 2>/dev/null </dev/null) || v=
major= minor= patch=
case $v in
  v[0-9]*.[0-9]*.[0-9]*)
    rest=${v#v}
    major=${rest%%.*}
    rest=${rest#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    patch=${patch%%[!0-9]*}
    case $major in ''|*[!0-9]*) major= ;; esac
    case $minor in ''|*[!0-9]*) major= ;; esac
    ;;
esac

ok=
if [ -n "$major" ]; then
  if [ "$major" -ge 24 ]; then ok=1
  elif [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; then ok=1
  elif [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; then ok=1
  fi
fi

if [ -n "$ok" ]; then
  if [ "$1" = check ]; then
    input=$(cat)
    printf '%s' "$input" | tr -d '\n\r' | grep -Eq '"source"[[:space:]]*:[[:space:]]*"compact"' || exit 0
    printf '%s' "$input" | node --disable-warning=ExperimentalWarning "$(dirname "$0")/cache-keeper.ts" compacted-start
    exit 0
  fi
  exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/cache-keeper.ts" "$@"
fi

[ "$1" = check ] || exit 0

# INVARIANT: reads "off" as src/config.ts does (env first, trimmed, any case, and it turns keeper back on over the file;
# else a top-level "enabled" of false/"false"/"no"/"off"/"0"); nested objects are cut out first (handoff's own "enabled").
lower() { printf '%s' "$1" | tr -d ' \t' | tr '[:upper:]' '[:lower:]'; }
home=$(lower "${CTX_KEEPER_HOME:-}")
home=${home:+$CTX_KEEPER_HOME}
home=${home:-$HOME/.claude-ctx/keeper}
case $(lower "${CTX_KEEPER_DISABLED:-}") in
  1|true|yes|on) exit 0 ;;
  0|false|no|off) ;;
  *)
    if [ -r "$home/config.json" ] &&
      tr -d '\n\r' < "$home/config.json" |
        sed -e ':a' -e 's/\[[^][]*\]/0/' -e 'ta' -e ':b' -e 's/\({[^{}]*\){[^{}]*}/\10/' -e 'tb' |
        grep -Eiq '"enabled"[[:space:]]*:[[:space:]]*(false|"(false|no|off|0)")'; then
      exit 0
    fi
    ;;
esac

if [ -z "$v" ]; then found='found none' kind=none
elif [ -z "$major" ]; then found='and node --version printed no version' kind=garbled
else found="found v$major.$minor.$patch" kind=old
fi
problem="cache-keeper is off: it needs Node.js 22.18 or later on PATH, $found"
human="$problem. To fix it, ask Claude: set up Node 22.18 for cache-keeper."

fresh=
cat | tr -d '\n\r' | grep -Eq '"source"[[:space:]]*:[[:space:]]*"startup"' && fresh=1
case ${CLAUDE_CODE_ENTRYPOINT:-} in sdk-*) fresh= ;; esac

asked="$home/node-asked"
note=
if [ -n "$fresh" ] && ! grep -qx "$kind" "$asked" 2>/dev/null; then
  if mkdir -p "$home" 2>/dev/null && printf '%s\n' "$kind" >> "$asked" 2>/dev/null; then
    note="The Claude Code plugin cache-keeper is installed but cannot run: $problem. Do not interrupt the task the user came with: first handle their first request, then, at the end of that reply, ask once with AskUserQuestion whether to set up Node now (options: Set up Node now / Not now). If they agree: use the version or package manager already on this machine (nvm, fnm, volta, asdf, mise, Homebrew, winget, apt and the like), keep the other Node versions, make the node that Claude Code hooks find on PATH resolve to 22.18 or later (the manager's default, not just this shell), show node --version, and tell them to restart Claude Code. If they decline, do not raise it again. This note is given once per machine."
  fi
fi

if [ -n "$note" ]; then
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$human" "$note"
else
  printf '{"systemMessage":"%s"}\n' "$human"
fi
exit 0
