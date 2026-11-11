# Mati Forge

Mati Forge quietly notes the moments you correct Claude, so you can see later where it keeps getting things wrong. It also notes subagents that fail, return unfinished work, or have to be re-run.

This is an early test version. Thank you for trying it.

## What it captures

When one of your messages looks like a correction ("no", "instead", "can you change", "redo" and similar), Claude decides whether it really is one. If it is, Claude saves a short note:

- what Claude did
- what you asked for instead, in Claude's own words
- the kind of task (email, memo, research and so on)
- whether subagents were involved
- a label: **personal**, **work**, or **mati**. Anything work-related or unclear is labelled **work**.

Notes are short summaries, never copies of your conversation. Claude is told to leave out names, company names, contact details and figures, and Forge also removes email addresses, phone numbers and similar numbers before saving.

Claude does not mention Forge in its replies. You may see a small line such as "used Mati Forge integration" when a note is saved.

## Where your data goes

- Notes are stored only on your computer, in a folder called `MatiForge` in your home folder (`~/MatiForge` on Mac, `C:\Users\<you>\MatiForge` on Windows).
- Forge makes no network calls and sends nothing to anyone, including the author.
- Your conversations are still processed by Claude as usual. Forge keeps no copy of them.

## Install

You need the Claude desktop app, open, with Cowork. Forge has two parts, and you need both.

**1. The plugin** (notices corrections)

1. Accept the GitHub invite for this repository if you haven't.
2. In Claude, open **Customize > Plugins**, choose **Add marketplace**, and enter `vedhvv/mati-forge`.
3. Find **Mati Forge** in the list and click **Install**.

If **Add marketplace** fails, download `mati-forge-<version>.zip` from this repository's **Releases** page instead, and use **Customize > Plugins > Upload plugin**.

**2. The desktop extension** (saves and shows your notes)

1. Download `mati-forge-extension-<version>.mcpb` from the **Releases** page.
2. Double-click it, or in Claude go to **Settings > Extensions > Advanced settings > Install Extension...** and choose the file.
3. Review and click **Install**.

**3. Restart Claude** (quit fully, then reopen).

## See your notes

In any Cowork task, ask: **show my Forge notes**

You can also ask for only corrections, only subagent notes, or only one label, for example "show my personal Forge notes".

## Update

- **Plugin:** in **Customize > Plugins**, open the `mati-forge` marketplace and choose **Check for updates**, or turn on **Sync automatically**. If you installed by upload, upload the new zip instead.
- **Extension:** when a release says the extension changed, download the new `.mcpb` file and install it the same way. Your notes are kept.

## Remove

1. Remove **Mati Forge** in **Customize > Plugins**.
2. Remove **Mati Forge** in **Settings > Extensions**.
3. To delete your notes too, delete the `MatiForge` folder in your home folder.

## Known limits

- Tested only on a Mac so far. Windows has not been tried yet. Please report what happens.
- The Claude desktop app must be open for notes to be saved.
- Corrections made in the **Code** tab, rather than Cowork, need Python 3 on your computer. Cowork on a Mac does not; on Windows this is not known yet.

## Feedback

Tell the person who invited you what worked, what didn't, and anything that felt off.
