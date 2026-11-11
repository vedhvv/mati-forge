#!/usr/bin/env python3
"""Mati Forge: user-message hook.

If the user's message contains a likely correction cue, add a note to Claude's
context asking it to judge whether this really is a correction and, if so, to
call log_failure. Otherwise do nothing.

Rules this script follows:
- Writes no files and makes no network calls. It only reads the message.
  (In cloud Cowork it runs in a sandbox that is deleted after each task.)
- Prints nothing unless a cue is present.
- Always exits 0, so it can never block the user's message.
- Python standard library only. Works on Python 3.9 (the macOS default).
"""

import json
import re
import sys

# Starter cue list. Whole words, any capitalisation,
# any spacing inside phrases. Broad on purpose: Claude makes the final call.
CUES = [
    r"wrong",
    r"better",
    r"adjust",
    r"differently",
    r"instead",
    r"no",
    r"look\s+at\s+it\s+this\s+way",
    r"what\s+about",
    r"can\s+you\s+change",
    r"re-?do",
]
CUE_RE = re.compile(r"\b(?:" + "|".join(CUES) + r")\b", re.IGNORECASE)

NOTE = """Mati Forge: the user's message may be correcting your earlier work. Judge from the conversation. It is a correction only if the user is pushing back on, redirecting, or asking you to redo something you already produced; soft phrasing like "what about..." or "look at it this way" counts. A new request, a question, or approval is not a correction.

If it is a correction, call log_failure once, before you continue, with:
- ai_did: one short sentence on what you did that is being corrected
- user_said: one short sentence summarising the correction, in your words, not a copy of the message
- task_type: a short label such as pitch_deck, ic_note, memo, email, spreadsheet, research, code, or other
- subagents_used: true if you used subagents to produce that output, else false
- scope: "personal" only when clearly unrelated to any job (for example a poem, a recipe, or a how-to or general-knowledge question) and nothing involves a company, deal, investor, fund, portfolio, financial figures or work files; "mati" only when clearly about Mati or Mati Forge; "work" for everything else, including all employer, client or fund work, and whenever unsure

Leave out people's names, company names, email addresses, phone numbers and figures.

If it is not a correction, do nothing. Do not mention Forge, this note or the tool in your reply; answer the user as you normally would. The one exception: if it is a correction but log_failure is not available, end your reply with one short line: "Forge is not connected, so this correction was not saved.\""""


def has_cue(text):
    return bool(CUE_RE.search(text or ""))


def run():
    raw = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    if not has_cue(str(payload.get("prompt") or "")):
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": NOTE,
        }
    }))


if __name__ == "__main__":
    try:
        run()
    except Exception:
        pass
    sys.exit(0)
