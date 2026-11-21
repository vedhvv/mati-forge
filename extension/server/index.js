#!/usr/bin/env node
// Mati Forge v0.3.2: local MCP server, as a Claude desktop extension.
//
// Plain Node.js, no packages. It runs on the Claude desktop app's built-in
// Node on Mac and Windows, so users install nothing extra.
//
// Stores everything in ~/MatiForge/forge.db (SQLite, via node:sqlite), plus a
// readable copy of approved rules in ~/MatiForge/rules/<task_type>.md. On
// Windows the folder is C:\Users\<name>\MatiForge. Tools:
// - log_failure: saves one short-summary entry about a correction. If the same
//   task already has a subagent entry, links it as the likely cause.
// - log_subagent / update_subagent: one entry per subagent problem, and whether
//   Claude recovered from it.
// - show_notes: lists recent entries; status "test" entries are hidden unless asked.
// - review_next / approve_rule / reject_entry: go through pending entries one
//   at a time; a rule is saved only when the user approves it.
// - show_rules: lists approved rules.
// - get_briefing: at the start of a task, up to 5 rules for that task type plus
//   up to 2 recent watch-outs; each briefing is logged so repeats can be traced.
//
// Rules this script follows:
// - No network calls. Local files only.
// - Short summaries only: every text field is PII-scrubbed and cut before it is
//   written, so a full transcript can never be stored.
// - Scope is personal, mati or work; missing or unclear is saved as work.
//   share is always "none"; new entries are always "pending".
// - Speaks MCP over stdio: one JSON message per line. Nothing else goes to stdout.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_NAME = "forge";
const SERVER_VERSION = "0.3.2";
const DEFAULT_PROTOCOL = "2025-06-18";
const DB_NAME = "forge.db";
const SCHEMA_VERSION = 7;
const MAX_TEXT = 200;
const MAX_RULE = 300;
const MAX_TASK_TYPE = 40;
const MAX_SUBAGENT_TYPE = 60;
const MAX_REASON = 100;
const SCOPES = ["personal", "mati", "work"];
const SUBAGENT_EVENTS = ["subagent_failed", "subagent_finished"];
const OUTCOMES = ["error", "incomplete", "retry"];
const RECOVERED = ["yes", "no", "unclear"];
const KINDS = ["all", "corrections", "subagents"];
const DEFAULT_SHOW = 10;
const MAX_SHOW = 50;
const MAX_BRIEF_RULES = 5;
const MAX_WATCH_OUTS = 2;
const WATCH_OUT_DAYS = 30;

// Starter failure types. The first two matter most.
const FAILURE_TYPES = {
  wrong_direction: "misread the intent or scope of the task",
  helper_misfire: "a subagent failed, stalled or returned weak work that affected the result",
  ignored_prior_instruction: "skipped or went against something the user had already said",
  wrong_fact_or_number: "a fact or figure was wrong",
  wrong_source_or_period: "used the wrong source, document, date range or period",
  format_or_style: "layout, structure or formatting was off",
  wrong_tone_or_wording: "tone or word choice was off",
  missing_step: "left out a step or part the task needed",
  did_too_much: "added or changed more than was asked",
  wrong_tool_or_handoff: "used the wrong tool, or passed the wrong thing between steps, with no subagent involved",
  hallucinated_detail: "made up a detail",
  other: "none of the above",
};
const FAILURE_NAMES = Object.keys(FAILURE_TYPES);
const FAILURE_HELP = FAILURE_NAMES.map((k) => k + " (" + FAILURE_TYPES[k] + ")").join("; ");
const SECTION_TITLES = {
  wrong_direction: "Confirm before starting",
  helper_misfire: "Briefing and checking helpers",
};

const SCOPE_HELP =
  '"personal" only when clearly unrelated to any job (for example a poem, a recipe, ' +
  'or a how-to or general-knowledge question) and nothing involves a company, deal, ' +
  'investor, fund, portfolio, financial figures or work files; "mati" only when ' +
  'clearly about Mati or Mati Forge; "work" for everything else, including all ' +
  "employer, client or fund work, and whenever unsure.";
const REASON_HELP =
  "Short plain-language cause, from what the subagent returned, e.g. ran out of " +
  "time, could not find sources, tool or search limit, returned partial data, " +
  "misunderstood the brief. Use unclear if you cannot tell.";
const RECOVERED_HELP =
  "yes if you fixed or filled the gap yourself or with another subagent, no if " +
  "the gap remained, unclear if you cannot tell.";
const TASK_TYPE_HELP =
  "Short label, e.g. pitch_deck, ic_note, memo, email, spreadsheet, research, code, other.";
const TASK_REF_HELP = "The task code given in the Mati Forge note, if any.";
const AS_IS =
  " Show the result to the user exactly as returned, word for word: do not summarise, " +
  "rephrase, reorder or turn it into a table, and add nothing before or after it.";

