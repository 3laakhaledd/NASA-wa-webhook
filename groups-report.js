// GET /groups/report : saves ONE ClickUp task with group counts for every line.
// Counts only (members / admins / parents); phone numbers are never written or returned.
function install(app, lines, fetchGroups, { axios, clickupApi, token, listId }) {
  app.get("/groups/report", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const date = new Date(Date.now() + 10800000).toISOString().slice(0, 10);
    const sections = [], summary = [];
    for (const [i, instance] of lines.entries()) {
      const head = "## Line " + (i + 1) + " (" + instance + ")";
      let data;
      try { data = await fetchGroups(instance); }
      catch (e) {
        sections.push(head + "\n\nCould not read groups" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") + ".");
        summary.push({ line: i + 1, instance, ok: false });
        continue;
      }
      const rows = data.map(g => {
        const parts = Array.isArray(g.participants) ? g.participants : [];
        const members = parts.length || (Number.isInteger(g.size) ? g.size : 0);
        const admins = parts.filter(p => p.admin === "admin" || p.admin === "superadmin").length;
        return { name: String(g.subject || g.id).replace(/\|/g, "/"), members, admins, parents: Math.max(members - admins, 0) };
      }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const t = rows.reduce((a, r) => ({ members: a.members + r.members, admins: a.admins + r.admins, parents: a.parents + r.parents }),
        { members: 0, admins: 0, parents: 0 });
      sections.push([head, "", "| # | Group | Members | Admins | Parents |", "|---|---|---|---|---|",
        ...rows.map((r, n) => "| " + (n + 1) + " | " + r.name + " | " + r.members + " | " + r.admins + " | " + r.parents + " |"),
        "| | **Total (" + rows.length + " groups)** | **" + t.members + "** | **" + t.admins + "** | **" + t.parents + "** |"].join("\n"));
      summary.push({ line: i + 1, instance, ok: true, groups: rows.length, ...t });
    }
    const md = "Pulled: " + new Date().toISOString() +
      "\nParents = members minus admins (non-admin staff count as parents; the connected number itself is included).\n\n" +
      sections.join("\n\n");
    try {
      const r = await axios.post(clickupApi + "/list/" + listId + "/task",
        { name: "WA groups report (" + date + ")", description: md, markdown_content: md },
        { headers: { Authorization: token }, timeout: 30000 });
      res.json({ ok: true, task: r.data.url, lines: summary });
    } catch (e) {
      res.json({ ok: false, error: "ClickUp write failed" + (e.response?.status ? " (HTTP " + e.response.status + ")" : "") +
        (token ? "" : " - CLICKUP_API_TOKEN not set"), lines: summary });
    }
  });
}
module.exports = { install };
