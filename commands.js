// ClickUp-driven commands: anyone (incl. ClickUp Brain) creates a task in the WA Reports list named "RUN: <command>".
// The service picks it up within ~2 minutes, posts the result as comments, and renames the task DONE:/FAILED:.
// Commands:
//   RUN: groups [name filter] [line N]
//   RUN: members <group name> [line N]
//   RUN: week-list YYYY-MM-DD YYYY-MM-DD [line N]
//   RUN: week-score YYYY-MM-DD YYYY-MM-DD [line N]     (task description holds cls=..., cat=..., cmp=...)
//   RUN: week-numbers YYYY-MM-DD YYYY-MM-DD [line N]   (task description holds cls=..., cat=...)
//   RUN: send-image <clickupTaskId> to <exact group name> from +9665XXXXXXXX
//        Sends the task's single image attachment with its "WA Captions" custom field as the caption.
//        Refuses unless the sender number is a connected line and exactly one group has that name.
const retrieval = require("./retrieval");
function install({ axios, api, token, listId, report, fetchGroups, lines, cron }) {
  const H = () => ({ headers: { Authorization: token }, timeout: 30000 });
  let busy = false;
  const callReport = (path, query, params) => new Promise((resolve, reject) => {
    const res = { set() {}, status(c) { this.code = c; return this; }, json(v) { resolve(this.code >= 400 ? { status: "failed", ...v } : v); } };
    Promise.resolve(report.handler({ query: { ...query }, params: params || {} }, res)).catch(reject);
  });
  const comment = async (id, text) => {
    for (let i = 0; i < text.length; i += 9000)
      await axios.post(api + "/task/" + id + "/comment", { comment_text: text.slice(i, i + 9000) }, H());
  };
  const rename = (id, name) => axios.put(api + "/task/" + id, { name }, H());
  const lineOf = s => { const m = s.match(/\bline\s*(\d)\b/i); return m ? Number(m[1]) : 1; };
  const dates = s => s.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const field = (desc, k) => { const m = String(desc || "").match(new RegExp("\\b" + k + "\\s*=\\s*([A-Za-z?_\\-]+)")); return m ? m[1] : ""; };
  const memberNumber = p => { const v = [p.phoneNumber, p.jid, p.id].find(x => typeof x === "string" && x.endsWith("@s.whatsapp.net"));
    return v ? "+" + v.split("@")[0].split(":")[0] : null; };

  // ---- send-image -------------------------------------------------------------
  const evoBase = () => String(process.env.EVO_API_URL || "https://evolution-api-production-3bf028.up.railway.app").replace(/\/$/, "");
  const evoH = () => ({ headers: { apikey: process.env.EVO_API_KEY || "spen-evo-2026-secret", "Content-Type": "application/json" },
    timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity });
  const digits = s => String(s || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  const norm = s => String(s || "").toLowerCase().replace(/\s+/g, "");
  // Rich-text fields can carry <p><br/></p> spacers and tags; WhatsApp would show them literally.
  const cleanCaption = s => String(s || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  async function sendImage(cmd) {
    const m = cmd.match(/^send-image\s+(\S+)\s+to\s+(.+?)\s+from\s+\+?([\d\s]+)$/i);
    if (!m) throw new Error("Use: RUN: send-image <taskId> to <exact group name> from +9665XXXXXXXX");
    const taskId = m[1], groupName = m[2].trim(), phone = m[3].replace(/\D/g, "");

    // 1. Source task: exactly one image + the WA Captions field.
    const t = (await axios.get(api + "/task/" + encodeURIComponent(taskId), H())).data;
    const cf = (t.custom_fields || []).find(f => norm(f.name) === "wacaptions");
    const caption = cf && typeof cf.value === "string" ? cleanCaption(cf.value) : "";
    if (!caption) throw new Error("Task " + taskId + " has no WA Captions value");
    const imgs = (t.attachments || []).filter(a => /^image\//i.test(a.mimetype || "") || /\.(png|jpe?g|webp)(\?|$)/i.test(a.url || a.title || ""));
    if (imgs.length !== 1) throw new Error("Expected exactly 1 image attachment on task " + taskId + ", found " + imgs.length);
    const img = imgs[0];
    let bin;
    try { bin = await axios.get(img.url, { responseType: "arraybuffer", timeout: 60000 }); }
    catch (e) { bin = await axios.get(img.url, { responseType: "arraybuffer", timeout: 60000, headers: { Authorization: token } }); }
    const mimetype = String(bin.headers["content-type"] || img.mimetype || "image/png").split(";")[0];

    // 2. The configured line whose own WhatsApp number is the requested sender.
    const r = await axios.get(evoBase() + "/instance/fetchInstances", evoH());
    const arr = (Array.isArray(r.data) ? r.data : [r.data]).filter(Boolean);
    const inst = arr.map(x => ({ name: x.name || x.instance?.instanceName || x.instanceName,
        owner: x.ownerJid || x.instance?.ownerJid, state: x.connectionStatus || x.instance?.status || x.instance?.state }))
      .find(x => x.name && lines.includes(x.name) && digits(x.owner) === phone);
    if (!inst) throw new Error("No configured line is linked to +" + phone + ". Link it on /connect first. Not sending.");
    if (inst.state !== "open") throw new Error("Line " + inst.name + " (+" + phone + ") is not connected (" + inst.state + "). Not sending.");

    // 3. Exactly one group with that exact name (case/space-insensitive).
    const all = await fetchGroups(inst.name);
    const gs = all.filter(g => norm(g.subject) === norm(groupName));
    if (gs.length !== 1) {
      const near = all.filter(g => norm(g.subject).includes(norm(groupName))).map(g => g.subject).slice(0, 10);
      throw new Error((gs.length ? gs.length + " groups are named \"" + groupName + "\"" : "No group named \"" + groupName + "\" on +" + phone) +
        ". Not sending." + (near.length ? " Similar: " + near.join(", ") : ""));
    }

    // 4. Send image + caption.
    const s = await axios.post(evoBase() + "/message/sendMedia/" + encodeURIComponent(inst.name), {
      number: gs[0].id, mediatype: "image", mimetype, caption, fileName: img.title || "image.png",
      media: Buffer.from(bin.data).toString("base64") }, evoH());
    return { done: true, text: "Sent image + WA Captions from task " + taskId + " to \"" + gs[0].subject + "\" from +" + phone +
      " (line " + (lines.indexOf(inst.name) + 1) + "). WhatsApp message id: " + (s.data?.key?.id || "n/a") };
  }

  async function run(cmd, desc) {
    if (/^send-image\b/i.test(cmd)) return sendImage(cmd);
    const verb = (cmd.split(/\s+/)[0] || "").toLowerCase();
    const n = lineOf(cmd), instance = lines[n - 1];
    if (!instance) throw new Error("Unknown line " + n);
    if (verb === "groups" || verb === "members") {
      const filter = cmd.replace(/^\S+\s*/, "").replace(/\bline\s*\d\b/i, "").trim().toLowerCase().replace(/\s+/g, "");
      if (verb === "members" && filter.length < 2) throw new Error("Give a group name, e.g. RUN: members Grade 5");
      const gs = (await fetchGroups(instance)).filter(g => !filter || String(g.subject || "").toLowerCase().replace(/\s+/g, "").includes(filter))
        .sort((a, b) => String(a.subject).localeCompare(String(b.subject), undefined, { numeric: true }));
      if (verb === "groups") {
        const rows = gs.map(g => { const p = Array.isArray(g.participants) ? g.participants : [];
          return "| " + (g.subject || g.id) + " | " + (p.length || g.size || 0) + " | " + p.filter(x => x.admin).length + " |"; });
        return { done: true, text: "Line " + n + " groups" + (filter ? " matching \"" + filter + "\"" : "") + ": " + gs.length +
          "\n\n| Group | Members | Admins |\n|---|---|---|\n" + rows.join("\n") + "\n\nCounts include the school's own number." };
      }
      if (gs.length > 15) throw new Error(gs.length + " groups match; narrow the name");
      const out = gs.map(g => { const p = Array.isArray(g.participants) ? g.participants : [];
        return "### " + (g.subject || g.id) + " (" + p.length + " members)\n" +
          p.map((x, i) => (i + 1) + ". " + (memberNumber(x) || "hidden number") + (x.admin ? " [admin]" : "")).join("\n"); });
      return { done: true, text: "Line " + n + " members\n\n" + out.join("\n\n") };
    }
    const [from, to] = dates(cmd);
    if (!from || !to) throw new Error("Give two dates: RUN: " + verb + " 2026-10-04 2026-10-08");
    const base = { from, to, line: String(n) };
    const pendingFrom = String(retrieval.dayBounds(to).start + 15 * 3600); // Thursday/last day 15:00 Riyadh
    if (verb === "week-list") {
      let offset = 0, rows = [], first;
      for (;;) {
        const r = await callReport("/report/week", { ...base, lite: "1", limit: "100", offset: String(offset) });
        if (r.status !== "complete") return { done: false, status: r.status, error: r.error };
        first = first || r; rows = rows.concat(r.rows);
        if (r.nextOffset == null) break; offset = r.nextOffset;
      }
      return { done: true, text: "Week list " + from + " to " + to + " (line " + n + "): " + rows.length + " chats, source messages " +
        first.coverage.sourceTotal + ". Classify each index, then create RUN: week-score with cls=, cat=, cmp= in the description.\n\n" +
        rows.map(r => r.i + " | " + (r.name || "-") + " | in " + r.in + " / out " + r.out + " | started by " + r.by + " | " + r.t.join(" // ")).join("\n") };
    }
    if (verb === "week-score" || verb === "week-numbers") {
      const cls = field(desc, "cls"), cat = field(desc, "cat"), cmp = field(desc, "cmp");
      if (!cls || !cat) throw new Error("Put cls=... and cat=... (and cmp=... for week-score) in the task description");
      const q = { ...base, keep: "PN", target: "30", open: "7", close: "15", pendingFrom, cls: cls.replace(/Q/g, "?"), cat, cmp: cmp.replace(/_/g, "-") };
      if (verb === "week-numbers") q.numbers = "1";
      const r = await callReport("/report/week", q);
      if (r.status === "running") return { done: false, status: "running" };
      if (r.status === "failed") throw new Error(r.error || "report failed");
      return { done: true, text: (verb === "week-score" ? "Scored metrics " : "Unreplied / late-replied numbers ") + from + " to " + to +
        " (line " + n + ")\n\n```\n" + JSON.stringify(r, null, 1) + "\n```" };
    }
    throw new Error("Unknown command. Use: groups, members, week-list, week-score, week-numbers, send-image");
  }

  async function tick() {
    if (busy || !token) return; busy = true;
    try {
      // Scan every page of tasks created in the last 3 days. Page 0 alone misses new RUN tasks
      // once the daily import fills the list with chat tasks.
      const since = Date.now() - 3 * 86400000, found = [];
      for (let page = 0; page < 20; page++) {
        const r = await axios.get(api + "/list/" + listId + "/task", { ...H(), params: { order_by: "created", page, subtasks: true, date_created_gt: since } });
        const tasks = Array.isArray(r.data.tasks) ? r.data.tasks : [];
        found.push(...tasks.filter(t => /^\s*RUN\s*[:\-]/i.test(t.name)));
        if (r.data.last_page === true || tasks.length === 0) break;
      }
      if (found.length) console.log("commands: found " + found.length + " RUN task(s): " + found.map(t => t.name).join(" | "));
      for (const t of found.slice(0, 3)) {
        const cmd = t.name.replace(/^\s*RUN\s*[:\-]\s*/i, "").replace(/\s*\(working\)$/, "").trim();
        try {
          const out = await run(cmd, t.description || t.text_content);
          if (!out.done) { if (!t.name.includes("(working)")) await rename(t.id, t.name + " (working)"); continue; }
          // Rename first so a one-shot command (send-image) can never run twice if the comment post fails.
          await rename(t.id, "DONE: " + cmd).catch(() => {});
          await comment(t.id, out.text).catch(() => {});
          console.log("commands: DONE " + cmd);
        } catch (e) {
          console.log("commands: FAILED " + cmd + " - " + e.message);
          await rename(t.id, "FAILED: " + cmd).catch(() => {});
          await comment(t.id, "Failed: " + e.message).catch(() => {});
        }
      }
    } catch (e) { console.log("commands: tick error - " + (e.response?.status ? "HTTP " + e.response.status : e.message)); }
    finally { busy = false; }
  }
  cron.schedule("*/2 * * * *", tick, { timezone: "Asia/Riyadh" });
  return { tick, run };
}
module.exports = { install };
