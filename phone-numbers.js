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

function resolve(rows, ownerJid, groups = []) {
  const owner = phone(ownerJid);
  const threads = new Map(), mappings = new Map();
  function link(lid, pn, source) {
    if (typeof lid !== "string" || !lid.endsWith("@lid") || !pn || pn === owner) return;
    if (!mappings.has(lid)) mappings.set(lid, new Map());
    const choices = mappings.get(lid);
    if (!choices.has(pn)) choices.set(pn, new Set());
    choices.get(pn).add(source);
  }
  for (const m of rows) {
    const key = m.key || {}, jid = key.remoteJid;
    if (!individual(jid)) continue;
    if (!threads.has(jid)) threads.set(jid, { jid, name: "" });
    if (!key.fromMe && m.pushName) threads.get(jid).name = m.pushName;
    // Direct remote-JID alternates describe this individual conversation.
    for (const v of [key.remoteJidAlt, m.remoteJidAlt]) {
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
          let groups = [], rosterAvailable = false;
          const preliminary = resolve(job.rows, job.identity.ownerJid);
          if (preliminary.unresolvedThreads) {
            try {
              const r = await axios.get(baseUrl.replace(/\/$/, "") + "/group/fetchAllGroups/" + encodeURIComponent(instance),
                { headers: { apikey: apiKey }, params: { getParticipants: "true" }, timeout: 30000 });
              if (!Array.isArray(r.data)) throw new Error("Invalid roster");
              groups = r.data; rosterAvailable = true;
            } catch (_) { /* Missing mapping sources never imply complete phone coverage. */ }
          }
          return { ...resolve(job.rows, job.identity.ownerJid, groups), rosterAvailable };
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
module.exports = { phone, resolve, authorized, install };