const TOOLS = [
  {
    name: "log_failure",
    description:
      "Mati Forge. Save one short entry when the user corrects your earlier " +
      "work. Use only when the Mati Forge note asks for it and you judge the " +
      "message is really a correction. Short summaries only, never quotes of " +
      "the conversation. Leave out names, company names, contact details and " +
      "figures. Do not mention this tool in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        ai_did: { type: "string", description: "One short sentence: what you did that is being corrected." },
        user_said: { type: "string", description: "One short sentence summarising the correction, in your words." },
        task_type: { type: "string", description: TASK_TYPE_HELP },
        subagents_used: { type: "boolean", description: "True if you used subagents to produce the corrected output." },
        scope: { type: "string", enum: SCOPES, description: SCOPE_HELP },
        failure_type: { type: "string", enum: FAILURE_NAMES, description: "Your best guess: " + FAILURE_HELP },
        task_ref: { type: "string", description: TASK_REF_HELP },
        rule_id: {
          type: "string",
          description: "Only if a rule from this task's Forge briefing (e.g. R3) already covered this mistake: that rule's number. Otherwise leave it out.",
        },
      },
      required: ["ai_did", "user_said", "task_type", "subagents_used", "scope"],
    },
  },
  {
    name: "log_subagent",
    description:
      "Mati Forge. Save one short entry about a subagent that failed, returned " +
      "incomplete work, or was retried. Use only when a Mati Forge note asks for " +
      "it. Short summaries only. Leave out names, company names, contact details " +
      "and figures. Do not mention this tool in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string", enum: SUBAGENT_EVENTS, description: "The event named in the Mati Forge note." },
        asked: { type: "string", description: "One short sentence: what the subagent was asked to do, in your words." },
        outcome: { type: "string", enum: OUTCOMES, description: "error, incomplete or retry." },
        subagent_type: { type: "string", description: "The subagent type named in the note, e.g. general-purpose." },
        task_type: { type: "string", description: TASK_TYPE_HELP },
        scope: { type: "string", enum: SCOPES, description: SCOPE_HELP },
        reason: { type: "string", description: REASON_HELP },
        recovered: { type: "string", enum: RECOVERED, description: "Use unclear now; set it later with update_subagent." },
        task_ref: { type: "string", description: TASK_REF_HELP },
      },
      required: ["event", "asked", "outcome", "subagent_type", "task_type", "scope", "reason"],
    },
  },
  {
    name: "update_subagent",
    description:
      "Mati Forge. Set whether you recovered from a subagent problem you logged " +
      "earlier with log_subagent. Call once, just before your final answer for " +
      "the request, when a Mati Forge note asks for it. Changes only the " +
      "recovered field. Do not mention this tool in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The entry number log_subagent gave you, e.g. S4." },
        recovered: { type: "string", enum: RECOVERED, description: RECOVERED_HELP },
      },
      required: ["id", "recovered"],
    },
  },
  {
    name: "show_notes",
    description:
      "Mati Forge. List the user's recent Forge notes in plain language: " +
      "captured corrections and subagent entries, in separate sections. Use " +
      "when the user asks to see their Forge notes." + AS_IS,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_SHOW, description: "How many recent notes to show per section. Default 10." },
        scope: { type: "string", enum: SCOPES, description: "Only show notes with this scope. Omit to show all." },
        kind: { type: "string", enum: KINDS, description: "corrections, subagents, or all (default)." },
        include_test: { type: "boolean", description: "True only if the user asks to see test entries too. Default false." },
      },
    },
  },
  {
    name: "review_next",
    description:
      "Mati Forge. Get the next pending Forge note to review with the user, most important " +
      "first. Use when the user asks to review their Forge notes. Show the item, suggest " +
      "a failure type and a one-line rule, then wait for the user to approve, edit, " +
      "reject or skip it. Never save a rule the user has not approved.",
    inputSchema: {
      type: "object",
      properties: {
        skip: {
          type: "array",
          items: { type: "string" },
          description: "Entries the user chose to skip in this review, e.g. [\"#5\", \"#S3\"]. They stay pending.",
        },
      },
    },
  },
  {
    name: "approve_rule",
    description:
      "Mati Forge. Save a rule the user has just approved, word for word as they approved " +
      "or edited it, and mark its source entries approved. Call only after the user " +
      "explicitly approves in this conversation. To link entries to an existing rule " +
      "instead of creating a near-copy, pass rule_id and no rule text.",
    inputSchema: {
      type: "object",
      properties: {
        refs: {
          type: "array",
          items: { type: "string" },
          description: "The entries this rule comes from, e.g. [\"#7\", \"#S9\"].",
        },
        rule: { type: "string", description: "One line, as approved by the user." },
        task_type: { type: "string", description: TASK_TYPE_HELP + " Use any for a rule that applies to every task." },
        failure_type: { type: "string", enum: FAILURE_NAMES, description: FAILURE_HELP },
        scope: { type: "string", enum: SCOPES, description: SCOPE_HELP },
        rule_id: { type: "string", description: "An existing rule to link these entries to, e.g. R3." },
        repeat: {
          type: "boolean",
          description: "With rule_id: true when the user confirms this mistake repeated after that rule already existed.",
        },
      },
      required: ["refs"],
    },
  },
  {
    name: "reject_entry",
    description:
      "Mati Forge. Mark entries the user rejected during a review. They are kept, marked " +
      "rejected, and no rule is made. Call only after the user says to reject.",
    inputSchema: {
      type: "object",
      properties: {
        refs: { type: "array", items: { type: "string" }, description: "e.g. [\"#5\"]." },
      },
      required: ["refs"],
    },
  },
  {
    name: "show_rules",
    description:
      "Mati Forge. List the user's approved Forge rules, grouped by task type. Use when " +
      "the user asks to see their Forge rules." + AS_IS,
    inputSchema: {
      type: "object",
      properties: {
        task_type: { type: "string", description: "Only this task type. Omit to show all." },
        scope: { type: "string", enum: SCOPES, description: "Only rules with this scope. Omit to show all." },
      },
    },
  },
  {
    name: "get_briefing",
    description:
      "Mati Forge. Call once at the start of a task, before starting the work, when a Mati Forge " +
      "note asks for it: returns the user's rules for this task type (questions to confirm first, " +
      "how to brief helper agents, other rules) and recent watch-outs. Follow it without " +
      "mentioning Forge. Call again only if the user switches to a clearly different kind of task.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: { type: "string", description: TASK_TYPE_HELP },
        task_ref: { type: "string", description: TASK_REF_HELP },
      },
      required: ["task_type"],
    },
  },
];

// ---------- storage ----------

