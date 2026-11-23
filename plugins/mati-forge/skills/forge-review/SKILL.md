---
name: forge-review
description: Review pending Mati Forge notes one at a time and turn approved ones into rules, keep, drop, reword or restore a Forge rule, show the Forge report, or export Forge rules. Use when the user asks to "review my Forge notes", "show my Forge report", "export my Forge rules", "monthly Forge report", "keep R4", "drop R7", "reword R3", or similar.
---

# Review Forge notes

Most corrections are filed automatically: when one is logged, Claude drafts a provisional rule, marks it as a repeat of an existing rule, or replaces a rule it contradicts. Provisional rules are used straight away, and the user can keep, drop or reword them at any time.

The review covers what is left: corrections Claude judged one-off fixes, corrections it could not file, and subagent problems on their own. Go through them one at a time. For each one, suggest a failure type and a one-line rule, and let the user approve, edit, reject or skip it. A rule saved in a review is active straight away.

## Steps

1. Call `review_next`. If it says nothing is left, tell the user and stop.
2. Show the item in a few short lines: when, task type, what Claude did, what the user said, and any likely cause it lists.
3. Suggest:
   - **Failure type**, from the list in `approve_rule`. Prefer `wrong_direction` when Claude misread the intent or scope of the task, and `helper_misfire` when a subagent failed, stalled or gave weak work that affected the result. A correction listed with a likely-cause subagent entry is usually `helper_misfire`, unless the subagent was fine and Claude itself misread the task.
   - **One-line rule**, written as an instruction to Claude for that task type (see "Writing the rule").
   - If an existing rule in the item already says the same thing, offer to link this note to it instead of making a near-copy.
   - If the item says "Repeated after rule" or "Possible repeat of", ask whether this mistake repeated that rule. A repeat means the rule existed and the mistake happened anyway.
4. Ask: **Approve, edit, reject, or skip?** Then wait for the answer.
5. Act on the answer:
   - **Approve**: call `approve_rule` with every ref the item lists ("Refs for a decision"), the rule word for word as shown, the task type, the failure type and the scope.
   - **Edit**: use the user's wording. If you had to rephrase their edit, show the final line and ask again before saving.
   - **Link to an existing rule**: call `approve_rule` with the refs and `rule_id`, no rule text. If that rule was provisional, it becomes active.
   - **Repeat of a rule** (the user confirms): call `approve_rule` with the refs, `rule_id` and `repeat` true. If the rule clearly needs rewording because it did not prevent the repeat, offer a new wording and, if the user agrees, save it with `update_rule` (see "Changing a rule").
   - **Reject**: call `reject_entry` with the refs. The note is kept, marked rejected.
   - **Skip**: call `review_next` again with `skip` listing every ref skipped so far in this review.
6. Repeat from step 1 until nothing is left or the user wants to stop. At the end, say how many rules were saved and that "show my Forge rules" lists them.

## Changing a rule

When the user asks to keep, drop, reword or restore a rule (for example "keep R4", "drop R7"), call `update_rule` with the rule number and the action.

- **keep**: a provisional rule becomes active.
- **drop**: the rule stops being used and is kept on file. If it had replaced an older rule, the older rule comes back; say so.
- **reword**: show the final line and get the user's OK before saving. The rule becomes active.
- **restore**: a dropped rule is used again.

Only act on the user's own request for that rule. Afterwards, "show my Forge rules" lists what is in use.

## Forge report

When the user asks for their Forge report, or says yes to the weekly offer, call `get_report` (`period` "month" if they ask for the monthly one) and show its text exactly as returned.

- After it, for each rule listed under "Rules that keep repeating", you may suggest one new wording. Save it with `update_rule` reword only if the user agrees.
- If the user answers about the new rules: "keep all" means call `update_rule` keep for each rule listed under "New rules Claude drafted"; "drop R20" or "reword R20" means that rule only. No answer is fine: those rules are kept automatically on the date shown.
- Answers about the report are decisions, not corrections. Do not call `log_failure` for them.

## Export rules

When the user asks to export or copy their Forge rules (for example to paste into ChatGPT, Cursor or another Claude account), call `export_rules` and show its text exactly as returned. Rules tagged work are never exported; if the user asks for them, say so, and do not copy them out another way (for example from "show my Forge rules").

## Writing the rule

- One line, plain words, an instruction to Claude. Specific to the task type, not general advice.
- `wrong_direction`: say what to ask or confirm **before starting**, for example "Before a pitch deck, confirm the audience, the ask and the slide count."
- `helper_misfire`: say how to **brief or check helper agents**, for example "When using helpers for research, give each one the purpose and the format needed, and check their sources before using the result."
- Other types: say what to do or avoid next time.
- Leave out people's names, company names, contact details and figures.
- Use the task type as written in the item. Reuse a type from "Task types already in use" rather than inventing a near-duplicate. Use `any` only for a rule that truly applies to every task.
- Scope: keep the item's scope. If the rule mixes personal and work items, use `work`.

## Rules for this review

- Never call `approve_rule`, `reject_entry` or `update_rule` without the user's explicit answer for that item.
- The user's answers during a review are review decisions, not corrections. Do not call `log_failure` for them.
- When showing "show my Forge notes" or "show my Forge rules", show the tool's text exactly as returned.
