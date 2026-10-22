// Live unread counters over HTTP: GET /unread?line=N (counts + display names only, never phone numbers).
// Read-only: one /chat/findChats call; no mark-as-read, no settings changes, no messages sent.
const BUILD = "unread-route-v1";
const jidOf = c => c.remoteJid || c.lastMessage?.key?.remoteJid || (typeof c.id === "string" && c.id.includes("@") ? c.id : "");
const tsOf = c => {
  const v = c.lastMessage?.messageTimestamp ?? c.lastMessageTimestamp ?? c.updatedAt;
  const n = typeof v === "object" && v ? Number(v.low) : Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : n;
  const d = Date.parse(v); return Number.isFinite(d) ? Math.floor(d / 1000) : null;
};
const riyadh = sec => sec ? new Date((sec + 10800) * 1000).toISOString().slice(0, 16).replace("T", " ") : null;
function install(app, { axios, baseUrl, apiKey, lines }) {
  app.get("/unread", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const n = Number(req.query.line || 1), instance = lines[n - 1];
      if (!instance) return res.status(400).json({ error: "Unknown line; use 1-" + lines.length });
      const r = await axios.post(String(baseUrl).replace(/\/$/, "") + "/chat/findChats/" + encodeURIComponent(instance), {},
        { headers: { apikey: apiKey, "Content-Type": "application/json" }, timeout: 60000 });
      if (!Array.isArray(r.data)) throw new Error("Chat list unavailable; not an empty unread report");
      const unread = r.data.filter(c => Number.isInteger(c.unreadCount) && c.unreadCount > 0);
      const isInd = c => /@(lid|s\.whatsapp\.net)$/.test(jidOf(c));
      const row = c => ({ name: c.name || c.pushName || "Unnamed contact", unread: c.unreadCount, lastMessageRiyadh: riyadh(tsOf(c)) });
      const people = unread.filter(isInd).map(row).sort((a, b) => String(b.lastMessageRiyadh).localeCompare(String(a.lastMessageRiyadh)));
      const groups = unread.filter(c => jidOf(c).endsWith("@g.us")).map(row).sort((a, b) => b.unread - a.unread);
      const sum = a => a.reduce((s, x) => s + x.unread, 0);
      res.json({ build: BUILD, line: n, instance, snapshotAt: new Date().toISOString(), chatListRecords: r.data.length,
        individualUnreadChats: people.length, individualUnreadMessages: sum(people),
        groupUnreadChats: groups.length, groupUnreadMessages: sum(groups), people, groups,
        note: "Stored Evolution unread counters. Names only; phone numbers are never returned on this public route." });
    } catch (e) {
      res.status(502).json({ error: e.message && e.message.startsWith("Chat list") ? e.message :
        "Unread lookup failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") });
    }
  });
  return { BUILD };
}
module.exports = { install, BUILD };
