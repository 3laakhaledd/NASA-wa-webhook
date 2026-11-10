const crypto = require("node:crypto");

// Only phone JIDs or explicitly typed phoneNumber fields are phone evidence.
function phone(value, explicit = false) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/);
  if (match) return "+" + match[1];
  if (explicit && /^\+?[1-9]\d{7,14}$/.test(value)) return "+" + value.replace(/^\+/, "");
  return null;
}
const individual = jid => typeof jid === "string" &&
  (jid.endsWith("@lid") || jid.endsWith("@s.whatsapp.net"));

function resolve(rows, ownerJid, groups = [], { contacts: contactRecords = [], evidenceRows = [] } = {}) {
  const owner = phone(ownerJid);
  const threads = new Map(), mappings = new Map();
  function link(lid, pn, source) {
    if (typeof lid !== "string" || !lid.endsWith("@lid") || !pn || pn === owner) return;
    if (!mappings.has(lid)) mappings.set(lid, new Map());
    const choices = mappings.get(lid);
    if (!choices.has(pn)) choices.set(pn, new Set());
    choices.get(pn).add(source);
  }
  for (const m of [...rows, ...evidenceRows]) {
    const key = m.key || {}, jid = key.remoteJid;
    if (!individual(jid)) continue;
    if (rows.includes(m)) {
      if (!threads.has(jid)) threads.set(jid, { jid, name: "" });
      if (!key.fromMe && m.pushName) threads.get(jid).name = m.pushName;
    }
    // Direct remote-JID alternates describe this individual conversation.
    for (const v of [key.remoteJidAlt, m.remoteJidAlt, key.previousRemoteJid]) {
      link(jid, phone(v), "message alternate");
      if (typeof v === "string" && v.endsWith("@lid"))
        link(v, phone(jid), "message alternate");
    }
    // Sender phone fields describe the contact only on inbound individual messages.
    if (key.fromMe === false) {
      for (const v of [key.senderPn, key.participantPn])
        link(jid, phone(v), "inbound sender");
    }
  }
  for (const c of contactRecords) {
    const ids = [c.id, c.lid, c.remoteJid, c.jid];
    const numbers = new Set([...ids.map(v => phone(v)), phone(c.phoneNumber, true)].filter(Boolean));
    for (const lid of ids) for (const pn of numbers) link(lid, pn, "contact/chat metadata");
  }
  for (const g of groups) {
    for (const p of (Array.isArray(g.participants) ? g.participants : [])) {
      // A roster row can contain conflicting phone fields: retain the conflict.
      const numbers = new Set([phone(p.phoneNumber, true), phone(p.jid), phone(p.id)].filter(Boolean));
      for (const lid of [p.id, p.lid]) for (const pn of numbers) link(lid, pn, "group roster");
    }
  }
  const contacts = new Map(), unresolved = [];
  let resolvedThreads = 0, excludedSchoolThreads = 0;
  for (const t of threads.values()) {
    const direct = phone(t.jid);
    if (direct === owner) { excludedSchoolThreads++; continue; }
    const choices = direct ? new Map([[direct, new Set(["phone JID"])]]) : mappings.get(t.jid);
    if (!choices || choices.size !== 1) {
      unresolved.push({ name: t.name || null,
        reason: choices && choices.size > 1 ? "conflicting phone mappings" : "phone not exposed by available records" });
      continue;
    }
    const [number, sources] = choices.entries().next().value;
    if (!contacts.has(number)) contacts.set(number, { number, names: new Set(), sources: new Set(), threadCount: 0 });
    const c = contacts.get(number);
    if (t.name) c.names.add(t.name);
    for (const s of sources) c.sources.add(s);
    c.threadCount++; resolvedThreads++;
  }
  return {
    phoneNumbersComplete: unresolved.length === 0,
    individualThreads: threads.size - excludedSchoolThreads,
    resolvedThreads, unresolvedThreads: unresolved.length, excludedSchoolThreads,
    uniquePhoneNumbers: contacts.size,
    contacts: [...contacts.values()].sort((a, b) => a.number.localeCompare(b.number)).map(c => ({
      number: c.number, names: [...c.names], numberSources: [...c.sources], threadCount: c.threadCount
    })),
    unresolved
  };
}

