"use strict";
const { dayBounds, aggregate, timestamp, textOf } = require("./retrieval");
const { phone } = require("./phone-numbers");
const NAMES = { queue: "nasa_wa_follow_up_queue", history: "nasa_wa_contact_history", metrics: "nasa_wa_response_metrics", unread: "nasa_wa_unread_snapshot", groups: "nasa_wa_group_insights" };
const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const dateField = { type: "string", format: "date" };
const cleanName = v => typeof v === "string" && v && !v.includes("@") ? v : null;
const sorted = rows => [...rows].sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id));
const localTime = sec => new Date((sec + 10800) * 1000).toISOString().slice(0, 19) + "+03:00";
const iso = sec => new Date(sec * 1000).toISOString();
function definitions(count) {
  const line = integer(1, count), page = { offset: integer(0, 10000000), limit: integer(1, 200) };
  const range = { fromDate: dateField, throughDate: dateField };
  const tool = (name, description, properties, required) => ({ name, description, annotations: hints, inputSchema: { type: "object", properties, required, additionalProperties: false } });
  return [
    tool(NAMES.queue, "Current follow-up CANDIDATES, not proven unanswered requests. Requires throughDate=today in Riyadh; checks later stored messages through a verified snapshot and merges phone aliases. Ending inbound is not unread or genuine unresolved status. Review transcripts. Maximum 14 calendar days; poll running results.", { line, ...range, minWaitingMinutes: integer(0, 20160), ...page }, ["line", "fromDate", "throughDate"]),
    tool(NAMES.history, "History for one verified international number across selected NASA lines. Evidence-based phone/LID matching only; unresolved aliases make completeness uncertain. Maximum 14 calendar days; poll and follow pagination.", { lines: { type: "array", items: line, minItems: 1, maxItems: count, uniqueItems: true }, number: { type: "string", pattern: "^\\+[1-9][0-9]{7,14}$" }, ...range, ...page }, ["lines", "number", "fromDate", "throughDate"]),
    tool(NAMES.metrics, "Structural text-event response waits, NOT semantic answer quality or verified resolution. Supply Riyadh workingDays (0=Sunday), same-day openTime/closeTime and slaMinutes. Separates answered and pending; excludes non-text, reactions and ambiguous same-second directions. Maximum 14 days.", { line, ...range, workingDays: { type: "array", items: integer(0, 6), minItems: 1, maxItems: 7, uniqueItems: true }, openTime: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }, closeTime: { type: "string", pattern: "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$" }, slaMinutes: { type: "number", exclusiveMinimum: 0, maximum: 20160 }, ...page }, ["line", "fromDate", "throughDate", "workingDays", "openTime", "closeTime", "slaMinutes"]),
    tool(NAMES.unread, "Live stored unread counters with verified individual numbers, group counters separately and before/after checks. No mark-as-read requests. Unread is not unanswered; linked devices may change counters.", { line, ...page }, ["line"]),
    tool(NAMES.groups, "Verified daily group activity and paginated messages with actual current group subjects, never sender names. view=messages requires exact groupName or groupId from inventory. Never exports participant numbers. Missing metadata is disclosed.", { line, date: dateField, view: { type: "string", enum: ["groups", "messages"] }, groupName: { type: "string", minLength: 1, maxLength: 200 }, groupId: { type: "string", pattern: "^[0-9-]+@g\\.us$" }, ...page }, ["line", "date"])
  ];
}
function page(items, args) {
  const offset = args.offset ?? 0, limit = args.limit ?? 50, data = items.slice(offset, offset + limit);
  return { data, pagination: { offset, limit, total: items.length, returned: data.length, nextOffset: offset + data.length < items.length ? offset + data.length : null } };
}
function timeSeconds(value, allow24 = false) {
  if (allow24 && value === "24:00") return 86400;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error("Invalid working time");
  const [h, m] = value.split(":").map(Number); return h * 3600 + m * 60;
}
function validate(name, args, count, now) {
  const def = definitions(count).find(x => x.name === name);
  if (!def || !args || typeof args !== "object" || Array.isArray(args)) throw Error("Invalid CX tool or arguments");
  if (Object.keys(args).some(k => !Object.hasOwn(def.inputSchema.properties, k)) || def.inputSchema.required.some(k => args[k] === undefined)) throw Error("Missing or unsupported argument");
  const validLine = v => Number.isInteger(v) && v >= 1 && v <= count;
  if (name === NAMES.history) {
    if (!Array.isArray(args.lines) || !args.lines.length || args.lines.length > count || new Set(args.lines).size !== args.lines.length || !args.lines.every(validLine)) throw Error("Choose distinct configured NASA lines");
    if (typeof args.number !== "string" || !/^\+[1-9]\d{7,14}$/.test(args.number)) throw Error("Supply an international + phone number, not a LID or name");
  } else if (!validLine(args.line)) throw Error("Choose a configured NASA line");
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 10000000)) throw Error("Invalid offset");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw Error("Invalid limit");
  const today = new Date(now + 10800000).toISOString().slice(0, 10);
  if (name !== NAMES.unread) {
    const from = name === NAMES.groups ? args.date : args.fromDate, to = name === NAMES.groups ? args.date : args.throughDate;
    if (typeof from !== "string" || typeof to !== "string") throw Error("Dates must be YYYY-MM-DD strings");
    const a = dayBounds(from), b = dayBounds(to);
    if (b.start < a.start || b.end - a.start > 14 * 86400 || to > today) throw Error("Use an ordered range of at most 14 Riyadh dates, not future dates");
    if (name === NAMES.queue && to !== today) throw Error("Current follow-up queue requires throughDate=today in Riyadh");
  }
  if (name === NAMES.queue && args.minWaitingMinutes !== undefined && (!Number.isInteger(args.minWaitingMinutes) || args.minWaitingMinutes < 0 || args.minWaitingMinutes > 20160)) throw Error("Invalid minimum wait");
  if (name === NAMES.metrics) {
    if (!Array.isArray(args.workingDays) || !args.workingDays.length || args.workingDays.length > 7 || new Set(args.workingDays).size !== args.workingDays.length || args.workingDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw Error("Supply distinct workingDays (0=Sunday)");
    if (timeSeconds(args.closeTime, true) <= timeSeconds(args.openTime)) throw Error("Use a same-day openTime before closeTime");
    if (typeof args.slaMinutes !== "number" || !Number.isFinite(args.slaMinutes) || args.slaMinutes <= 0 || args.slaMinutes > 20160) throw Error("Supply a positive SLA target in minutes");
  }
  if (name === NAMES.groups) {
    if (args.view !== undefined && !["groups", "messages"].includes(args.view)) throw Error("Invalid group view");
    if (args.groupName !== undefined && (typeof args.groupName !== "string" || !args.groupName.trim() || args.groupName.length > 200)) throw Error("Invalid groupName");
    if (args.groupId !== undefined && (typeof args.groupId !== "string" || !/^[\d-]+@g\.us$/.test(args.groupId))) throw Error("Invalid groupId");
    if (args.groupName && args.groupId) throw Error("Choose groupName or groupId, not both");
    if (args.view === "messages" && !args.groupName && !args.groupId) throw Error("Select exact groupName or groupId from inventory");
  }
}
function businessSeconds(start, end, args) {
  let total = 0; const open = timeSeconds(args.openTime), close = timeSeconds(args.closeTime, true);
  for (let d = Math.floor((start + 10800) / 86400) * 86400 - 10800; d < end; d += 86400) {
    const weekday = new Date((d + 10800) * 1000).getUTCDay();
    if (args.workingDays.includes(weekday)) total += Math.max(0, Math.min(end, d + close) - Math.max(start, d + open));
  }
  return total;
}
function eligibleText(m) {
  if (/reaction|protocol|senderKeyDistribution|pollUpdate/i.test(m.messageType || "")) return false;
  let v = m.message || {};
  for (let i = 0; i < 5; i++) { const next = v.ephemeralMessage?.message || v.viewOnceMessage?.message || v.viewOnceMessageV2?.message || v.documentWithCaptionMessage?.message; if (!next) break; v = next; }
  return [v.conversation, v.extendedTextMessage?.text, v.imageMessage?.caption, v.videoMessage?.caption, v.documentMessage?.caption].some(x => typeof x === "string" && x.trim());
}
function contacts(job) {
  const merged = new Map();
  for (const c of job.chats) {
    if (!["individual_phone", "individual_lid"].includes(c.kind)) continue;
    const p = job.resolved.byJid.get(c.jid); if (p?.phoneNumberStatus === "school_account") continue;
    const key = p?.phoneNumber || c.jid;
    if (!merged.has(key)) merged.set(key, { number: p?.phoneNumber || null, names: [], phoneNumberStatus: p?.phoneNumberStatus || "unresolved", unavailableReason: p?.phoneNumberReason || null, rawThreadCount: 0, records: [] });
    const t = merged.get(key), name = cleanName(c.contactName); if (name && !t.names.includes(name)) t.names.push(name);
    t.rawThreadCount++; t.records.push(...c.records);
  }
  return [...merged.values()].map(t => ({ ...t, records: sorted(t.records) }));
}
function base(job, line) { const { passes, ...coverage } = job.coverage; return { line, accountNumber: phone(job.identity.ownerJid), status: "complete", window: job.window, snapshotAt: job.snapshotAt, coverage, phoneResolution: job.resolved.totals }; }
function message(m) { return { timestamp: timestamp(m), timeRiyadh: localTime(timestamp(m)), direction: m.key.fromMe ? "sent" : "received", text: textOf(m), messageType: m.messageType || null }; }
function queue(job, args) {
  const candidates = [];
  for (const c of contacts(job)) {
    const last = c.records.at(-1); if (!last || last.key.fromMe) continue;
    let index = c.records.length - 1; while (index > 0 && !c.records[index - 1].key.fromMe) index--;
    const first = c.records[index], waitSeconds = Math.max(0, job.end - timestamp(first)); if (waitSeconds < (args.minWaitingMinutes ?? 0) * 60) continue;
    const lastTs = timestamp(last), sameSecond = c.records.some(m => timestamp(m) === lastTs && m.key.fromMe), { records, ...contact } = c;
    candidates.push({ ...contact, candidateOnly: true, needsHumanReview: true, resolutionStatus: "not_assessed", unreadStatus: "not_queried", waitingSinceRiyadh: localTime(timestamp(first)), waitSeconds, trailingInboundRecords: c.records.length - index, lastMessage: message(last), sameSecondDirectionAmbiguity: sameSecond, caveat: "Ending inbound does not prove a reply was required. Check acknowledgments, media and the complete transcript." });
  }
  candidates.sort((a, b) => b.waitSeconds - a.waitSeconds); const p = page(candidates, args);
  return { ...base(job, args.line), pagination: p.pagination, candidates: p.data, summary: { candidateContactsOrUnresolvedThreads: candidates.length, confirmedUnansweredRequests: null, sourceIndividualRecords: contacts(job).reduce((n, c) => n + c.records.length, 0) }, note: "Checks later messages through the snapshot within the requested lookback, not outside it. Structural triage, not semantic resolution." };
}
function metrics(job, args) {
  const episodes = []; let excludedNonText = 0, sameSecondAmbiguousRecords = 0;
  for (const c of contacts(job)) {
    const signs = new Map(); for (const m of c.records.filter(eligibleText)) { const t = timestamp(m); signs.set(t, (signs.get(t) || 0) | (m.key.fromMe ? 1 : 2)); }
    let pending = null;
    const append = outbound => { const end = outbound ? timestamp(outbound) : job.end, seconds = businessSeconds(timestamp(pending), end, args); episodes.push({ number: c.number, names: c.names, phoneNumberStatus: c.phoneNumberStatus, startedAtRiyadh: localTime(timestamp(pending)), responseAtRiyadh: outbound ? localTime(timestamp(outbound)) : null, status: outbound ? "responded_text_event" : "pending_text_event", elapsedSeconds: Math.max(0, end - timestamp(pending)), businessSeconds: seconds, slaBreached: seconds > args.slaMinutes * 60, semanticAnswerVerified: false }); };
    for (const m of c.records) {
      if (!eligibleText(m)) { excludedNonText++; continue; }
      if (signs.get(timestamp(m)) === 3) { sameSecondAmbiguousRecords++; continue; }
      if (!m.key.fromMe) { pending = pending || m; continue; }
      if (pending) { append(m); pending = null; }
    }
    if (pending) append(null);
  }
  const answered = episodes.filter(e => e.status === "responded_text_event"), waits = answered.map(e => e.businessSeconds).sort((a, b) => a - b), pending = episodes.filter(e => e.status === "pending_text_event"), p = page(episodes, args);
  return { ...base(job, args.line), schedule: { timezone: "Asia/Riyadh", workingDays: args.workingDays, openTime: args.openTime, closeTime: args.closeTime, slaMinutes: args.slaMinutes }, definition: "A within-window inbound text burst ends at the first later eligible school text event, not proof of a substantive answer, first-ever contact response, or resolution. Same-second opposite directions are excluded. Media without captions, reactions and document filenames are excluded. Holidays are not inferred.", summary: { respondedEpisodes: answered.length, pendingEpisodes: pending.length, answeredSlaBreaches: answered.filter(e => e.slaBreached).length, pendingSlaBreaches: pending.filter(e => e.slaBreached).length, meanAnsweredBusinessSeconds: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null, medianAnsweredBusinessSeconds: waits.length ? (waits[Math.floor((waits.length - 1) / 2)] + waits[Math.floor(waits.length / 2)]) / 2 : null, p95AnsweredBusinessSeconds: waits.length ? waits[Math.ceil(waits.length * 0.95) - 1] : null, excludedNonTextRecords: excludedNonText, sameSecondAmbiguousRecords }, pagination: p.pagination, episodes: p.data };
}
function create({ lines, getApi, axios, baseUrl, apiKey, now = () => Date.now(), unreadReader }) {
  const defs = definitions(lines.length), jobs = new Map();
  const transport = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 }, root = String(baseUrl || "").replace(/\/$/, "");
  function configuredTransport() { if (!axios || !root || !apiKey) throw Error("Snapshot transport unavailable"); }
  async function groupMetadata(instance) {
    configuredTransport(); const r = await axios.get(root + "/group/fetchAllGroups/" + encodeURIComponent(instance), { ...transport, params: { getParticipants: "false" } });
    if (!Array.isArray(r.data)) throw Error("Group subjects unavailable");
    return new Map(r.data.filter(g => typeof g.id === "string").map(g => [g.id, { subject: cleanName(g.subject), size: Number.isInteger(g.size) ? g.size : null }]));
  }
  async function load(line, fromDate, throughDate) {
    const api = getApi(lines[line - 1]), key = [line, fromDate, throughDate].join("|"), at = now(), today = new Date(at + 10800000).toISOString().slice(0, 10);
    let job = jobs.get(key); const ttl = throughDate === today ? 60000 : 600000;
    if (job && job.status !== "running" && at - (job.finishedAt || job.created) >= (job.status === "failed" ? 30000 : ttl)) { jobs.delete(key); job = null; }
    if (!job) {
      if ([...jobs.values()].some(j => j.line === line && j.status === "running")) return { status: "running", note: "Another window on this line is being verified; retry." };
      for (const [k, j] of jobs) if (j.status !== "running" && at - j.created > 600000) jobs.delete(k);
      if (jobs.size >= 6) { const oldest = [...jobs].find(([, j]) => j.status !== "running"); if (!oldest) return { status: "running", note: "Reporting capacity busy; retry." }; jobs.delete(oldest[0]); }
      const start = dayBounds(fromDate).start, end = Math.min(dayBounds(throughDate).end, Math.floor(at / 1000));
      job = { line, fromDate, throughDate, start, end, status: "running", created: at, progress: {} }; jobs.set(key, job);
      (async () => {
        try {
          const before = await api.identity(); if (before.name !== lines[line - 1] || !phone(before.ownerJid)) throw Error("Unverified school identity");
          const where = { messageTimestamp: { gte: iso(start), lte: iso(end - 1) } };
          const data = await api.verifiedCollect(api.request, where, { start, end }, p => { job.progress = p; });
          if (!data.coverage?.complete || data.rows.length > 50000) throw Error("Incomplete or oversized window");
          const after = await api.identity(); if (after.name !== before.name || after.ownerJid !== before.ownerJid) throw Error("Account changed");
          const verified = { ...job, ...data, ...aggregate(data.rows), identity: after, status: "complete", date: fromDate, snapshotAt: iso(end), window: { start: iso(start), endExclusive: iso(end), timezone: "Asia/Riyadh" } };
          const resolved = await api.resolveDailyNumbers(verified); Object.assign(job, verified, { resolved, status: "complete", finishedAt: now() });
        } catch (_) { job.status = "failed"; job.finishedAt = now(); job.coverage = { complete: false }; }
      })();
      return { status: "running", note: "Poll the same tool and arguments until verification completes." };
    }
    if (job.status === "complete") { const current = await api.identity(); if (current.name !== job.identity.name || current.ownerJid !== job.identity.ownerJid) { jobs.delete(key); throw Error("Connected school account changed"); } }
    return job;
  }
  function pending(job, args) { return { status: job.status, line: args.line, fromDate: args.fromDate || args.date, throughDate: args.throughDate || args.date, coverage: { complete: false }, phoneNumbersComplete: false, progress: job.progress, note: job.status === "failed" ? "Verification failed, not zero activity. Retry later or narrow dates." : job.note || "Verification running; poll again." }; }
  async function unread(args) {
    configuredTransport(); const reader = unreadReader || require("./unread").unreadReport;
    const data = await reader({ axios, baseUrl: root, apiKey, instance: lines[args.line - 1], line: args.line, fetchGroups: async instance => { const r = await axios.get(root + "/group/fetchAllGroups/" + encodeURIComponent(instance), { ...transport, params: { getParticipants: "true" } }); if (!Array.isArray(r.data)) throw Error("Group mapping unavailable"); return r.data; } });
    const merged = new Map();
    for (const raw of data.items) {
      const number = phone(raw.number, true); if (number === data.accountNumber) continue;
      const id = number || Symbol("unresolved"); if (!merged.has(id)) merged.set(id, { number, names: [], rawThreadCount: 0, unreadBefore: 0, unreadAfter: 0, countersUnchanged: true });
      const item = merged.get(id), name = cleanName(raw.name); if (name && !item.names.includes(name)) item.names.push(name);
      item.rawThreadCount++; item.unreadBefore += raw.unreadBefore; item.unreadAfter = item.unreadAfter === null || raw.unreadAfter === null ? null : item.unreadAfter + raw.unreadAfter;
      if (raw.counterUnchanged !== true) item.countersUnchanged = false;
    }
    const items = [...merged.values()], p = page(items, args);
    return { line: args.line, accountNumber: data.accountNumber, snapshotAt: data.snapshotAt, checkedAt: data.checkedAt, status: "complete", autoReadMessages: data.autoReadMessages, warnings: data.warnings, summary: { rawUnreadChatThreads: data.unreadChatRecords, uniqueVerifiedIndividualNumbers: items.filter(x => x.number).length, unresolvedIndividualThreads: items.filter(x => !x.number).length, groupThreads: data.groups.length, groupUnreadBefore: data.groups.reduce((n, g) => n + g.unreadBefore, 0), newlyUnreadChats: data.newlyUnreadChats }, phoneNumbersComplete: items.every(x => x.number), pagination: p.pagination, contacts: p.data, note: "Live counters, not unanswered requests. Confirmed aliases are grouped but summed counters may overlap. Group subjects are not inferred from senders. Other devices can change read state; this tool does not." };
  }
  async function call(name, args) {
    validate(name, args, lines.length, now()); if (name === NAMES.unread) return unread(args);
    if (name === NAMES.history) {
      const found = [], coverage = [], phoneCoverage = []; let snapshotAt = null;
      for (const line of args.lines) {
        const job = await load(line, args.fromDate, args.throughDate); if (job.status !== "complete") return { ...pending(job, { ...args, line }), requestedLines: args.lines };
        coverage.push(base(job, line)); phoneCoverage.push(job.resolved.totals.phoneNumbersComplete); snapshotAt = snapshotAt && snapshotAt < job.snapshotAt ? snapshotAt : job.snapshotAt;
        for (const c of contacts(job).filter(c => c.number === args.number)) for (const m of c.records) found.push({ line, accountNumber: phone(job.identity.ownerJid), number: c.number, names: c.names, ...message(m) });
      }
      found.sort((a, b) => a.timestamp - b.timestamp || a.line - b.line); const p = page(found, args);
      return { status: "complete", number: args.number, fromDate: args.fromDate, throughDate: args.throughDate, snapshotAt, coverageByLine: coverage, phoneNumbersComplete: phoneCoverage.every(Boolean), pagination: p.pagination, messages: p.data, note: "Verified matches only. Unresolved aliases could hide history. No name/LID guesses or cross-line identity assumptions." };
    }
    const job = await load(args.line, args.fromDate || args.date, args.throughDate || args.date); if (job.status !== "complete") return pending(job, args);
    if (name === NAMES.queue) return queue(job, args); if (name === NAMES.metrics) return metrics(job, args);
    let metadata = new Map(), subjectsAvailable = true; try { metadata = await groupMetadata(lines[args.line - 1]); } catch (_) { subjectsAvailable = false; }
    if (args.groupName && !subjectsAvailable) throw Error("Actual group subjects unavailable; never infer sender names");
    let groups = job.chats.filter(c => c.kind === "group");
    if (args.groupName) { const target = args.groupName.trim().toLowerCase(), matches = [...metadata].filter(([, g]) => g.subject?.trim().toLowerCase() === target); if (matches.length > 1) throw Error("Several groups share that subject; select groupId from inventory"); groups = groups.filter(g => matches.some(([id]) => id === g.jid)); }
    if (args.groupId) groups = groups.filter(c => c.jid === args.groupId);
    let entries;
    if (args.view === "messages") entries = groups.flatMap(g => g.records.map(m => ({ groupId: g.jid, subject: metadata.get(g.jid)?.subject || null, ...message(m) }))).sort((a, b) => a.timestamp - b.timestamp || a.groupId.localeCompare(b.groupId));
    else entries = groups.map(g => ({ groupId: g.jid, subject: metadata.get(g.jid)?.subject || null, messageCount: g.messageCount, sent: g.sent, received: g.received, firstMessageTime: g.firstMessageTime, lastMessageTime: g.lastMessageTime }));
    const p = page(entries, args); return { ...base(job, args.line), subjectsAvailable, subjectSnapshotAt: new Date(now()).toISOString(), pagination: p.pagination, [args.view === "messages" ? "messages" : "groups"]: p.data, note: "Verified group activity. Subjects are current metadata, not guaranteed historical names. No participant numbers exported. Missing subjects stay null, never sender names." };
  }
  return { tools: defs, has: name => defs.some(t => t.name === name), call };
}
module.exports = { create, definitions, validate, businessSeconds, eligibleText, contacts, queue, metrics, NAMES };
