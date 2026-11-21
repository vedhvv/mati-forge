---
name: forge-review
description: Review pending Mati Forge notes one at a time and turn approved ones into rules. Use when the user asks to "review my Forge notes", "review Forge", or similar.
---

# Review Forge notes

Go through the user's pending Forge notes one at a time. For each one, suggest a failure type and a one-line rule, and let the user approve, edit, reject or skip it. Nothing becomes a rule unless the user approves it.

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
   - **Link to an existing rule**: call `approve_rule` with the refs and `rule_id`, no rule text.
   - **Repeat of a rule** (the user confirms): call `approve_rule` with the refs, `rule_id` and `repeat` true. If the rule clearly needs rewording because it did not prevent the repeat, say so; editing rules comes in a later version.
   - **Reject**: call `reject_entry` with the refs. The note is kept, marked rejected.
   - **Skip**: call `review_next` again with `skip` listing every ref skipped so far in this review.
6. Repeat from step 1 until nothing is left or the user wants to stop. At the end, say how many rules were saved and that "show my Forge rules" lists them.

## Writing the rule

- One line, plain words, an instruction to Claude. Specific to the task type, not general advice.
- `wrong_direction`: say what to ask or confirm **before starting**, for example "Before a pitch deck, confirm the audience, the ask and the slide count."
- `helper_misfire`: say how to **brief or check helper agents**, for example "When using helpers for research, give each one the purpose and the format needed, and check their sources before using the result."
- Other types: say what to do or avoid next time.
- Leave out people's names, company names, contact details and figures.
- Use the task type as written in the item. Reuse a type from "Task types already in use" rather than inventing a near-duplicate. Use `any` only for a rule that truly applies to every task.
- Scope: keep the item's scope. If the rule mixes personal and work items, use `work`.

## Rules for this review

- Never call `approve_rule` or `reject_entry` without the user's explicit answer for that item.
- The user's answers during a review are review decisions, not corrections. Do not call `log_failure` for them.
- When showing "show my Forge notes" or "show my Forge rules", show the tool's text exactly as returned.