// Identity evidence can be outside the requested reporting window. It never adds
// conversations or messages to that window. No read-state or send routes are used.
async function mappingEvidence({ rows, axios, baseUrl, apiKey, instance }) {
  const path = p => String(baseUrl).replace(/\/$/, "") + p + "/" + encodeURIComponent(instance);
  const options = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 };
  const contacts = [], evidenceRows = [], groups = [], warnings = [];
  const lids = new Set(rows.map(m => m.key?.remoteJid).filter(j => typeof j === "string" && j.endsWith("@lid")));
  if (!lids.size) return { contacts, evidenceRows, groups, warnings };
  try {
    const seen = new Set();
    for (let page = 1; ; page++) {
      if (page > 1000) throw Error("contact cap");
      const r = await axios.post(path("/chat/findContacts"), { where: {}, offset: 500, page }, options);
      if (!Array.isArray(r.data)) throw Error("invalid contacts");
      if (!r.data.length) break;
      for (const c of r.data) {
        const id = JSON.stringify(c);
        if (seen.has(id)) throw Error("repeated pagination");
        seen.add(id); contacts.push(c);
      }
    }
  } catch (_) { warnings.push("Saved-contact mapping lookup incomplete."); }
  try {
    const r = await axios.post(path("/chat/findChats"), {}, options);
    if (!Array.isArray(r.data)) throw Error("invalid chats");
    for (const c of r.data) {
      contacts.push(c);
      if (c.lastMessage) evidenceRows.push(c.lastMessage);
    }
  } catch (_) { warnings.push("Chat-metadata mapping unavailable."); }
  try {
    const r = await axios.get(path("/group/fetchAllGroups"), { ...options, params: { getParticipants: "true" } });
    if (!Array.isArray(r.data)) throw Error("invalid groups");
    groups.push(...r.data);
  } catch (_) { warnings.push("Group-roster mapping unavailable."); }
  // Bounded recent-message sampling is identity evidence, NOT transcript coverage.
  for (const jid of lids) {
    try {
      const r = await axios.post(path("/chat/findMessages"),
        { where: { key: { remoteJid: jid } }, offset: 50, page: 1 }, options);
      const records = r.data?.messages?.records;
      if (!Array.isArray(records) || records.some(m => m.key?.remoteJid !== jid))
        throw Error("invalid identity sample");
      evidenceRows.push(...records);
    } catch (_) { warnings.push("Recent-message identity lookup unavailable for one or more chats."); }
  }
  return { contacts, evidenceRows, groups, warnings: [...new Set(warnings)] };
}

// Invoked only by the authenticated, private ClickUp command processor.
async function dailyChatReport({ cmd, axios, baseUrl, apiKey, lines }) {
  const m = String(cmd).match(/^daily-chats\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})\s+line\s+(\d+)(?:\s+ending\s+(\d{4,15}))?$/i);
  if (!m) throw Error("Use: RUN: daily-chats YYYY-MM-DD HH:MM HH:MM line N ending 6444");
  const retrieval = require("./retrieval");
  const bounds = retrieval.dayBounds(m[1]), n = Number(m[4]), instance = lines[n - 1];
  const seconds = t => {
    const [h, min] = t.split(":").map(Number);
    if (h > 23 || min > 59) throw Error("Invalid Riyadh time");
    return h * 3600 + min * 60;
  };
  const start = bounds.start + seconds(m[2]), end = bounds.start + seconds(m[3]);
  if (!instance || end <= start) throw Error("Invalid line or time window");
  const options = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 };
  const base = String(baseUrl).replace(/\/$/, "");
  async function identity() {
    const r = await axios.get(base + "/instance/fetchInstances", options);
    const x = (Array.isArray(r.data) ? r.data : [r.data]).find(x =>
      (x.name || x.instance?.instanceName || x.instanceName) === instance);
    const pn = phone(x?.ownerJid || x?.instance?.ownerJid);
    if (!pn || (m[5] && !pn.endsWith(m[5]))) throw Error("Requested school line identity could not be verified");
    return pn;
  }
  const owner = await identity();
  const read = async body => (await axios.post(base + "/chat/findMessages/" + encodeURIComponent(instance), body, options)).data;
  const where = { messageTimestamp: { gte: new Date(start * 1000).toISOString(),
    lte: new Date((end - 1) * 1000).toISOString() } };
  const data = await retrieval.verifiedCollect(read, where, { start, end });
  const evidence = await mappingEvidence({ rows: data.rows, axios, baseUrl, apiKey, instance });
  if (await identity() !== owner) throw Error("Connected school number changed during retrieval");
  const ownerJid = owner.slice(1) + "@s.whatsapp.net";
  const opts = { contacts: evidence.contacts, evidenceRows: [...data.rows, ...evidence.evidenceRows] };
  const totals = resolve(data.rows, ownerJid, evidence.groups, opts);
  const threads = new Map();
  for (const msg of data.rows) {
    const jid = msg.key.remoteJid;
    if (!individual(jid) || phone(jid) === owner) continue;
    if (!threads.has(jid)) threads.set(jid, []);
    threads.get(jid).push(msg);
  }
  const chats = [], merged = new Map();
  for (const msgs of threads.values()) {
    const r = resolve(msgs, ownerJid, evidence.groups, opts), contact = r.contacts[0];
    const number = contact?.number || null;
    let chat = number ? merged.get(number) : null;
    if (!chat) {
      chat = { number, names: [], numberSources: contact?.numberSources || [],
        unavailableReason: r.unresolved[0]?.reason || null, sent: 0, received: 0, messages: [] };
      chats.push(chat); if (number) merged.set(number, chat);
    }
    for (const name of contact?.names || r.unresolved.map(x => x.name).filter(Boolean))
      if (!chat.names.includes(name)) chat.names.push(name);
    for (const msg of msgs) {
      const stamp = Number(typeof msg.messageTimestamp === "object" ? msg.messageTimestamp.low : msg.messageTimestamp);
      const direction = msg.key.fromMe ? "sent" : "received";
      chat[direction]++;
      chat.messages.push({ timestamp: stamp,
        timeRiyadh: new Date((stamp + 10800) * 1000).toISOString().slice(11, 19),
        direction, text: retrieval.textOf(msg), messageType: msg.messageType || null });
    }
  }
  for (const chat of chats) chat.messages.sort((a, b) => a.timestamp - b.timestamp);
  return { done: true, text: "Private daily chat report. No WhatsApp messages sent or marked read.\n```json\n" +
    JSON.stringify({ line: n, accountNumber: owner, date: m[1], from: m[2], toExclusive: m[3],
      timezone: "Asia/Riyadh", coverage: { ...data.coverage, passes: undefined },
      phoneNumbersComplete: totals.phoneNumbersComplete, individualThreads: totals.individualThreads,
      uniquePhoneNumbers: totals.uniquePhoneNumbers, unresolvedThreads: totals.unresolvedThreads,
      warnings: evidence.warnings, chats }, null, 2) + "\n```" };
}