const TABLES = {
  entries: `
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'mati', 'work')),
      task_type TEXT NOT NULL,
      ai_did TEXT NOT NULL,
      user_said TEXT NOT NULL,
      subagents_used INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      share TEXT NOT NULL DEFAULT 'none',
      pii_scrubbed INTEGER NOT NULL DEFAULT 1
    )`,
  subagent_entries: `
    CREATE TABLE IF NOT EXISTS subagent_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'subagent',
      created_at TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'mati', 'work')),
      task_type TEXT NOT NULL,
      event TEXT NOT NULL,
      subagent_type TEXT NOT NULL,
      asked TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'unclear',
      recovered TEXT NOT NULL DEFAULT 'unclear',
      status TEXT NOT NULL DEFAULT 'pending',
      share TEXT NOT NULL DEFAULT 'none',
      pii_scrubbed INTEGER NOT NULL DEFAULT 1
    )`,
  // v0.3.0 (schema 6): approved rules, and which entries each rule came from.
  // role is "source" now; later versions add "repeat" rows to count repeats after a rule.
  rules: `
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      text TEXT NOT NULL,
      task_type TEXT NOT NULL,
      failure_type TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'mati', 'work')),
      status TEXT NOT NULL DEFAULT 'active',
      share TEXT NOT NULL DEFAULT 'none'
    )`,
  rule_sources: `
    CREATE TABLE IF NOT EXISTS rule_sources (
      rule_id INTEGER NOT NULL,
      entry_kind TEXT NOT NULL CHECK (entry_kind IN ('correction', 'subagent')),
      entry_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'source',
      created_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, entry_kind, entry_id, role)
    )`,
  // A correction and a subagent entry from the same task: the subagent is a likely cause.
  entry_links: `
    CREATE TABLE IF NOT EXISTS entry_links (
      correction_id INTEGER NOT NULL,
      subagent_id INTEGER NOT NULL,
      relation TEXT NOT NULL DEFAULT 'likely_cause',
      created_at TEXT NOT NULL,
      PRIMARY KEY (correction_id, subagent_id, relation)
    )`,
  // v0.3.1 (schema 7): each briefing given, so a later correction can be traced to the rules it saw.
  briefings: `
    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      task_ref TEXT,
      task_type TEXT NOT NULL,
      rule_ids TEXT NOT NULL DEFAULT ''
    )`,
};

// Columns added to older tables. root_cause_id and repeat_of_rule_id are kept
// empty for now; later versions use them for shared root causes and repeats.
const ADDED_COLUMNS = {
  entries: {
    failure_type: "TEXT",
    task_ref: "TEXT",
    reviewed_at: "TEXT",
    repeat_of_rule_id: "INTEGER",
    root_cause_id: "INTEGER",
  },
  subagent_entries: {
    failure_type: "TEXT NOT NULL DEFAULT 'helper_misfire'",
    task_ref: "TEXT",
    reviewed_at: "TEXT",
    repeat_of_rule_id: "INTEGER",
    root_cause_id: "INTEGER",
  },
};

function dataDir() {
  return path.join(os.homedir(), "MatiForge");
}

function rulesDir() {
  return path.join(dataDir(), "rules");
}

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch (e) {
    throw new Error("this Node has no built-in SQLite (needs Node 22.13 or newer)");
  }
}

function columns(db, table) {
  return db.prepare("PRAGMA table_info(" + table + ")").all().map((r) => r.name);
}

function backupOnce(db) {
  // Copies the notes file once before an upgrade. An empty file counts as missing.
  const target = path.join(dataDir(), "forge-backup-before-v" + SERVER_VERSION + ".db");
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return;
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
}

function connect() {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir(), DB_NAME));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const existing = columns(db, "entries").length > 0 || columns(db, "subagent_entries").length > 0;
    if (existing && version < SCHEMA_VERSION) backupOnce(db);
    // v0.2.1 (schema 5): the correction column vedh_said is now user_said.
    if (columns(db, "entries").includes("vedh_said")) {
      db.exec("ALTER TABLE entries RENAME COLUMN vedh_said TO user_said");
    }
    for (const create of Object.values(TABLES)) db.exec(create);
    // Added in v0.1.3 (schema 4). Older rows get "unclear".
    const have = columns(db, "subagent_entries");
    for (const column of ["reason", "recovered"]) {
      if (!have.includes(column)) {
        db.exec("ALTER TABLE subagent_entries ADD COLUMN " + column + " TEXT NOT NULL DEFAULT 'unclear'");
      }
    }
    // Added in v0.3.0 (schema 6).
    for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
      const now = columns(db, table);
      for (const [column, type] of Object.entries(added)) {
        if (!now.includes(column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
      }
    }
    db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function withDb(fn) {
  const db = connect();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function inTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- cleaning ----------

function text(value) {
  return value ? String(value) : "";
}

function cut(value, limit) {
  return Array.from(value).slice(0, limit).join("");
}

function scrub(value, limit = MAX_TEXT) {
  let t = text(value).split(/\s+/u).filter(Boolean).join(" "); // one line
  t = t.replace(/\S+@\S+/gu, "[x]"); // email addresses
  t = t.replace(/\+?(?:\p{Nd}[ -]?){8,}/gu, "[x]"); // phone, account, Aadhaar-like
  t = t.replace(/\b[A-Z]{5}\p{Nd}{4}[A-Z]\b/gu, "[x]"); // PAN-like
  return cut(t, limit).trim();
}

function cleanScope(value) {
  const v = text(value).trim().toLowerCase();
  return v === "personal" || v === "mati" ? v : "work";
}

function cleanTaskType(value) {
  const v = text(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cut(v, MAX_TASK_TYPE) || "other";
}

function cleanBool(value) {
  if (typeof value === "boolean") return value;
  return ["true", "yes", "1"].includes(String(value).trim().toLowerCase());
}

function cleanChoice(value, choices, fallback) {
  const v = text(value).trim().toLowerCase();
  return choices.includes(v) ? v : fallback;
}

function cleanSubagentType(value) {
  return cut(text(value).replace(/[^A-Za-z0-9:_.-]/g, ""), MAX_SUBAGENT_TYPE) || "unknown";
}

function cleanTaskRef(value) {
  const v = text(value).trim().toLowerCase();
  return /^[a-f0-9]{4,16}$/.test(v) ? v : null;
}

function cleanLimit(value) {
  let n = DEFAULT_SHOW;
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) n = Math.trunc(value);
  else if (value === true) n = 1;
  else if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value) && parseInt(value, 10) !== 0) n = parseInt(value, 10);
  return Math.max(1, Math.min(n, MAX_SHOW));
}

