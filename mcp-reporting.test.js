"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { install } = require("./mcp-reporting");
const { aggregate, dayBounds } = require("./retrieval");
// Synthetic credentials and contacts only. Never calls a real service.
const key = "synthetic-mcp-key-00000000000000000000000000000000";
const owner = "966500000000@s.whatsapp.net", pn = "966500000001@s.whatsapp.net", lid = "111111111111111@lid";
const date = "2026-11-16", bounds = dayBounds(date);
const rows = [[lid, false], [pn, true], ["222222222222222@lid", false], ["123@g.us", false], [owner, true]].map(([jid, fromMe], i) => ({ id: "synthetic-" + i, key: { remoteJid: jid, fromMe }, messageTimestamp: bounds.start + i, pushName: "Synthetic contact", messageType: "conversation", message: { conversation: "synthetic text" } }));
const baseJob = () => ({ status: "complete", date, rows, ...aggregate(rows), identity: { name: "nasa-test", ownerJid: owner }, coverage: { complete: true, passesVerified: 2, passes: ["internal-audit"] }, window: { start: new Date(bounds.start * 1000).toISOString(), endExclusive: new Date(bounds.end * 1000).toISOString(), timezone: "Asia/Riyadh" } });
const resolved = () => ({ byJid: new Map([
  [lid, { phoneNumber: "+966500000001", phoneNumberStatus: "verified", phoneNumberSources: ["alternate"], phoneNumberReason: null }],
  [pn, { phoneNumber: "+966500000001", phoneNumberStatus: "verified", phoneNumberSources: ["phone JID"], phoneNumberReason: null }],
  ["222222222222222@lid", { phoneNumber: null, phoneNumberStatus: "unresolved", phoneNumberSources: [], phoneNumberReason: "phone not exposed" }],
  [owner, { phoneNumber: null, phoneNumberStatus: "school_account", phoneNumberSources: [], phoneNumberReason: null }]
]), totals: { individualThreads: 3, resolvedThreads: 2, uniquePhoneNumbers: 1, unresolvedThreads: 1, phoneNumbersComplete: false } });
function harness(options = {}) {
  let handler, reads = 0, mappings = 0;
  const api = { identity: async () => { reads++; return { name: "nasa-test", ownerJid: owner, connectionStatus: "open" }; }, getDailyJob: d => { reads++; assert.equal(d, date); return baseJob(); }, resolveDailyNumbers: async () => { mappings++; return resolved(); }, ...options.api };
  install({ all(path, fn) { assert.equal(path, "/mcp"); handler = fn; } }, { lines: ["nasa-test", "nasa-test-2", "nasa-test-3"], getApi: name => { if (options.selected) options.selected.push(name); return api; }, apiKey: key, ...options.config });
  async function send(body, headers = { authorization: "Bearer " + key }, query = {}, method = "POST") {
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, end() { this.ended = true; return this; } };
    await handler({ body, method, query, get: name => headers[name.toLowerCase()] }, res); return res;
  }
  return { send, reads: () => reads, mappings: () => mappings };
}
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", method, params, id });
const call = (name, args = { line: 1, date }) => rpc("tools/call", { name, arguments: args });
const parse = res => JSON.parse(res.body.result.content[0].text);
test("MCP refuses missing/weak credentials before any data access", async () => {
  for (const apiKey of ["", "short", " " + key]) { const h = harness({ config: { apiKey } }), r = await h.send(rpc("tools/list")); assert.equal(r.code, 503); assert.equal(h.reads(), 0); }
});
test("MCP accepts protected bearer or x-api-key, not missing/wrong/conflicting credentials", async () => {
  const h = harness();
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer " + key, "x-api-key": "wrong" }]) assert.equal((await h.send(rpc("tools/list"), headers)).code, 401);
  assert.equal((await h.send(rpc("tools/list"), { "x-api-key": key })).code, 200); assert.equal(h.reads(), 0);
});
test("MCP rejects URL credentials and untrusted browser origins", async () => {
  const h = harness();
  assert.equal((await h.send(rpc("tools/list"), undefined, { key })).code, 400);
  assert.equal((await h.send(rpc("tools/list"), { authorization: "Bearer " + key, origin: "https://evil.invalid" })).code, 403); assert.equal(h.reads(), 0);
});
test("MCP supports initialization, ping, notifications, JSON-only stateless transport", async () => {
  const h = harness(), init = await h.send(rpc("initialize", { protocolVersion: "2025-06-18" }));
  assert.equal(init.body.result.protocolVersion, "2025-06-18"); assert.equal(init.body.result.serverInfo.name, "nasa-wa-reporting");
  assert.deepEqual((await h.send(rpc("ping"))).body.result, {});
  const notice = await h.send({ jsonrpc: "2.0", method: "notifications/initialized" }); assert.equal(notice.code, 202);
  for (const method of ["GET", "DELETE", "PUT"]) assert.equal((await h.send({}, undefined, {}, method)).code, 405);
  assert.equal(init.headers["Cache-Control"], "no-store");
});
test("MCP advertises only three read-only reporting tools", async () => {
  const r = await harness().send(rpc("tools/list")); assert.equal(r.body.result.tools.length, 3);
  for (const t of r.body.result.tools) { assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.inputSchema.additionalProperties, false); }
});
test("MCP validates arguments before upstream reads", async () => {
  const h = harness();
  for (const args of [{ line: 0, date }, { line: 4, date }, { line: 1, date: "2026-02-30" }, { line: 1, date, limit: 0 }, { line: 1, date, offset: -1 }, { line: 1, date, endpoint: "/run" }]) assert.equal((await h.send(call("nasa_wa_daily_report", args))).body.result.isError, true);
  assert.equal(h.reads(), 0);
});
test("MCP reads account identity without operational connection routes", async () => {
  const selected = [], h = harness({ selected }), r = parse(await h.send(call("nasa_wa_connection_status", { line: 3 })));
  assert.equal(r.accountNumber, "+966500000000"); assert.deepEqual(selected, ["nasa-test-3"]); assert.equal(h.mappings(), 0);
});
test("MCP merges phone aliases and independently paginates unresolved contacts", async () => {
  const h = harness(), a = parse(await h.send(call("nasa_wa_daily_report", { line: 1, date, limit: 1 })));
  assert.equal(a.chats.length, 1); assert.equal(a.chats[0].number, "+966500000001"); assert.equal(a.chats[0].rawThreadCount, 2); assert.equal(a.chats[0].messageCount, 2);
  assert.equal(a.chats[0].sent, 1); assert.equal(a.chats[0].received, 1); assert.equal(a.pagination.total, 2); assert.equal(a.pagination.nextOffset, 1); assert.equal(a.phoneNumbersComplete, false); assert.equal(a.coverage.passes, undefined);
  const b = parse(await h.send(call("nasa_wa_daily_report", { line: 1, date, limit: 1, offset: 1 })));
  assert.equal(b.chats[0].number, null); assert.equal(b.pagination.nextOffset, null); assert.ok(!JSON.stringify(a).includes(lid)); assert.ok(!JSON.stringify(b).includes("222222222222222@lid"));
});
test("MCP message pages exclude groups/self and preserve direction/time", async () => {
  const h = harness(), a = parse(await h.send(call("nasa_wa_daily_messages", { line: 1, date, limit: 2 })));
  assert.equal(a.messages.length, 2); assert.equal(a.pagination.total, 3); assert.equal(a.messages[0].timeRiyadh, "2026-11-16T00:00:00+03:00");
  assert.equal(a.messages[0].direction, "received"); assert.equal(a.messages[1].direction, "sent"); assert.equal(a.messages[1].number, "+966500000001"); assert.equal(a.pagination.nextOffset, 2);
  assert.ok(!JSON.stringify(a).includes("@g.us")); assert.ok(!JSON.stringify(a).includes("@lid"));
});
test("MCP running/failed jobs never become zero-activity complete reports", async () => {
  for (const status of ["running", "failed"]) { const h = harness({ api: { getDailyJob: () => ({ status, coverage: { complete: false } }) } }); const r = parse(await h.send(call("nasa_wa_daily_report"))); assert.equal(r.status, status); assert.equal(r.phoneNumbersComplete, false); assert.equal(r.chats, undefined); assert.equal(h.mappings(), 0); }
});
test("MCP rejects mismatched dates, windows and line identity", async () => {
  for (const change of [{ date: "2026-11-15" }, { identity: { name: "other" } }, { window: { timezone: "UTC" } }]) { const h = harness({ api: { getDailyJob: () => ({ ...baseJob(), ...change }) } }); const r = await h.send(call("nasa_wa_daily_report")); assert.equal(r.body.result.isError, true); assert.equal(h.mappings(), 0); }
});
test("MCP sanitizes upstream errors and has no arbitrary API/operational tool", async () => {
  const h = harness({ api: { resolveDailyNumbers: async () => { throw Error("PRIVATE secret payload"); } } }); const r = await h.send(call("nasa_wa_daily_report"));
  assert.equal(r.body.result.isError, true); assert.ok(!JSON.stringify(r).includes("PRIVATE")); assert.equal((await h.send(call("send-text"))).body.result.isError, true); assert.equal((await h.send(rpc("unknown"))).body.error.code, -32601);
});
test("MCP rejects invalid JSON-RPC batches/ids and unsupported protocol headers", async () => {
  const h = harness(); for (const body of [[], null, { method: "ping", id: 1 }, { jsonrpc: "2.0", method: "ping", id: {} }]) assert.equal((await h.send(body)).body.error.code, -32600);
  assert.equal((await h.send(rpc("ping"), { authorization: "Bearer " + key, "mcp-protocol-version": "invalid" })).code, 400);
});
