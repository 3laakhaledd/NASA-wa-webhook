"use strict";
// Stateless MCP Streamable HTTP (JSON response mode). Read operations only.
const { createHash, timingSafeEqual } = require("node:crypto");
const { dayBounds, timestamp, textOf } = require("./retrieval");
const { phone } = require("./phone-numbers");
const PROTOCOL = "2025-06-18";
const VERSIONS = new Set([PROTOCOL, "2025-03-26", "2024-11-05"]);
const names = { status: "nasa_wa_connection_status", report: "nasa_wa_daily_report", messages: "nasa_wa_daily_messages" };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const number = (minimum, maximum) => ({ type: "integer", minimum, maximum });
function tools(lineCount) {
  const line = number(1, lineCount);
  const daily = { line, date: { type: "string", format: "date", description: "Explicit Riyadh date, YYYY-MM-DD." }, offset: number(0, 10000000), limit: number(1, 200) };
  return [
    { name: names.status, description: "Read the selected school account identity and connectivity without pairing or creating instances.", annotations, inputSchema: { type: "object", properties: { line }, required: ["line"], additionalProperties: false } },
    { name: names.report, description: "Verified daily account totals and phone-first individual chat inventory. Includes sent OR received activity, merges confirmed phone aliases, and flags unresolved numbers. Poll running results. Follow nextOffset until null; message coverage and phone completeness are separate.", annotations, inputSchema: { type: "object", properties: daily, required: ["line", "date"], additionalProperties: false } },
    { name: names.messages, description: "Paginated individual-chat message records for a verified Riyadh day, with verified numbers, direction, timestamps, text and type. Excludes groups/status/broadcast/self. Media is not transcribed. Follow nextOffset until null.", annotations, inputSchema: { type: "object", properties: daily, required: ["line", "date"], additionalProperties: false } }
  ];
}
const result = data => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const failure = text => ({ isError: true, content: [{ type: "text", text }] });
const safeName = value => typeof value === "string" && value && !value.includes("@") ? value : null;
function validate(name, args, count) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid arguments");
  const allowed = name === names.status ? ["line"] : ["line", "date", "offset", "limit"];
  if (Object.keys(args).some(k => !allowed.includes(k))) throw Error("Unsupported argument");
  if (!Number.isInteger(args.line) || args.line < 1 || args.line > count) throw Error("Choose a configured school line");
  if (name !== names.status) {
    dayBounds(args.date);
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 10000000)) throw Error("Invalid offset");
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw Error("Invalid limit");
  }
}
function install(app, { lines, getApi, apiKey = process.env.NASA_WA_MCP_API_KEY,
  allowedOrigins = process.env.NASA_WA_MCP_ALLOWED_ORIGINS || "https://app.clickup.com" }) {
  const definitions = tools(lines.length);
  const configured = typeof apiKey === "string" && apiKey.length >= 32 && apiKey.length <= 512 && apiKey.trim() === apiKey;
  const digest = value => createHash("sha256").update(value).digest();
  const matches = value => configured && typeof value === "string" && value.length <= 1024 && timingSafeEqual(digest(apiKey), digest(value));
  const origins = new Set(allowedOrigins.split(",").map(x => x.trim()).filter(Boolean));
  async function call(name, args) {
    if (!definitions.some(t => t.name === name)) return failure("Unknown reporting tool");
    try { validate(name, args, lines.length); } catch (e) { return failure(e.message); }
    try {
      const api = getApi(lines[args.line - 1]);
      if (name === names.status) {
        const identity = await api.identity(), accountNumber = phone(identity.ownerJid);
        if (!accountNumber) throw Error("Unverified account");
        return result({ line: args.line, accountNumber, connectionStatus: identity.connectionStatus, snapshotAt: new Date().toISOString(), note: "Connectivity does not prove history completeness." });
      }
      const job = api.getDailyJob(args.date);
      if (job.status !== "complete" || job.coverage?.complete !== true) return result({ line: args.line, date: args.date, status: job.status,
        coverage: { complete: false }, phoneNumbersComplete: false, progress: job.progress,
        note: job.status === "running" ? "Poll the same tool and arguments; running is not zero activity." : "Daily retrieval failed; no complete report is available." });
      const bounds = dayBounds(args.date);
      if (job.date !== args.date || job.identity?.name !== lines[args.line - 1] || job.window?.timezone !== "Asia/Riyadh" ||
          job.window.start !== new Date(bounds.start * 1000).toISOString() || job.window.endExclusive !== new Date(bounds.end * 1000).toISOString()) throw Error("Mismatched verified window");
      const resolved = await api.resolveDailyNumbers(job);
      const { passes, ...coverage } = job.coverage;
      const base = { line: args.line, date: args.date, status: "complete", accountNumber: phone(job.identity.ownerJid), window: job.window,
        coverage, summary: job.summary, phoneResolution: resolved.totals, phoneNumbersComplete: resolved.totals.phoneNumbersComplete };
      const byJid = new Map(job.chats.map(c => [c.jid, c])), rows = [];
      if (name === names.report) {
        const merged = new Map();
        for (const c of job.chats) {
          if (c.kind !== "individual_lid" && c.kind !== "individual_phone") continue;
          const p = resolved.byJid.get(c.jid);
          if (p?.phoneNumberStatus === "school_account") continue;
          const key = p?.phoneNumber || c.jid;
          if (!merged.has(key)) merged.set(key, { number: p?.phoneNumber || null, names: [], phoneNumberStatus: p?.phoneNumberStatus || "unresolved",
            unavailableReason: p?.phoneNumberReason || null, numberSources: [], rawThreadCount: 0, sent: 0, received: 0, messageCount: 0 });
          const item = merged.get(key), name = safeName(c.contactName);
          if (name && !item.names.includes(name)) item.names.push(name);
          for (const source of p?.phoneNumberSources || []) if (!item.numberSources.includes(source)) item.numberSources.push(source);
          item.rawThreadCount++; item.sent += c.sent; item.received += c.received; item.messageCount += c.messageCount;
        }
        rows.push(...merged.values()); rows.sort((a, b) => (a.number || "~").localeCompare(b.number || "~"));
      } else {
        for (const m of [...job.rows].sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id))) {
          const p = resolved.byJid.get(m.key.remoteJid);
          if (!p || p.phoneNumberStatus === "school_account") continue;
          rows.push({ number: p.phoneNumber, name: safeName(byJid.get(m.key.remoteJid)?.contactName), phoneNumberStatus: p.phoneNumberStatus,
            unavailableReason: p.phoneNumberReason, timestamp: timestamp(m), timeRiyadh: new Date((timestamp(m) + 10800) * 1000).toISOString().slice(0, 19) + "+03:00",
            direction: m.key.fromMe ? "sent" : "received", text: textOf(m), messageType: m.messageType || null });
        }
      }
      const offset = args.offset ?? 0, limit = args.limit ?? 50, page = rows.slice(offset, offset + limit);
      return result({ ...base, pagination: { offset, limit, total: rows.length, returned: page.length, nextOffset: offset + page.length < rows.length ? offset + page.length : null },
        [name === names.report ? "chats" : "messages"]: page,
        note: "Individual activity only in the paginated data; summary includes all account chat types. No WhatsApp sends, read-state changes or ClickUp writes." });
    } catch (_) { return failure("Protected reporting lookup failed; verify selected account, coverage and service configuration. No complete report was produced."); }
  }
  app.all("/mcp", async (req, res) => {
    res.set("Cache-Control", "no-store"); res.set("Vary", "Authorization, X-API-Key, Origin");
    if (!configured) return res.status(503).json({ error: "Configure a strong NASA_WA_MCP_API_KEY privately in Railway" });
    const authorization = req.get("authorization");
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
    const headerKey = req.get("x-api-key"), values = [bearer, headerKey].filter(v => typeof v === "string" && v);
    if (!values.length || values.some(v => !matches(v))) { res.set("WWW-Authenticate", "Bearer"); return res.status(401).json({ error: "Authentication required" }); }
    if (Object.keys(req.query || {}).length) return res.status(400).json({ error: "Use headers for credentials and JSON for tool arguments; no query parameters" });
    const origin = req.get("origin");
    if (origin && !origins.has(origin)) return res.status(403).json({ error: "Origin not allowed" });
    if (req.method !== "POST") { res.set("Allow", "POST"); return res.status(405).end(); }
    const body = req.body;
    const idValid = typeof body?.id === "string" || (typeof body?.id === "number" && Number.isFinite(body.id));
    const id = idValid ? body.id : null;
    const error = (code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || (Object.hasOwn(body, "id") && !idValid)) return error(-32600, "Invalid Request");
    if (!Object.hasOwn(body, "id")) return res.status(202).end();
    const reply = value => res.json({ jsonrpc: "2.0", id, result: value });
    try {
      if (body.method === "initialize") return reply({ protocolVersion: VERSIONS.has(body.params?.protocolVersion) ? body.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nasa-wa-reporting", version: "1.0.0" },
        instructions: "Read-only NASA WhatsApp reporting. Use explicit Riyadh dates and selected lines. Poll running jobs, follow all pagination, verify account identity and coverage, and report unresolved numbers honestly. No List tasks are required." });
      const protocolHeader = req.get("mcp-protocol-version");
      if (protocolHeader && !VERSIONS.has(protocolHeader)) return res.status(400).json({ error: "Unsupported MCP protocol version" });
      if (body.method === "ping") return reply({});
      if (body.method === "tools/list") return reply({ tools: definitions });
      if (body.method === "tools/call") {
        if (typeof body.params?.name !== "string") return error(-32602, "Invalid params");
        return reply(await call(body.params.name, body.params.arguments || {}));
      }
      return error(-32601, "Method not found");
    } catch (_) { return error(-32603, "Internal reporting error"); }
  });
}
module.exports = { install, tools, validate };