function refList(value) {
  // Accepts ["#7", "#S9"], "#7, S9", or a single ref.
  const items = Array.isArray(value) ? value : text(value).split(/[,\s]+/);
  return items.map((v) => text(v).trim()).filter(Boolean);
}

function parseRef(ref) {
  const m = /^#?\s*(s|c)?\s*(\d{1,9})$/i.exec(text(ref).trim());
  if (!m) throw new Error("not an entry number: " + ref + " (use #7 for a correction, #S3 for a subagent entry)");
  const subagent = (m[1] || "").toLowerCase() === "s";
  return { kind: subagent ? "subagent" : "correction", id: parseInt(m[2], 10) };
}

function refName(kind, id) {
  return kind === "subagent" ? "#S" + id : "#" + id;
}

function parseRuleId(value) {
  const m = /^r?\s*(\d{1,9})$/i.exec(text(value).trim());
  if (!m) throw new Error("not a rule number: " + value + " (use R3)");
  return parseInt(m[1], 10);
}

function now() {
  // Local time with offset, e.g. 2026-11-11T14:03:01+05:30.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60)
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function niceTime(stamp) {
  // Shows the time as it was recorded, e.g. "11 Nov 2026, 14:03".
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || "");
  if (!m || +m[2] < 1 || +m[2] > 12) return stamp;
  return String(+m[3]) + " " + MONTHS[+m[2] - 1] + " " + m[1] + ", " + m[4] + ":" + m[5];
}

// ---------- capture tools ----------

function logFailure(args) {
  const aiDid = scrub(args.ai_did);
  // vedh_said is the field's name before v0.2.1, still accepted from older plugin versions.
  const userSaid = scrub(args.user_said || args.vedh_said);
  if (!aiDid || !userSaid) throw new Error("ai_did and user_said are both required");
  const failureType = cleanChoice(args.failure_type, FAILURE_NAMES, null);
  const taskRef = cleanTaskRef(args.task_ref);
  withDb((db) =>
    inTransaction(db, () => {
      const stamp = now();
      // A rule Claude says it was briefed with and that already covered this: a repeat after that rule.
      let repeatOf = null;
      try {
        if (text(args.rule_id).trim()) {
          const rid = parseRuleId(args.rule_id);
          if (db.prepare("SELECT id FROM rules WHERE id = ? AND status = 'active'").get(rid)) repeatOf = rid;
        }
      } catch (e) {
        repeatOf = null; // a malformed rule number is ignored, the correction is still saved
      }
      const id = Number(
        db.prepare(
          "INSERT INTO entries (created_at, scope, task_type, ai_did, user_said, subagents_used, failure_type, task_ref, repeat_of_rule_id)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(stamp, cleanScope(args.scope), cleanTaskType(args.task_type), aiDid, userSaid,
          cleanBool(args.subagents_used) ? 1 : 0, failureType, taskRef, repeatOf).lastInsertRowid
      );
      if (repeatOf) {
        db.prepare(
          "INSERT OR IGNORE INTO rule_sources (rule_id, entry_kind, entry_id, role, created_at) VALUES (?, 'correction', ?, 'repeat', ?)"
        ).run(repeatOf, id, stamp);
      }
      if (taskRef) {
        // Any subagent problem earlier in the same task is a likely cause of this correction.
        const subs = db.prepare("SELECT id FROM subagent_entries WHERE task_ref = ? AND status != 'test'").all(taskRef);
        const link = db.prepare(
          "INSERT OR IGNORE INTO entry_links (correction_id, subagent_id, relation, created_at) VALUES (?, ?, 'likely_cause', ?)"
        );
        for (const s of subs) link.run(id, s.id, stamp);
      }
    })
  );
  return "Saved";
}

function logSubagent(args) {
  const asked = scrub(args.asked);
  if (!asked) throw new Error("asked is required");
  const event = cleanChoice(args.event, SUBAGENT_EVENTS, "unknown");
  const defaultOutcome = event === "subagent_failed" ? "error" : "unclear";
  const reason = scrub(args.reason, MAX_REASON) || "unclear";
  const id = withDb((db) =>
    db.prepare(
      "INSERT INTO subagent_entries (created_at, scope, task_type, event, subagent_type, asked, outcome, reason, recovered, task_ref)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      now(), cleanScope(args.scope), cleanTaskType(args.task_type), event,
      cleanSubagentType(args.subagent_type), asked, cleanChoice(args.outcome, OUTCOMES, defaultOutcome),
      reason, cleanChoice(args.recovered, RECOVERED, "unclear"), cleanTaskRef(args.task_ref)
    ).lastInsertRowid
  );
  return "Saved as S" + Number(id);
}

