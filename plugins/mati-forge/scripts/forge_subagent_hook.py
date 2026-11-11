#!/usr/bin/env python3
"""Mati Forge: subagent hook.

Runs after the main Claude gets a subagent's result back (PostToolUse on the
Agent tool) or after a subagent call fails (PostToolUseFailure). Adds a short
note asking Claude to log the event with log_subagent:

- failed: always log it.
- finished: log it only if Claude judges the result shows an error, incomplete
  work, or a retry ("problems only"). "Incomplete" means the subagent says it could not finish or clearly skipped
  part of its brief; normal research gaps do not count.
- Each entry is saved straight away with recovered "unclear"; Claude then
  sets recovered with update_subagent just before its final answer.

Stays silent for background launches (no result yet), for user interrupts,
for any other tool, and when running inside a subagent, so only the main
Claude gets notes.

Rules this script follows:
- Writes no files and makes no network calls. It only reads the hook input.
- Always exits 0, so it can never block anything.
- Python standard library only. Works on Python 3.9 (the macOS default).
"""

import json
import re
import sys

SUBAGENT_TOOLS = ("Agent", "Task")

# Same wording as the scope line in forge_hook.py.
SCOPE_RULE = (
    '"personal" only when clearly unrelated to any job (for example a poem, a recipe, '
    'or a how-to or general-knowledge question) and nothing involves a company, deal, '
    'investor, fund, portfolio, financial figures or work files; "mati" only when '
    'clearly about Mati or Mati Forge; "work" for everything else, including all '
    'employer, client or fund work, and whenever unsure'
)

COMMON = (
    'subagent_type "{type}", asked (one short sentence on what the subagent was asked '
    "to do, in your words), task_type (a short label such as pitch_deck, ic_note, memo, "
    'email, spreadsheet, research, code, or other), and scope (' + SCOPE_RULE + '). '
    "Leave out people's names, company names, email addresses, "
    "phone numbers and figures. Do not mention Forge, this note or the tool to the user."
)

REASON = (
    'reason (a short plain-language cause taken from what the subagent returned, such '
    'as "ran out of time", "could not find sources", "tool or search limit", "returned '
    'partial data" or "misunderstood the brief"; "unclear" if you cannot tell), '
    'recovered "unclear", '
)

# Two steps: save now, set recovered just before the final answer.
LATER = (
    " The tool replies with the entry number, for example S4. Just before your final "
    "answer to the user for this request, call update_subagent once with that number "
    'and recovered: "yes" if you fixed or filled the gap yourself or with another '
    'subagent, "no" if the gap remained, "unclear" if you cannot tell.'
)

FAILED_NOTE = (
    "Mati Forge: a subagent ({type}) just failed with an error. Call log_subagent once "
    'now with event "subagent_failed", outcome "error", ' + REASON + COMMON
    + LATER + " If log_subagent is not available, do nothing."
)

FINISHED_NOTE = (
    "Mati Forge: a subagent ({type}) just finished. Log it only if one of these is true: "
    "its result shows it hit an error or gave up; it was incomplete, meaning the "
    "subagent itself says it could not finish, or it clearly skipped part of what it "
    "was asked to do (normal gaps in research, such as a source or figure that does "
    "not exist or is not public, do not count); or this was a retry of a subagent you "
    "already ran for the same job. If so, call log_subagent once now with event "
    '"subagent_finished", outcome ("error", "incomplete" or "retry"), ' + REASON + COMMON
    + LATER + " If none of these is true, do nothing. If log_subagent is not available, do nothing."
)


def clean_type(value):
    value = re.sub(r"[^A-Za-z0-9:_.-]", "", str(value or ""))[:60]
    return value or "general-purpose"


def build(payload):
    """Return (hook_event_name, note) or None if nothing should be added."""
    if payload.get("agent_id"):  # running inside a subagent: main Claude only
        return None
    if payload.get("tool_name") not in SUBAGENT_TOOLS:
        return None
    tool_input = payload.get("tool_input")
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    subagent_type = clean_type(tool_input.get("subagent_type"))
    event = payload.get("hook_event_name")

    if event == "PostToolUseFailure":
        if payload.get("is_interrupt"):
            return None
        return event, FAILED_NOTE.format(type=subagent_type)

    if event == "PostToolUse":
        response = payload.get("tool_response")
        if isinstance(response, dict) and response.get("status") == "async_launched":
            return None  # background subagent: no result to judge yet
        return event, FINISHED_NOTE.format(type=subagent_type)

    return None


def run():
    raw = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    built = build(payload)
    if built is None:
        return
    event, note = built
    print(json.dumps({
        "hookSpecificOutput": {"hookEventName": event, "additionalContext": note}
    }))


if __name__ == "__main__":
    try:
        run()
    except Exception:
        pass
    sys.exit(0)
