// Read-only unread snapshots for the private ClickUp command bridge.
// Never infer a phone number from a LID, display name, or a group ID.
const PN = /^(?:[1-9]\d{6,14})(?::\d+)?@s\.whatsapp\.net$/;
const isPn = v => typeof v === "string" && PN.test(v);
const isLid = v => typeof v === "string" && /^\d+(?::\d+)?@lid$/.test(v);
const canonical = v => isPn(v) ? v.split("@")[0].split(":")[0] + "@s.whatsapp.net" : null;
const format = v => canonical(v) ? "+" + canonical(v).split("@")[0] : null;
const jidOf = c => c.remoteJid || c.lastMessage?.key?.remoteJid ||
  (typeof c.id === "string" && c.id.includes("@") ? c.id : "");

class PhoneMap {
  constructor() { this.links = new Map(); }
  add(lid, pn, source) {
    if (!isLid(lid) || !isPn(pn)) return;
    const values = this.links.get(lid) || new Map();
    values.set(canonical(pn), source);
    this.links.set(lid, values);
  }
  contact(c, source) {
    const ids = [c.id, c.lid, c.remoteJid, c.jid, c.phoneNumber];
    for (const lid of ids.filter(isLid))
      for (const pn of ids.filter(isPn)) this.add(lid, pn, source);
  }
  message(m, jid) {
    if (m.key?.remoteJid !== jid) return;
    // A direct-chat alternate address identifies the chat, unlike group participants.
    for (const pn of [m.key.remoteJidAlt, m.remoteJidAlt, m.key.previousRemoteJid])
      this.add(jid, pn, "message alternate address");
    // senderPn identifies the contact only on inbound direct messages.
    if (m.key.fromMe === false)
      this.add(jid, m.key.senderPn, "inbound sender address");
  }
  resolve(jid) {
    if (isPn(jid)) return { number: format(jid), numberSource: "phone-addressed chat" };
    const values = this.links.get(jid);
    if (!values?.size) return { number: null, numberSource: "unavailable: no verified phone mapping" };
    if (values.size !== 1) return { number: null, numberSource: "unavailable: conflicting phone mappings" };
    const [[pn, source]] = values;
    return { number: format(pn), numberSource: source };
  }
}

