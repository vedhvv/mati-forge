#!/usr/bin/env node
// Mati Forge v0.2.1: local MCP server, as a Claude desktop extension.
//
// Plain Node.js, no packages. It runs on the Claude desktop app's built-in
// Node on Mac and Windows, so users install nothing extra.
//
// Stores entries in ~/MatiForge/forge.db (SQLite, via node:sqlite). On Windows
// that is C:\Users\<name>\MatiForge\forge.db. Four tools:
// - log_failure: saves one short-summary entry about a correction.
// - log_subagent: saves one entry about a subagent that failed, returned
//   incomplete work, or was retried; replies with its number, e.g. "Saved as S4".
// - update_subagent: sets recovered (yes / no / unclear) on one subagent entry.
// - show_notes: lists recent entries; status "test" entries are hidden unless asked.
//
// Rules this script follows:
// - No network calls. Local files only.
// - Short summaries only: every text field is PII-scrubbed and cut before it is
//   written, so a full transcript can never be stored.
// - Scope is personal, mati or work; missing or unclear is saved as work.
//   share is always "none", new entries are always "pending".
// - Speaks MCP over stdio: one JSON message per line. Nothing else goes to stdout.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_NAME = "forge";
const SERVER_VERSION = "0.2.1";
const DEFAULT_PROTOCOL = "2025-06-18";
const DB_NAME = "forge.db";
const SCHEMA_VERSION = 5;
const MAX_TEXT = 200;
const MAX_TASK_TYPE = 40;
const MAX_SUBAGENT_TYPE = 60;
const MAX_REASON = 100;
const SCOPES = ["personal", "mati", "work"];
const BACKUP_NAME = "forge-backup-before-v0.2.1.db";
const SUBAGENT_EVENTS = ["subagent_failed", "subagent_finished"];
const OUTCOMES = ["error", "incomplete", "retry"];
const RECOVERED = ["yes", "no", "unclear"];
const KINDS = ["all", "corrections", "subagents"];
const DEFAULT_SHOW = 10;
const MAX_SHOW = 50;

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
      "when the user asks to see their Forge notes. Show the result to the " +
      "user as it is.",
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
};

function dataDir() {
  return path.join(os.homedir(), "MatiForge");
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
  const target = path.join(dataDir(), BACKUP_NAME);
  if (fs.existsSync(target)) return;
  db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
}

function connect() {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir(), DB_NAME));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    // v0.2.1 (schema 5): the correction column vedh_said is now user_said.
    // An older file is copied once to a backup first.
    if (columns(db, "entries").includes("vedh_said")) {
      backupOnce(db);
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

function cleanLimit(value) {
  let n = DEFAULT_SHOW;
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) n = Math.trunc(value);
  else if (value === true) n = 1;
  else if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value) && parseInt(value, 10) !== 0) n = parseInt(value, 10);
  return Math.max(1, Math.min(n, MAX_SHOW));
}

function now() {
  // Local time with offset, e.g. 2026-11-11T14:03:01+05:30 (same as the Python version).
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

// ---------- tools ----------

function logFailure(args) {
  const aiDid = scrub(args.ai_did);
  // vedh_said is the field's name before v0.2.1, still accepted from older plugin versions.
  const userSaid = scrub(args.user_said || args.vedh_said);
  if (!aiDid || !userSaid) throw new Error("ai_did and user_said are both required");
  withDb((db) => {
    db.prepare(
      "INSERT INTO entries (created_at, scope, task_type, ai_did, user_said, subagents_used) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(now(), cleanScope(args.scope), cleanTaskType(args.task_type), aiDid, userSaid, cleanBool(args.subagents_used) ? 1 : 0);
  });
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
      "INSERT INTO subagent_entries (created_at, scope, task_type, event, subagent_type, asked, outcome, reason, recovered)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      now(), cleanScope(args.scope), cleanTaskType(args.task_type), event,
      cleanSubagentType(args.subagent_type), asked, cleanChoice(args.outcome, OUTCOMES, defaultOutcome),
      reason, cleanChoice(args.recovered, RECOVERED, "unclear")
    ).lastInsertRowid
  );
  return "Saved as S" + Number(id);
}

function updateSubagent(args) {
  const raw = text(args.id).trim().toUpperCase();
  if (!/^S?\d{1,9}$/.test(raw)) throw new Error("id must look like S4");
  const entryId = parseInt(raw.replace(/^S/, ""), 10);
  const recovered = cleanChoice(args.recovered, RECOVERED, "");
  if (!recovered) throw new Error("recovered must be yes, no or unclear");
  const changes = withDb((db) =>
    db.prepare("UPDATE subagent_entries SET recovered = ? WHERE id = ?").run(recovered, entryId).changes
  );
  if (Number(changes) !== 1) throw new Error("no subagent entry S" + entryId);
  return "Updated S" + entryId;
}

function fetch(db, table, columns, scope, limit, includeTest) {
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
  const rows = db.prepare("SELECT " + columns + " FROM " + table + where + " ORDER BY id DESC LIMIT ?").all(...params, limit);
  return { total: Number(total), rows, hidden: Number(hidden) };
}

function correctionLines({ total, rows }) {
  const lines = ["Corrections: " + rows.length + " most recent of " + total + "."];
  for (const r of rows) {
    lines.push("");
    lines.push("#" + r.id + ", " + niceTime(r.created_at) + ", " + r.task_type + ", " + r.scope + ", " + r.status);
    lines.push("  Claude did: " + r.ai_did);
    lines.push("  You said: " + r.user_said);
    lines.push("  Subagents used: " + (r.subagents_used ? "yes" : "no"));
  }
  return lines;
}

function subagentLines({ total, rows }) {
  const lines = ["Subagent entries: " + rows.length + " most recent of " + total + "."];
  for (const r of rows) {
    lines.push("");
    lines.push("#S" + r.id + ", " + niceTime(r.created_at) + ", " + r.task_type + ", " + r.scope + ", " + r.status);
    lines.push("  Event: " + r.event + " (" + r.subagent_type + ")");
    lines.push("  Asked to: " + r.asked);
    lines.push("  Outcome: " + r.outcome);
    lines.push("  Reason: " + r.reason);
    lines.push("  Recovered: " + r.recovered);
  }
  return lines;
}

function showNotes(args) {
  const limit = cleanLimit(args.limit);
  const scope = text(args.scope).trim().toLowerCase();
  const kind = cleanChoice(args.kind, KINDS, "all");
  const includeTest = cleanBool(args.include_test);

  const [corrections, subagents] = withDb((db) => [
    fetch(db, "entries", "id, created_at, scope, task_type, ai_did, user_said, subagents_used, status", scope, limit, includeTest),
    fetch(db, "subagent_entries",
      "id, created_at, scope, task_type, event, subagent_type, asked, outcome, reason, recovered, status",
      scope, limit, includeTest),
  ]);

  const title = "Forge notes" + (SCOPES.includes(scope) ? " (" + scope + ")" : "");
  const sections = [];
  if (kind === "all" || kind === "corrections") {
    sections.push(corrections.rows.length ? correctionLines(corrections) : ["Corrections: none yet."]);
  }
  if (kind === "all" || kind === "subagents") {
    sections.push(subagents.rows.length ? subagentLines(subagents) : ["Subagent entries: none yet."]);
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

const HANDLERS = {
  log_failure: logFailure,
  log_subagent: logSubagent,
  update_subagent: updateSubagent,
  show_notes: showNotes,
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
