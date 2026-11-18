"use strict";
const crypto = require("node:crypto");
const LIST_ID = "901423352229";
const ACCOUNTS = { 1: "+966531206444", 2: "+966531208444", 3: "+966531207444" };
const TOOLS = new Set(["daily_report", "daily_messages", "connection_status", "unread_snapshot", "group_insights", "contact_history", "follow_up_queue", "response_metrics"]);
function parse(task) {
  const cmd = task.name.replace(/^\s*RUN\s*[:\-]\s*/i, "").replace(/\s*\(working\)$/, "").trim();
  let m;
  if ((m = cmd.match(/^daily-chats (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (\d{2}:\d{2}) line ([123]) ending (\d{4,15})$/i))) {
    const minutes = (s, end) => {
      if (s === "24:00" && end) return 1440;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw Error("Invalid Riyadh time");
      return Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    };
    const from = minutes(m[2], false), to = minutes(m[3], true), line = Number(m[4]);
    if (to <= from || !ACCOUNTS[line].endsWith(m[5])) throw Error("Invalid time window or school number ending");
    return { tool: "daily_messages", args: { date: m[1], line }, filter: { from, to } };
  }
  if ((m = cmd.match(/^daily-report (\d{4}-\d{2}-\d{2}) line ([123])$/i)))
    return { tool: "daily_report", args: { date: m[1], line: Number(m[2]) } };
  if ((m = cmd.match(/^unread line ([123]) ending (\d{4,15})$/i))) {
    if (!ACCOUNTS[Number(m[1])].endsWith(m[2])) throw Error("Wrong school number ending");
    return { tool: "unread_snapshot", args: { line: Number(m[1]) } };
  }
  if (cmd.toLowerCase() !== "report") throw Error("Read-only requests only. Use RUN: report with a JSON description, or RUN: daily-report YYYY-MM-DD line N.");
  let payload;
  try { payload = JSON.parse(task.description || task.text_content || ""); }
  catch (_) { throw Error("Description must be JSON: {\"tool\":\"daily_report\",\"line\":1,\"date\":\"YYYY-MM-DD\"}"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !TOOLS.has(payload.tool)) throw Error("Unsupported read-only report");
  const { tool, ...args } = payload;
  if (!ACCOUNTS[args.line]) throw Error("Choose line 1, 2 or 3");
  if (Object.hasOwn(args, "offset") || Object.hasOwn(args, "limit")) throw Error("Pagination is automatic; omit offset and limit");
  return { tool, args };
}
function install({ axios, call, token = process.env.CLICKUP_API_TOKEN, listId = LIST_ID,
  api = "https://api.clickup.com/api/v2", cron = require("node-cron") }) {
  let busy = false;
  const attempts = new Map();
  const H = () => ({ headers: { Authorization: token }, timeout: 30000 });
  const rename = (id, name) => axios.put(api + "/task/" + id, { name }, H());
  const comment = (id, text) => axios.post(api + "/task/" + id + "/comment", { comment_text: text }, H());
  async function read(req) {
    const pages = [], seen = new Set();
    let offset = 0;
    for (let page = 0; page < 10000; page++) {
      const args = { ...req.args };
      if (["daily_report", "daily_messages", "group_insights", "contact_history", "follow_up_queue"].includes(req.tool)) Object.assign(args, { offset, limit: 200 });
      const raw = await call("nasa_wa_" + req.tool, args);
      if (raw?.isError) throw Error("Protected report rejected this request; check its arguments or source availability");
      const text = raw?.content?.find(x => x.type === "text")?.text;
      if (!text) throw Error("Missing report response");
      let data;
      try { data = JSON.parse(text); } catch (_) { throw Error("Invalid report response"); }
      if (data.status === "running") return null;
      if (data.status === "failed") throw Error("Source verification failed; retrying the same request");
      if (data.line !== req.args.line || data.accountNumber !== ACCOUNTS[req.args.line]) throw Error("School account verification mismatch");
      if (req.args.date && data.date !== req.args.date) throw Error("Report date mismatch");
      if (["daily_report", "daily_messages"].includes(req.tool) && (data.status !== "complete" || data.coverage?.complete !== true)) throw Error("Daily message coverage is incomplete");
      if (req.filter && Array.isArray(data.messages)) {
        data = { ...data, requestedTimeWindow: { fromMinutes: req.filter.from, toMinutesExclusive: req.filter.to, timezone: "Asia/Riyadh" }, messages: data.messages.filter(m => {
          const t = new Date((m.timestamp + 10800) * 1000), min = t.getUTCHours() * 60 + t.getUTCMinutes();
          return min >= req.filter.from && min < req.filter.to;
        }) };
      }
      pages.push(data);
      const next = data.pagination?.nextOffset;
      if (next == null) return pages;
      if (!Number.isSafeInteger(next) || next <= offset || seen.has(next)) throw Error("Invalid report pagination");
      seen.add(next); offset = next;
    }
    throw Error("Report pagination exceeded the safety limit; not a complete result");
  }
  async function deliver(task, req, pages) {
    const result = JSON.stringify({ request: req, allPagesRetrieved: true, pages }, null, 2);
    const digest = crypto.createHash("sha256").update(result).digest("hex").slice(0, 16);
    const chunks = result.match(/[\s\S]{1,7500}/gu) || [""];
    const existing = new Set();
    let before;
    for (let page = 0; page < 10000; page++) {
      const response = await axios.get(api + "/task/" + task.id + "/comment", { ...H(), params: before || {} });
      const comments = response.data?.comments;
      if (!Array.isArray(comments)) throw Error("Cannot verify existing result comments");
      for (const c of comments) existing.add(c.comment_text || (c.comment || []).map(x => x.text || "").join(""));
      if (comments.length < 25) break;
      const last = comments.at(-1), next = { start: last.date, start_id: last.id };
      if (before && before.start_id === next.start_id) throw Error("Result-comment pagination repeated");
      before = next;
      if (page === 9999) throw Error("Could not verify all existing comments");
    }
    for (let i = 0; i < chunks.length; i++) {
      const marker = `[WA REQUEST ${task.id} result ${digest} part ${i + 1}/${chunks.length}]`;
      if (![...existing].some(t => t.startsWith(marker))) await comment(task.id, marker + "\n" + chunks[i]);
    }
    const cmd = task.name.replace(/^\s*RUN\s*[:\-]\s*/i, "").replace(/\s*\(working\)$/, "").trim();
    await rename(task.id, "DONE: " + cmd);
  }
  async function tick() {
    if (busy || !token) return;
    busy = true;
    try {
      const found = [];
      for (let page = 0; page < 10000; page++) {
        const r = await axios.get(api + "/list/" + listId + "/task", { ...H(), params: { page, order_by: "created", subtasks: true } });
        const tasks = r.data?.tasks;
        if (!Array.isArray(tasks)) throw Error("Request List is not accessible");
        found.push(...tasks.filter(t => /^\s*RUN\s*[:\-]/i.test(t.name)));
        if (r.data.last_page === true || !tasks.length) break;
        if (page === 9999) throw Error("Request List pagination incomplete");
      }
      for (const task of found.slice(0, 3)) {
        let req;
        try { req = parse(task); }
        catch (e) {
          await comment(task.id, "Request rejected: " + e.message);
          await rename(task.id, "FAILED: " + task.name.replace(/^\s*RUN\s*[:\-]\s*/i, ""));
          continue;
        }
        try {
          const pages = await read(req);
          if (!pages) {
            if (!task.name.endsWith("(working)")) await rename(task.id, task.name + " (working)");
            continue;
          }
          await deliver(task, req, pages);
          attempts.delete(task.id);
        } catch (_) {
          const count = (attempts.get(task.id) || 0) + 1;
          attempts.set(task.id, count);
          if (count >= 3) {
            await comment(task.id, "Request failed after three attempts. No complete result was delivered. Check the request arguments, selected account and source availability; do not treat this as zero activity.");
            await rename(task.id, "FAILED: " + task.name.replace(/^\s*RUN\s*[:\-]\s*/i, "").replace(/\s*\(working\)$/, ""));
            attempts.delete(task.id);
          }
        }
      }
    } catch (_) { console.log("WA Requests: queue unavailable; will retry on next scheduled check"); }
    finally { busy = false; }
  }
  cron.schedule("*/2 * * * *", tick, { timezone: "Asia/Riyadh" });
  return { tick, read };
}
module.exports = { install, parse, LIST_ID };