function updateSubagent(args) {
  const raw = text(args.id).trim().toUpperCase();
  if (!/^#?S?\d{1,9}$/.test(raw)) throw new Error("id must look like S4");
  const entryId = parseInt(raw.replace(/^#?S?/, ""), 10);
  const recovered = cleanChoice(args.recovered, RECOVERED, "");
  if (!recovered) throw new Error("recovered must be yes, no or unclear");
  const changes = withDb((db) =>
    db.prepare("UPDATE subagent_entries SET recovered = ? WHERE id = ?").run(recovered, entryId).changes
  );
  if (Number(changes) !== 1) throw new Error("no subagent entry S" + entryId);
  return "Updated S" + entryId;
}

// ---------- shared lookups ----------

function linksFor(db) {
  // Maps both ways between corrections and their likely-cause subagent entries.
  const byCorrection = new Map();
  const bySubagent = new Map();
  for (const l of db.prepare("SELECT correction_id, subagent_id FROM entry_links ORDER BY subagent_id").all()) {
    if (!byCorrection.has(l.correction_id)) byCorrection.set(l.correction_id, []);
    byCorrection.get(l.correction_id).push(l.subagent_id);
    if (!bySubagent.has(l.subagent_id)) bySubagent.set(l.subagent_id, []);
    bySubagent.get(l.subagent_id).push(l.correction_id);
  }
  return { byCorrection, bySubagent };
}

function rulesForEntries(db) {
  // Maps "correction:7" / "subagent:9" to the rule numbers made from them.
  const map = new Map();
  for (const r of db.prepare("SELECT rule_id, entry_kind, entry_id FROM rule_sources WHERE role = 'source' ORDER BY rule_id").all()) {
    const key = r.entry_kind + ":" + r.entry_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push("R" + r.rule_id);
  }
  return map;
}

function getEntry(db, kind, id) {
  const table = kind === "subagent" ? "subagent_entries" : "entries";
  return db.prepare("SELECT * FROM " + table + " WHERE id = ?").get(id);
}

// ---------- show_notes ----------

function fetch(db, table, columnsList, scope, limit, includeTest) {
  // Returns { total, rows, hidden } for one table.
  const conds = [];
  const params = [];
  if (SCOPES.includes(scope)) {
    conds.push("scope = ?");
    params.push(scope);
  }
  let hidden = 0;
  if (!includeTest) {
    hidden = db.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE " + conds.concat(["status = 'test'"]).join(" AND ")).get(...params).n;
    conds.push("status != 'test'");
  }
  const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
  const total = db.prepare("SELECT COUNT(*) AS n FROM " + table + where).get(...params).n;
  const rows = db.prepare("SELECT " + columnsList + " FROM " + table + where + " ORDER BY id DESC LIMIT ?").all(...params, limit);
  return { total: Number(total), rows, hidden: Number(hidden) };
}

function correctionLines({ total, rows }, links, ruleMap) {
  const lines = ["Corrections: " + rows.length + " most recent of " + total + "."];
  for (const r of rows) {
    lines.push("");
    lines.push("#" + r.id + ", " + niceTime(r.created_at) + ", " + r.task_type + ", " + r.scope + ", " + r.status);
    lines.push("  Claude did: " + r.ai_did);
    lines.push("  You said: " + r.user_said);
    lines.push("  Subagents used: " + (r.subagents_used ? "yes" : "no"));
    if (r.failure_type) lines.push("  Failure type: " + r.failure_type);
    const causes = links.byCorrection.get(r.id);
    if (causes) lines.push("  Likely cause: " + causes.map((s) => "#S" + s).join(", "));
    const rules = ruleMap.get("correction:" + r.id);
    if (rules) lines.push("  Rule: " + rules.join(", "));
    if (r.repeat_of_rule_id) lines.push("  Repeated after rule: R" + r.repeat_of_rule_id);
  }
  return lines;
}

function subagentLines({ total, rows }, links, ruleMap) {
  const lines = ["Subagent entries: " + rows.length + " most recent of " + total + "."];
  for (const r of rows) {
    lines.push("");
    lines.push("#S" + r.id + ", " + niceTime(r.created_at) + ", " + r.task_type + ", " + r.scope + ", " + r.status);
    lines.push("  Event: " + r.event + " (" + r.subagent_type + ")");
    lines.push("  Asked to: " + r.asked);
    lines.push("  Outcome: " + r.outcome);
    lines.push("  Reason: " + r.reason);
    lines.push("  Recovered: " + r.recovered);
    const corrections = links.bySubagent.get(r.id);
    if (corrections) lines.push("  Likely cause of: " + corrections.map((c) => "#" + c).join(", "));
    const rules = ruleMap.get("subagent:" + r.id);
    if (rules) lines.push("  Rule: " + rules.join(", "));
    if (r.repeat_of_rule_id) lines.push("  Repeated after rule: R" + r.repeat_of_rule_id);
  }
  return lines;
}

function showNotes(args) {
  const limit = cleanLimit(args.limit);
  const scope = text(args.scope).trim().toLowerCase();
  const kind = cleanChoice(args.kind, KINDS, "all");
  const includeTest = cleanBool(args.include_test);

  const data = withDb((db) => ({
    corrections: fetch(db, "entries",
      "id, created_at, scope, task_type, ai_did, user_said, subagents_used, status, failure_type, repeat_of_rule_id",
      scope, limit, includeTest),
    subagents: fetch(db, "subagent_entries",
      "id, created_at, scope, task_type, event, subagent_type, asked, outcome, reason, recovered, status, repeat_of_rule_id",
      scope, limit, includeTest),
    links: linksFor(db),
    ruleMap: rulesForEntries(db),
  }));
  const { corrections, subagents, links, ruleMap } = data;

  const title = "Forge notes" + (SCOPES.includes(scope) ? " (" + scope + ")" : "");
  const sections = [];
  if (kind === "all" || kind === "corrections") {
    sections.push(corrections.rows.length ? correctionLines(corrections, links, ruleMap) : ["Corrections: none yet."]);
  }
  if (kind === "all" || kind === "subagents") {
    sections.push(subagents.rows.length ? subagentLines(subagents, links, ruleMap) : ["Subagent entries: none yet."]);
  }

  const shown = (kind !== "subagents" ? corrections.rows.length : 0) + (kind !== "corrections" ? subagents.rows.length : 0);
  const hidden = (kind !== "subagents" ? corrections.hidden : 0) + (kind !== "corrections" ? subagents.hidden : 0);
  const hiddenLine = hidden
    ? hidden + " test " + (hidden === 1 ? "entry" : "entries") + " hidden. Ask for Forge notes including tests to see them."
    : "";
  if (!shown) return "No " + title + " yet." + (hiddenLine ? "\n\n" + hiddenLine : "");
  const lines = [title];
  for (const section of sections) lines.push("", ...section);
  if (hiddenLine) lines.push("", hiddenLine);
  return lines.join("\n");
}

// ---------- review ----------

function reviewQueue(db, skip) {
  // Pending entries in review order: corrections with a likely subagent cause,
  // then wrong_direction, then helper_misfire (including subagent entries),
  // then everything else; oldest first within each group. A subagent entry
  // whose linked correction is still pending is reviewed together with it.
  const links = linksFor(db);
  const corrections = db.prepare("SELECT * FROM entries WHERE status = 'pending'").all();
  const subagents = db.prepare("SELECT * FROM subagent_entries WHERE status = 'pending'").all();
  const pendingCorrections = new Set(corrections.map((c) => c.id));
  const items = [];
  for (const c of corrections) {
    const causes = (links.byCorrection.get(c.id) || []).filter((s) => subagents.some((x) => x.id === s));
    const priority = causes.length ? 0 : c.failure_type === "wrong_direction" ? 1 : c.failure_type === "helper_misfire" ? 2 : 3;
    items.push({ kind: "correction", row: c, priority, causes });
  }
  for (const s of subagents) {
    const withCorrection = (links.bySubagent.get(s.id) || []).some((c) => pendingCorrections.has(c));
    if (!withCorrection) items.push({ kind: "subagent", row: s, priority: 2, causes: [] });
  }
  const skipped = new Set();
  for (const ref of skip) {
    try {
      const p = parseRef(ref);
      skipped.add(p.kind + ":" + p.id);
    } catch (e) {
      // ignore malformed skip entries
    }
  }
  return items
    .filter((i) => !skipped.has(i.kind + ":" + i.row.id))
    .sort((a, b) =>
      a.priority - b.priority ||
      String(a.row.created_at).localeCompare(String(b.row.created_at)) ||
      (a.kind === b.kind ? a.row.id - b.row.id : a.kind === "correction" ? -1 : 1)
    );
}

function sentence(t) {
  return /[.!?]$/.test(t) ? t : t + ".";
}

function subagentSummary(s) {
  return (
    "#S" + s.id + ", a " + s.subagent_type + " subagent (" + s.event + "). Asked to: " + sentence(s.asked) +
    " Outcome: " + s.outcome + ". Reason: " + s.reason + ". Recovered: " + s.recovered + "."
  );
}

function reviewNext(args) {
  const skip = refList(args.skip);
  return withDb((db) => {
    const queue = reviewQueue(db, skip);
    if (!queue.length) {
      return skip.length
        ? "Nothing else to review. Skipped this time: " + skip.join(", ") + " (still pending)."
        : "Nothing left to review.";
    }
    const item = queue[0];
    const r = item.row;
    const ref = refName(item.kind, r.id);
    const lines = [];
    lines.push("Review " + ref + " (" + (item.kind === "subagent" ? "subagent entry" : "correction") + "). " +
      queue.length + " left to review, including this one.");
    const ft = item.kind === "subagent" ? "helper_misfire" : r.failure_type || "not set";
    lines.push("When: " + niceTime(r.created_at) + ". Task type: " + r.task_type + ". Scope: " + r.scope +
      ". Failure type so far: " + ft + ".");
    const refs = [ref];
    if (item.kind === "correction") {
      lines.push("Claude did: " + r.ai_did);
      lines.push("You said: " + r.user_said);
      lines.push("Subagents used: " + (r.subagents_used ? "yes" : "no") + ".");
      for (const sid of item.causes) {
        const s = getEntry(db, "subagent", sid);
        lines.push("Likely cause, same task: " + subagentSummary(s));
        refs.push("#S" + sid);
      }
    } else {
      lines.push("Subagent: " + subagentSummary(r));
    }
    const ftype = item.kind === "subagent" ? "helper_misfire" : r.failure_type;
    if (r.repeat_of_rule_id) {
      lines.push("Repeated after rule R" + r.repeat_of_rule_id + " (Claude marked this when saving). If the user agrees, " +
        "link it with approve_rule rule_id R" + r.repeat_of_rule_id + " and repeat true.");
    } else if (ftype) {
      const possible = possibleRepeats(db, r, ftype);
      if (possible.length) {
        lines.push("Possible repeat of " + possible.map((x) => "R" + x).join(", ") +
          " (same task type and failure type, or briefed in this task). Ask the user whether it repeats that rule.");
      }
    }
    const sameType = db.prepare(
      "SELECT id, text, failure_type FROM rules WHERE status = 'active' AND task_type IN (?, 'any') ORDER BY id"
    ).all(r.task_type);
    lines.push(sameType.length
      ? "Existing rules for " + r.task_type + ": " + sameType.map((x) => "R" + x.id + " (" + x.failure_type + "): " + x.text).join(" | ")
      : "Existing rules for " + r.task_type + ": none.");
    const types = new Set();
    for (const t of db.prepare("SELECT DISTINCT task_type FROM entries UNION SELECT DISTINCT task_type FROM subagent_entries UNION SELECT DISTINCT task_type FROM rules").all()) {
      types.add(t.task_type);
    }
    lines.push("Task types already in use: " + Array.from(types).sort().join(", ") + ".");
    lines.push("Refs for a decision: " + refs.join(", ") + ".");
    return lines.join("\n");
  });
}

function possibleRepeats(db, row, failureType) {
  // Active rules with the same failure type that this task was briefed with, or that cover the same task type.
  // Only rules that already existed when the mistake happened can have been repeated.
  const ids = new Set();
  if (row.task_ref) {
    for (const b of db.prepare("SELECT rule_ids FROM briefings WHERE task_ref = ?").all(row.task_ref)) {
      for (const x of String(b.rule_ids).split(",").filter(Boolean)) {
        const rule = db.prepare(
          "SELECT id FROM rules WHERE id = ? AND status = 'active' AND failure_type = ? AND created_at <= ?"
        ).get(Number(x), failureType, row.created_at);
        if (rule) ids.add(rule.id);
      }
    }
  }
  for (const rule of db.prepare(
    "SELECT id FROM rules WHERE status = 'active' AND failure_type = ? AND task_type IN (?, 'any') AND created_at <= ? ORDER BY id"
  ).all(failureType, row.task_type, row.created_at)) {
    ids.add(rule.id);
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function checkPending(db, refs) {
  const parsed = refs.map(parseRef);
  for (const p of parsed) {
    const row = getEntry(db, p.kind, p.id);
    if (!row) throw new Error("no entry " + refName(p.kind, p.id));
    if (row.status !== "pending") throw new Error(refName(p.kind, p.id) + " is not pending (it is " + row.status + ")");
  }
  return parsed;
}

function markReviewed(db, parsed, status, stamp) {
  for (const p of parsed) {
    const table = p.kind === "subagent" ? "subagent_entries" : "entries";
    db.prepare("UPDATE " + table + " SET status = ?, reviewed_at = ? WHERE id = ?").run(status, stamp, p.id);
  }
}

function approveRule(args) {
  const refs = refList(args.refs);
  if (!refs.length) throw new Error("refs is required, e.g. [\"#7\"]");
  let ruleRow;
  let created = false;
  withDb((db) =>
    inTransaction(db, () => {
      const parsed = checkPending(db, refs);
      const stamp = now();
      if (text(args.rule_id).trim()) {
        const id = parseRuleId(args.rule_id);
        ruleRow = db.prepare("SELECT * FROM rules WHERE id = ? AND status = 'active'").get(id);
        if (!ruleRow) throw new Error("no active rule R" + id);
        db.prepare("UPDATE rules SET updated_at = ? WHERE id = ?").run(stamp, id);
      } else {
        const ruleText = scrub(args.rule, MAX_RULE);
        if (!ruleText) throw new Error("rule is required (or pass rule_id to link to an existing rule)");
        const taskType = text(args.task_type).trim().toLowerCase() === "any" ? "any" : cleanTaskType(args.task_type);
        const failureType = cleanChoice(args.failure_type, FAILURE_NAMES, "other");
        const id = Number(
          db.prepare(
            "INSERT INTO rules (created_at, updated_at, text, task_type, failure_type, scope) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(stamp, stamp, ruleText, taskType, failureType, cleanScope(args.scope)).lastInsertRowid
        );
        ruleRow = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
        created = true;
      }
      const role = !created && cleanBool(args.repeat) ? "repeat" : "source";
      const source = db.prepare(
        "INSERT OR IGNORE INTO rule_sources (rule_id, entry_kind, entry_id, role, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const p of parsed) {
        source.run(ruleRow.id, p.kind, p.id, role, stamp);
        if (role === "repeat") {
          const table = p.kind === "subagent" ? "subagent_entries" : "entries";
          db.prepare("UPDATE " + table + " SET repeat_of_rule_id = ? WHERE id = ?").run(ruleRow.id, p.id);
        }
      }
      ruleRow.role = role;
      markReviewed(db, parsed, "approved", stamp);
    })
  );
  const fileNote = writeRulesFile(ruleRow.task_type);
  const from = refs.map((x) => refName(parseRef(x).kind, parseRef(x).id)).join(", ");
  const verb = created ? "Saved rule R" : ruleRow.role === "repeat" ? "Marked as a repeat after rule R" : "Linked to rule R";
  return verb + ruleRow.id + " for " + ruleRow.task_type +
    " (" + ruleRow.failure_type + "), from " + from + ". " + fileNote;
}

function rejectEntry(args) {
  const refs = refList(args.refs);
  if (!refs.length) throw new Error("refs is required, e.g. [\"#5\"]");
  withDb((db) =>
    inTransaction(db, () => {
      const parsed = checkPending(db, refs);
      markReviewed(db, parsed, "rejected", now());
    })
  );
  return "Marked rejected: " + refs.map((x) => refName(parseRef(x).kind, parseRef(x).id)).join(", ") + ". Kept, no rule made.";
}

// ---------- rules ----------

function ruleSources(db) {
  const map = new Map();
  for (const s of db.prepare("SELECT rule_id, entry_kind, entry_id FROM rule_sources WHERE role = 'source' ORDER BY entry_kind, entry_id").all()) {
    if (!map.has(s.rule_id)) map.set(s.rule_id, []);
    map.get(s.rule_id).push(refName(s.entry_kind, s.entry_id));
  }
  return map;
}

function groupedRuleLines(rules, sources, indent) {
  // Rules for one task type, in sections: confirm first, helpers, then the rest.
  const lines = [];
  const groups = [
    [SECTION_TITLES.wrong_direction, rules.filter((r) => r.failure_type === "wrong_direction")],
    [SECTION_TITLES.helper_misfire, rules.filter((r) => r.failure_type === "helper_misfire")],
    ["Other rules", rules.filter((r) => r.failure_type !== "wrong_direction" && r.failure_type !== "helper_misfire")],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    lines.push(indent + title + ":");
    for (const r of list) {
      const tags = [];
      if (title === "Other rules") tags.push(r.failure_type);
      tags.push(r.scope);
      const from = sources.get(r.id);
      if (from) tags.push("from " + from.join(", "));
      lines.push(indent + "  R" + r.id + ". " + r.text + " (" + tags.join("; ") + ")");
    }
  }
  return lines;
}

function showRules(args) {
  const scope = text(args.scope).trim().toLowerCase();
  const taskFilter = text(args.task_type).trim() ? cleanTaskType(args.task_type) : "";
  return withDb((db) => {
    const conds = ["status = 'active'"];
    const params = [];
    if (SCOPES.includes(scope)) {
      conds.push("scope = ?");
      params.push(scope);
    }
    if (taskFilter) {
      conds.push("task_type = ?");
      params.push(taskFilter);
    }
    const rules = db.prepare("SELECT * FROM rules WHERE " + conds.join(" AND ") + " ORDER BY task_type, id").all(...params);
    if (!rules.length) return "No Forge rules yet.";
    const sources = ruleSources(db);
    const lines = ["Forge rules: " + rules.length + " active."];
    const types = Array.from(new Set(rules.map((r) => r.task_type)));
    for (const t of types) {
      lines.push("", t);
      lines.push(...groupedRuleLines(rules.filter((r) => r.task_type === t), sources, "  "));
    }
    return lines.join("\n");
  });
}

function writeRulesFile(taskType) {
  // Rewrites the readable copy for one task type. The database stays the master copy.
  try {
    const body = withDb((db) => {
      const rules = db.prepare("SELECT * FROM rules WHERE status = 'active' AND task_type = ? ORDER BY id").all(taskType);
      const lines = [
        "# Forge rules: " + taskType,
        "",
        "Approved rules for " + (taskType === "any" ? "every task" : taskType + " tasks") + ". Written by Mati Forge; " +
          "changes made in this file are overwritten.",
        "",
      ];
      const sources = ruleSources(db);
      const grouped = groupedRuleLines(rules, sources, "");
      for (const line of grouped) {
        if (line.startsWith("  ")) lines.push("- " + line.trim());
        else lines.push("", "## " + line.slice(0, -1), "");
      }
      if (!rules.length) lines.push("No active rules.");
      return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    });
    fs.mkdirSync(rulesDir(), { recursive: true });
    const file = path.join(rulesDir(), taskType + ".md");
    fs.writeFileSync(file, body, "utf8");
    return "Readable copy: " + file;
  } catch (e) {
    return "The rule is saved, but the readable copy could not be written: " + e.message;
  }
}

// ---------- briefing ----------

function briefRules(db, taskType) {
  // Up to 5 active rules: confirm-first, then helper briefing, then the rest.
  // Within a group: rules for this task type before "any", then most-used, then newest.
  const rules = db.prepare(
    "SELECT r.*, (SELECT COUNT(*) FROM rule_sources s WHERE s.rule_id = r.id) AS uses" +
      " FROM rules r WHERE r.status = 'active' AND r.task_type IN (?, 'any')"
  ).all(taskType);
  const group = (r) => (r.failure_type === "wrong_direction" ? 0 : r.failure_type === "helper_misfire" ? 1 : 2);
  return rules
    .sort((a, b) =>
      group(a) - group(b) ||
      (a.task_type === "any") - (b.task_type === "any") ||
      Number(b.uses) - Number(a.uses) ||
      b.id - a.id
    )
    .slice(0, MAX_BRIEF_RULES);
}

function watchOuts(db, taskType) {
  // Up to 2 recent pending failures for this task type that no rule covers yet.
  const since = new Date(Date.now() - WATCH_OUT_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const items = [];
  for (const c of db.prepare(
    "SELECT * FROM entries WHERE status = 'pending' AND task_type = ? AND created_at >= ? ORDER BY id DESC LIMIT 20"
  ).all(taskType, since)) {
    items.push({ priority: c.failure_type === "wrong_direction" ? 0 : c.failure_type === "helper_misfire" ? 1 : 2,
      created: c.created_at, line: "Last time Claude " + lower(sentence(c.ai_did)) + " Correction: " + sentence(c.user_said) });
  }
  for (const s of db.prepare(
    "SELECT * FROM subagent_entries WHERE status = 'pending' AND task_type = ? AND created_at >= ? ORDER BY id DESC LIMIT 20"
  ).all(taskType, since)) {
    items.push({ priority: 1, created: s.created_at,
      line: "A helper asked to " + lower(s.asked).replace(/[.!?]$/, "") + " came back " + s.outcome + " (" + s.reason + ")." });
  }
  return items
    .sort((a, b) => a.priority - b.priority || String(b.created).localeCompare(String(a.created)))
    .slice(0, MAX_WATCH_OUTS)
    .map((i) => i.line);
}

function lower(t) {
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function getBriefing(args) {
  const taskType = text(args.task_type).trim() ? cleanTaskType(args.task_type) : "";
  if (!taskType) throw new Error("task_type is required");
  return withDb((db) => {
    const rules = briefRules(db, taskType);
    const watch = watchOuts(db, taskType);
    db.prepare("INSERT INTO briefings (created_at, task_ref, task_type, rule_ids) VALUES (?, ?, ?, ?)")
      .run(now(), cleanTaskRef(args.task_ref), taskType, rules.map((r) => r.id).join(","));
    if (!rules.length && !watch.length) return "No Forge rules or watch-outs for " + taskType + ". Carry on as usual.";
    const lines = ["Forge briefing for " + taskType + ". Follow it without mentioning Forge."];
    const sections = [
      ["Before starting, confirm with the user (unless the request already answers it):", rules.filter((r) => r.failure_type === "wrong_direction")],
      ["When using helper agents:", rules.filter((r) => r.failure_type === "helper_misfire")],
      ["Also:", rules.filter((r) => r.failure_type !== "wrong_direction" && r.failure_type !== "helper_misfire")],
    ];
    for (const [title, list] of sections) {
      if (!list.length) continue;
      lines.push("", title);
      for (const r of list) lines.push("- R" + r.id + ": " + r.text);
    }
    if (watch.length) {
      lines.push("", "Watch out (recent, no rule yet):");
      for (const w of watch) lines.push("- " + w);
    }
    return lines.join("\n");
  });
}

const HANDLERS = {
  log_failure: logFailure,
  log_subagent: logSubagent,
  update_subagent: updateSubagent,
  show_notes: showNotes,
  review_next: reviewNext,
  approve_rule: approveRule,
  reject_entry: rejectEntry,
  show_rules: showRules,
  get_briefing: getBriefing,
};

// ---------- MCP plumbing ----------

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(id, body, isError = false) {
  return result(id, { content: [{ type: "text", text: body }], isError });
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function handle(msg) {
  // Returns the reply for one incoming message, or null if no reply is due.
  if (!("id" in msg)) return null; // notifications, e.g. notifications/initialized
  const method = msg.method;
  const id = msg.id;
  const params = isObject(msg.params) ? msg.params : {};

  if (method === "initialize") {
    return result(id, {
      protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params.name;
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
    if (!handler) return error(id, -32602, "Unknown tool: " + name);
    const args = isObject(params.arguments) ? params.arguments : {};
    try {
      return textResult(id, handler(args));
    } catch (e) {
      return textResult(id, name + " failed: " + (e && e.message ? e.message : String(e)), true);
    }
  }
  return error(id, -32601, "Method not found: " + method);
}

function send(reply) {
  process.stdout.write(JSON.stringify(reply) + "\n");
}

function onLine(line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    send(error(null, -32700, "Parse error"));
    return;
  }
  if (!isObject(msg)) {
    send(error(null, -32600, "Invalid request"));
    return;
  }
  const reply = handle(msg);
  if (reply) send(reply);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => {
  if (buffer) onLine(buffer);
  // No process.exit here: Node exits once pending output is written.
});
