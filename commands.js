// ClickUp-driven commands: anyone (incl. ClickUp Brain) creates a task in the WA Reports list named "RUN: <command>".
// The service picks it up within ~2 minutes, posts the result as comments, and renames the task DONE:/FAILED:.
// Commands:
//   RUN: groups [name filter] [line N]
//   RUN: members <group name> [line N]
//   RUN: week-list YYYY-MM-DD YYYY-MM-DD [line N]
//   RUN: week-score YYYY-MM-DD YYYY-MM-DD [line N]     (task description holds cls=..., cat=..., cmp=...)
//   RUN: week-numbers YYYY-MM-DD YYYY-MM-DD [line N]   (task description holds cls=..., cat=...)
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

  async function run(cmd, desc) {
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
    throw new Error("Unknown command. Use: groups, members, week-list, week-score, week-numbers");
  }

  async function tick() {
    if (busy || !token) return; busy = true;
    try {
      const r = await axios.get(api + "/list/" + listId + "/task", { ...H(), params: { order_by: "created", reverse: true, page: 0, subtasks: true } });
      for (const t of (r.data.tasks || []).filter(t => /^\s*RUN\s*[:\-]/i.test(t.name)).slice(0, 3)) {
        const cmd = t.name.replace(/^\s*RUN\s*[:\-]\s*/i, "").trim();
        try {
          const out = await run(cmd, t.description || t.text_content);
          if (!out.done) { if (!t.name.includes("(working)")) await rename(t.id, t.name + " (working)"); continue; }
          await comment(t.id, out.text);
          await rename(t.id, "DONE: " + cmd.replace(/\s*\(working\)$/, ""));
        } catch (e) {
          await comment(t.id, "Failed: " + e.message).catch(() => {});
          await rename(t.id, "FAILED: " + cmd.replace(/\s*\(working\)$/, "")).catch(() => {});
        }
      }
    } catch (e) { /* ClickUp unreachable; retry next tick */ }
    finally { busy = false; }
  }
  cron.schedule("*/2 * * * *", tick, { timezone: "Asia/Riyadh" });
  return { tick, run };
}
module.exports = { install };