function authorized(req, token) {
  if (!token) return false;
  const supplied = String(req.get("authorization") || "");
  const hash = s => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(hash(supplied), hash("Bearer " + token));
}

function install(app, { ensureJob, axios, baseUrl, apiKey, instance,
  readToken = process.env.WA_REPORT_READ_TOKEN }) {
  const jobs = new WeakMap();
  app.get("/insights/numbers", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Authorization");
    if (!readToken) return res.status(503).json({ error: "Private number access is not configured" });
    if (!authorized(req, readToken)) return res.status(401).json({ error: "Unauthorized" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")))
      return res.status(400).json({ error: "Supply date=YYYY-MM-DD (Asia/Riyadh)" });
    try {
      const job = ensureJob(req.query.date);
      if (job.status !== "complete" || job.coverage?.complete !== true)
        return res.json({ status: job.status, date: job.date, coverage: job.coverage,
          error: job.error, phoneNumbersComplete: false, note: "Poll again; incomplete retrieval is not zero activity" });
      if (!job.identity?.ownerJid) throw new Error("Account identity is unavailable");
      if (!jobs.has(job)) {
        jobs.set(job, (async () => {
          const e = await mappingEvidence({ rows: job.rows, axios, baseUrl, apiKey, instance });
          return { ...resolve(job.rows, job.identity.ownerJid, e.groups, e), warnings: e.warnings };
        })());
      }
      const result = await jobs.get(job);
      const contacts = result.contacts, unresolved = result.unresolved;
      const parse = (v, fallback, max) => v === undefined ? fallback :
        (/^\d+$/.test(String(v)) ? Math.min(max, Number(v)) : NaN);
      const offset = parse(req.query.offset, 0, 10000000);
      const unresolvedOffset = parse(req.query.unresolvedOffset, 0, 10000000);
      const limit = parse(req.query.limit, 50, 200);
      if (![offset, unresolvedOffset, limit].every(Number.isFinite) || limit < 1)
        return res.status(400).json({ error: "Invalid pagination" });
      const page = contacts.slice(offset, offset + limit), missing = unresolved.slice(unresolvedOffset, unresolvedOffset + limit);
      const { contacts: _c, unresolved: _u, ...totals } = result;
      return res.json({
        status: "complete", instance, date: job.date, identity: job.identity, window: job.window,
        coverage: { ...job.coverage, passes: undefined }, ...totals,
        snapshotAt: job.coverage.verifiedAt,
        note: result.phoneNumbersComplete ? "Every individual thread has a verified phone mapping; today's result is a snapshot." :
          "Phone-number list is incomplete. Unresolved threads are not phone numbers or necessarily distinct people.",
        pagination: { offset, limit, total: contacts.length,
          nextOffset: offset + page.length < contacts.length ? offset + page.length : null },
        unresolvedPagination: { offset: unresolvedOffset, limit, total: unresolved.length,
          nextOffset: unresolvedOffset + missing.length < unresolved.length ? unresolvedOffset + missing.length : null },
        contacts: page, unresolved: missing
      });
    } catch (_) {
      return res.status(502).json({ status: "failed", phoneNumbersComplete: false,
        error: "Private daily number retrieval failed; no complete phone list is available" });
    }
  });
}
module.exports = { phone, resolve, mappingEvidence, dailyChatReport, authorized, install };