async function unreadReport({ axios, baseUrl, apiKey, instance, line, expectedSuffix, fetchGroups }) {
  const base = String(baseUrl).replace(/\/$/, "");
  const opts = { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 30000 };
  const path = p => base + p + "/" + encodeURIComponent(instance);
  const warnings = [];
  async function identity() {
    const r = await axios.get(base + "/instance/fetchInstances", opts);
    const list = Array.isArray(r.data) ? r.data : [r.data];
    const x = list.find(x => (x.name || x.instance?.instanceName || x.instanceName) === instance);
    const owner = x?.ownerJid || x?.instance?.ownerJid;
    if (!isPn(owner)) throw new Error("Connected line phone number could not be verified");
    const state = x.connectionStatus || x.instance?.status || x.instance?.state;
    if (state !== "open") throw new Error("Selected WhatsApp line is not connected");
    if (expectedSuffix && !format(owner).endsWith(expectedSuffix))
      throw new Error("Selected line does not match the requested phone suffix");
    return canonical(owner);
  }
  async function chats() {
    const r = await axios.post(path("/chat/findChats"), {}, opts);
    if (!Array.isArray(r.data)) throw new Error("Chat list is unavailable; not an empty unread report");
    const seen = new Set();
    for (const c of r.data) {
      const jid = jidOf(c);
      if (!jid || seen.has(jid) || !Number.isInteger(c.unreadCount) || c.unreadCount < 0)
        throw new Error("Chat list has missing, duplicate, or invalid unread counters");
      seen.add(jid);
    }
    return r.data;
  }
  const owner = await identity();
  let autoReadMessages = null;
  try {
    const r = await axios.get(path("/settings/find"), opts);
    if (typeof r.data?.readMessages === "boolean") autoReadMessages = r.data.readMessages;
  } catch (_) { /* optional settings inspection, never mutate settings */ }
  if (autoReadMessages !== false)
    warnings.push(autoReadMessages === true ? "Automatic read receipts are enabled on this line." :
      "Live automatic-read setting could not be verified.");
  const snapshotAt = new Date().toISOString();
  const before = await chats();
  const unread = before.filter(c => c.unreadCount > 0);
  const individuals = unread.filter(c => isLid(jidOf(c)) || isPn(jidOf(c)));
  const map = new PhoneMap();
  // Contacts are optional: old Evolution versions may store no LID/PN links.
  try {
    const seen = new Set();
    for (let page = 1; ; page++) {
      if (page > 1000) throw new Error("contact pagination limit");
      const r = await axios.post(path("/chat/findContacts"), { where: {}, offset: 500, page }, opts);
      if (!Array.isArray(r.data)) throw new Error("invalid contact response");
      if (!r.data.length) break;
      for (const c of r.data) {
        const key = c.id || JSON.stringify(c);
        if (seen.has(key)) throw new Error("contact pagination repeated records");
        seen.add(key);
        map.contact(c, "contact record");
      }
    }
  } catch (_) { warnings.push("Contact lookup incomplete; other verified mapping sources were used where available."); }
  if (individuals.some(c => isLid(jidOf(c)))) {
    try {
      const groups = await fetchGroups(instance);
      if (!Array.isArray(groups)) throw new Error("invalid group response");
      for (const g of groups)
        for (const p of (Array.isArray(g.participants) ? g.participants : []))
          map.contact(p, "group roster");
    } catch (_) { warnings.push("Group-roster mapping unavailable; no numbers were guessed."); }
  }
  for (const c of individuals) {
    const jid = jidOf(c);
    map.contact(c, "chat metadata");
    if (c.lastMessage) map.message(c.lastMessage, jid);
    if (!isLid(jid)) continue;
    try {
      const r = await axios.post(path("/chat/findMessages"),
        { where: { key: { remoteJid: jid } }, offset: 50, page: 1 }, opts);
      if (!Array.isArray(r.data?.messages?.records)) throw new Error("invalid message response");
      for (const m of r.data.messages.records) map.message(m, jid);
    } catch (_) { warnings.push("Recent-message mapping unavailable for one or more unread chats."); }
  }
  const after = await chats();
  if (await identity() !== owner) throw new Error("Connected number changed during snapshot");
  const byJid = new Map(after.map(c => [jidOf(c), c]));
  const items = individuals.map(c => {
    const jid = jidOf(c), current = byJid.get(jid);
    return {
      name: c.name || c.pushName || "Unnamed contact",
      ...map.resolve(jid),
      unreadBefore: c.unreadCount,
      unreadAfter: current ? current.unreadCount : null,
      counterUnchanged: current ? c.unreadCount === current.unreadCount : null
    };
  });
  const groups = unread.filter(c => jidOf(c).endsWith("@g.us")).map(c => ({
    name: c.name || c.pushName || "Unnamed group", unreadBefore: c.unreadCount,
    unreadAfter: byJid.get(jidOf(c))?.unreadCount ?? null
  }));
  return {
    line, accountNumber: format(owner), snapshotAt, checkedAt: new Date().toISOString(),
    autoReadMessages, chatListRecords: before.length, unreadChatRecords: unread.length,
    individualUnreadChats: items.length, resolvedNumbers: items.filter(x => x.number).length,
    unresolvedNumbers: items.filter(x => !x.number).length, items, groups,
    newlyUnreadChats: after.filter(c => c.unreadCount > 0 &&
      !before.some(b => jidOf(b) === jidOf(c) && b.unreadCount > 0)).length,
    warnings: [...new Set(warnings)],
    note: "Stored Evolution counters, not an independent WhatsApp receipt audit. Only read-only lookup endpoints were called. No settings changed, messages sent, or mark-as-read requests issued. Recent-message sampling resolves identities only; it is not a full transcript report. Null numbers are unavailable, never LIDs or name-based guesses."
  };
}
module.exports = { PhoneMap, unreadReport, format };
