# Mati Forge

Mati Forge quietly notes the moments you correct Claude, so you can see later where it keeps getting things wrong. It also notes subagents that fail, return unfinished work, or have to be re-run. Each correction becomes a short rule you can keep or drop, Claude is reminded of the right rules at the start of similar tasks, and a weekly report shows whether the mistakes stop coming back.

Mati Forge is an early, free, open-source project (MIT license). Everything stays on your computer.

## What it captures

When one of your messages looks like a correction ("no", "instead", "can you change", "redo" and similar), Claude decides whether it really is one. If it is, Claude saves a short note:

- what Claude did
- what you asked for instead, in Claude's own words
- the kind of task (email, memo, research and so on)
- whether subagents were involved
- a label: **personal**, **work**, or **mati** (about Mati Forge itself). Anything work-related or unclear is labelled **work**.

Notes are short summaries, never copies of your conversation. Claude is told to leave out names, company names, contact details and figures, and Forge also removes email addresses, phone numbers and similar numbers before saving.

Claude does not mention Forge in its replies. You may see a small line such as "used Mati Forge integration" when a note is saved.

## Where your data goes

- Notes are stored only on your computer, in a folder called `MatiForge` in your home folder (`~/MatiForge` on Mac, `C:\Users\<you>\MatiForge` on Windows).
- Forge makes no network calls and sends nothing to anyone, including the author.
- Your conversations are still processed by Claude as usual. Forge keeps no copy of them.
- Rules labelled **work** are never included when you export your rules.

## Install

You need the Claude desktop app, open, with Cowork. Forge has two parts, and you need both.

**1. The plugin** (notices corrections)

1. In Claude, open **Customize > Plugins**, choose **Add marketplace**, and enter `vedhvv/mati-forge`.
2. Find **Mati Forge** in the list and click **Install**.

If **Add marketplace** fails, download `mati-forge-<version>.zip` from the [latest release](https://github.com/vedhvv/mati-forge/releases/latest) instead, and use **Customize > Plugins > Upload plugin**.

**2. The desktop extension** (saves and shows your notes)

1. Download `mati-forge-extension-<version>.mcpb` from the [latest release](https://github.com/vedhvv/mati-forge/releases/latest).
2. Double-click it, or in Claude go to **Settings > Extensions > Advanced settings > Install Extension...** and choose the file.
3. Review and click **Install**.

**3. Restart Claude** (quit fully, then reopen).

## See your notes

In any Cowork task, ask: **show my Forge notes**

You can also ask for only corrections, only subagent notes, or only one label, for example "show my personal Forge notes".

## Rules

When you correct Claude, it also drafts a one-line rule straight away, while the details are fresh. A new rule is **provisional**: Claude uses it from the next task on, and you decide later whether to keep it.

- If one of your rules already covered the mistake, Forge marks it as a **repeat** instead of making a new rule, so you can see which rules are not working.
- If the correction contradicts an older rule, the newer one wins and the older rule is set aside (not deleted).
- At the start of a task, Claude quietly checks the rules that matter most for what you asked. For example, a rule may make it ask you a question before starting.
- **show my Forge rules** lists your rules. Say **keep R4**, **drop R4**, **reword R4** or **restore R4** to change one. Dropping a rule that replaced an older one brings the older one back.
- Rules are also saved as plain text files in `MatiForge/rules/`, one file per kind of task.
- **review my Forge notes** goes through the notes Claude did not turn into a rule (one-off fixes, for example) one at a time, so you can approve, edit, reject or skip each.

## Weekly report

Once a week, Claude offers your report at the end of a reply. You can also ask any time: **show my Forge report**, or **show my monthly Forge report**.

It shows:

- whether mistakes that have a rule happen less often since the rule (once there is enough data)
- your most common kinds of mistake, compared with the week before
- repeats after a rule, and rules that keep repeating, so you can reword them
- new provisional rules: drop or reword any you don't want. **No answer means keep**: a rule is kept 7 days after it first appears in a report.
- conflicts, where a newer correction replaced an older rule

## Export your rules

Ask: **export my Forge rules**

You get your rules as plain text to paste into ChatGPT, Cursor or another Claude account, and a copy is saved as `MatiForge/rules-export.md`. Rules labelled **work** are always left out.

## What it runs on your computer

- **Plugin:** three small Python scripts that run when you send a message, when a task starts, and after a helper agent finishes. Each one only adds a short note for Claude (for example, asking it to save a correction). They write no files and make no network calls. In Cowork they run in Claude's own task sandbox.
- **Desktop extension:** a small program, started by the Claude app, that reads and writes only the `MatiForge` folder in your home folder. It makes no network calls.
- All the code is in this repository: `plugins/mati-forge/` and `extension/`.

## Update

- **Plugin:** in **Customize > Plugins**, open the `mati-forge` marketplace and choose **Check for updates**, or turn on **Sync automatically**. If you installed by upload, upload the new zip instead.
- **Extension:** when a release says the extension changed, download the new `.mcpb` file and install it the same way, then restart Claude. Your notes are kept, and a backup is made before any upgrade.

## Remove

1. Remove **Mati Forge** in **Customize > Plugins**.
2. Remove **Mati Forge** in **Settings > Extensions**.
3. To delete your notes too, delete the `MatiForge` folder in your home folder.

## Known limits

- Tested only on a Mac so far. Windows has not been tried yet. Please report what happens.
- The Claude desktop app must be open for notes to be saved.
- The extension does not update itself. When a release says it changed, install the new `.mcpb` file.
- Corrections made in the **Code** tab, rather than Cowork, need Python 3 on your computer. Cowork on a Mac does not; on Windows this is not known yet.

## Feedback

Open an issue on this repository's [Issues page](https://github.com/vedhvv/mati-forge/issues): what worked, what didn't, and anything that felt off. Please don't paste your notes or rules there if they contain anything private.
