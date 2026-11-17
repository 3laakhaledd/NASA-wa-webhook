const test = require("node:test");
const assert = require("node:assert/strict");
const { phone, resolve, mappingEvidence, authorized, install } = require("./phone-numbers");
// Synthetic fixtures only.
const owner = "966500000000@s.whatsapp.net", pn = "966500000001@s.whatsapp.net";
const lid = "111111111111111@lid";
const msg = (jid, extra = {}, fromMe = false) => ({ key: { remoteJid: jid, fromMe, ...extra }, pushName: fromMe ? "" : "Contact" });
test("never parses a numeric LID or arbitrary digits as a phone", () => {
  assert.equal(phone(lid), null); assert.equal(phone("111111111111111"), null);
  assert.equal(phone(pn), "+966500000001");
});
test("includes outbound-only and inbound chats and merges verified aliases", () => {
  const r = resolve([msg(pn, {}, true), msg(lid, { remoteJidAlt: pn })], owner);
  assert.equal(r.individualThreads, 2); assert.equal(r.uniquePhoneNumbers, 1);
  assert.equal(r.contacts[0].threadCount, 2); assert.equal(r.phoneNumbersComplete, true);
});
test("resolves group roster mappings without including group conversations", () => {
  const r = resolve([msg(lid), msg("123@g.us")], owner,
    [{ participants: [{ id: lid, phoneNumber: pn }] }]);
  assert.equal(r.uniquePhoneNumbers, 1); assert.equal(r.individualThreads, 1);
});
test("does not map outbound sender phone fields to the recipient", () => {
  const r = resolve([msg(lid, { senderPn: pn }, true)], owner);
  assert.equal(r.unresolvedThreads, 1); assert.equal(r.phoneNumbersComplete, false);
  assert.ok(!JSON.stringify(r).includes(lid));
});
test("rejects owner phone and conflicting mappings", () => {
  assert.equal(resolve([msg(lid, { remoteJidAlt: owner })], owner).unresolvedThreads, 1);
  const r = resolve([msg(lid, { remoteJidAlt: pn }), msg(lid, { remoteJidAlt: "966500000002@s.whatsapp.net" })], owner);
  assert.equal(r.unresolved[0].reason, "conflicting phone mappings");
  assert.equal(r.resolvedThreads + r.unresolvedThreads, r.individualThreads);
});
test("reverse alternate links resolve LID threads", () => {
  assert.equal(resolve([msg(pn, { remoteJidAlt: lid }), msg(lid)], owner).uniquePhoneNumbers, 1);
});
test("no token means no access; tokens must be in the Authorization header", () => {
  assert.equal(authorized({ get: () => "Bearer test-only" }, ""), false);
  assert.equal(authorized({ get: () => "Bearer test-only" }, "test-only"), true);
  assert.equal(authorized({ get: () => "Bearer wrong" }, "test-only"), false);
});
function harness(opts = {}) {
  let handler;
  install({ get: (path, fn) => { assert.equal(path, "/insights/numbers"); handler = fn; } },
    { ensureJob: () => { throw Error("must not read"); }, readToken: "test-only", ...opts });
  const res = { code: 200, set() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
  return { handler, res };
}
test("route fails closed when unconfigured and rejects unauthenticated reads", async () => {
  const a = harness({ readToken: "" }); await a.handler({ query: {}, get: () => "" }, a.res);
  assert.equal(a.res.code, 503);
  const b = harness(); await b.handler({ query: {}, get: () => "" }, b.res); assert.equal(b.res.code, 401);
});
test("route reports running rather than zero", async () => {
  const h = harness({ ensureJob: () => ({ status: "running", coverage: { complete: false } }) });
  await h.handler({ query: { date: "2026-11-10" }, get: () => "Bearer test-only" }, h.res);
  assert.equal(h.res.body.status, "running"); assert.equal(h.res.body.phoneNumbersComplete, false);
});
test("route paginates every contact and unresolved entry independently", async () => {
  const job = { status: "complete", date: "2026-11-10", identity: { ownerJid: owner },
    coverage: { complete: true }, rows: [msg(pn), msg("966500000002@s.whatsapp.net"), msg(lid)] };
  const h = harness({ ensureJob: () => job, axios: { get: async () => { throw Error("roster unavailable"); } }, baseUrl: "https://example.invalid", instance: "test" });
  await h.handler({ query: { date: job.date, limit: "1" }, get: () => "Bearer test-only" }, h.res);
  assert.equal(h.res.body.pagination.nextOffset, 1); assert.equal(h.res.body.unresolvedThreads, 1);
  assert.equal(h.res.body.contacts[0].number, "+966500000001");
  assert.equal(h.res.body.phoneNumbersComplete, false);
});
test("saved contact metadata resolves a LID without guessing", () => {
  const r = resolve([msg(lid)], owner, [], { contacts: [{ id: lid, phoneNumber: "+966500000001" }] });
  assert.equal(r.contacts[0].number, "+966500000001");
});
test("out-of-window evidence resolves identity but never adds report threads", () => {
  const r = resolve([msg(lid)], owner, [], { evidenceRows: [
    msg(lid, { previousRemoteJid: pn }),
    msg("966500000009@s.whatsapp.net")
  ] });
  assert.equal(r.individualThreads, 1);
  assert.equal(r.uniquePhoneNumbers, 1);
});
test("conflicts between contact and message records stay unresolved", () => {
  const r = resolve([msg(lid, { remoteJidAlt: pn })], owner, [],
    { contacts: [{ id: lid, jid: "966500000002@s.whatsapp.net" }] });
  assert.equal(r.phoneNumbersComplete, false);
});
test("identity lookup uses only read endpoints and checks message ownership", async () => {
  const calls = [];
  const axios = {
    post: async (url, body) => {
      calls.push(url);
      if (url.includes("findContacts")) return { data: body.page === 1 ? [{ id: lid, jid: pn }] : [] };
      if (url.includes("findChats")) return { data: [] };
      return { data: { messages: { records: [msg(lid, { remoteJidAlt: pn })] } } };
    },
    get: async url => { calls.push(url); return { data: [] }; }
  };
  const e = await mappingEvidence({ rows: [msg(lid)], axios, baseUrl: "https://example.invalid", apiKey: "test", instance: "test" });
  assert.equal(e.contacts.length, 1); assert.equal(e.evidenceRows.length, 1);
  assert.ok(calls.every(url => /findContacts|findChats|findMessages|fetchAllGroups/.test(url)));
});
test("repeated contact pagination stops safely and reports its limitation", async () => {
  const e = await mappingEvidence({ rows: [msg(lid)], baseUrl: "https://example.invalid", instance: "test",
    axios: {
      post: async url => url.includes("findContacts") ? { data: [{ id: lid, jid: pn }] } :
        url.includes("findChats") ? { data: [] } : { data: { messages: { records: [] } } },
      get: async () => ({ data: [] })
    } });
  assert.ok(e.warnings.includes("Saved-contact mapping lookup incomplete."));
});
test("private daily report uses exact Riyadh bounds, both directions, and excludes identity-sample text", async () => {
  const vm = require("node:vm"), fs = require("node:fs"), module = { exports: {} };
  const start = Date.parse("2026-11-09T08:00:00Z") / 1000;
  const rows = [
    { ...msg(lid), messageTimestamp: start, message: { conversation: "in window" } },
    { ...msg(lid, {}, true), messageTimestamp: start + 60, message: { conversation: "reply" } }
  ];
  const retrieval = {
    dayBounds: () => ({ start: start - 11 * 3600 }),
    textOf: m => m.message?.conversation || "",
    verifiedCollect: async (read, where, bounds) => {
      assert.equal(bounds.start, start); assert.equal(bounds.end, start + 7200);
      assert.equal(where.messageTimestamp.gte, "2026-11-09T08:00:00.000Z");
      return { rows, coverage: { complete: true, passesVerified: 2 } };
    }
  };
  vm.runInNewContext(fs.readFileSync(__dirname + "/phone-numbers.js", "utf8"), {
    module, process, require: name => name === "./retrieval" ? retrieval : require(name)
  });
  const axios = {
    get: async url => ({ data: url.includes("fetchInstances") ? [{ name: "test", ownerJid: owner }] : [] }),
    post: async url => url.includes("findMessages") ? { data: { messages: { records: [
      { ...msg(lid, { remoteJidAlt: pn }), messageTimestamp: start - 1000, message: { conversation: "outside sample" } }
    ] } } } : { data: [] }
  };
  const out = await module.exports.dailyChatReport({ cmd: "daily-chats 2026-11-09 11:00 13:00 line 1 ending 0000",
    axios, baseUrl: "https://example.invalid", apiKey: "test", lines: ["test"] });
  const data = JSON.parse(out.text.split("```json\n")[1].split("\n```")[0]);
  assert.equal(data.chats[0].number, "+966500000001");
  assert.equal(data.chats[0].sent, 1); assert.equal(data.chats[0].received, 1);
  assert.equal(data.chats[0].messages.length, 2);
  assert.ok(!out.text.includes("outside sample"));
  assert.ok(!out.text.includes(lid));
});

// Authenticated insights regression checks (synthetic data only).
{
const { createInsightsNumbers } = require("./phone-numbers");
const req = (token = "", query = {}) => ({ get: () => token ? "Bearer " + token : "", query });
function setup(overrides = {}) {
  let lookups = 0;
  const options = { instance: "synthetic", readToken: "read-test", adminToken: "admin-test", baseUrl: "https://example.invalid", apiKey: "synthetic",
    identity: async () => ({ name: "synthetic", ownerJid: owner }),
    axios: { get: async () => ({ data: [] }), post: async url => { lookups++; return { data: url.includes("findMessages") ? { messages: { records: [] } } : [] }; } }, ...overrides };
  const service = createInsightsNumbers(options);
  const job = { status: "complete", date: "2026-11-10", coverage: { complete: true, verifiedAt: "snapshot" }, identity: { name: "synthetic", ownerJid: owner },
    rows: [msg(pn, {}, true), msg(lid, { remoteJidAlt: pn }), msg("222222222222222@lid"), msg("123@g.us"), msg(owner)] };
  return { service, job, lookups: () => lookups };
}
test("insights: only valid header credentials enable numbers", () => {
  const { service } = setup();
  assert.equal(service.authorize(req()), false);
  assert.equal(service.authorize(req("read-test")), true);
  assert.equal(service.authorize(req("admin-test")), true);
  assert.throws(() => service.authorize(req("wrong")), e => e.statusCode === 403);
  assert.throws(() => service.authorize(req("", { numbers: "true", key: "read-test" })), e => e.statusCode === 403);
  assert.throws(() => setup({ readToken: "", adminToken: "" }).service.authorize(req("", { numbers: "true" })), e => e.statusCode === 503);
});
test("insights: numbers match conversations and alias totals are deduplicated", async () => {
  const { service, job, lookups } = setup(), result = await service.get(job);
  assert.equal(result.totals.individualThreads, 3); assert.equal(result.totals.resolvedThreads, 2);
  assert.equal(result.totals.uniquePhoneNumbers, 1); assert.equal(result.totals.unresolvedThreads, 1);
  assert.equal(result.totals.phoneNumbersComplete, false);
  assert.equal(service.fields(result, pn).phoneNumber, "+966500000001");
  assert.equal(service.fields(result, lid).phoneNumber, "+966500000001");
  assert.equal(service.fields(result, "222222222222222@lid").phoneNumber, null);
  assert.equal(service.fields(result, "123@g.us").phoneNumberStatus, "not_individual");
  assert.equal(service.fields(result, owner).phoneNumberStatus, "school_account");
  assert.deepEqual(service.fields(null, pn), {});
  const count = lookups(); await service.get(job); assert.equal(lookups(), count);
});
test("insights: zero activity and incomplete retrieval stay distinct", async () => {
  const { service, job } = setup(), empty = await service.get({ ...job, rows: [] });
  assert.equal(empty.totals.uniquePhoneNumbers, 0); assert.equal(empty.totals.phoneNumbersComplete, true);
  await assert.rejects(() => service.get({ ...job, coverage: { complete: false } }));
  await assert.rejects(() => service.get({ ...job, status: "running" }));
});
test("insights: changed account identity invalidates cached mappings", async () => {
  let account = owner;
  const { service, job } = setup({ identity: async () => ({ name: "synthetic", ownerJid: account }) });
  await service.get(job); account = pn;
  await assert.rejects(() => service.get(job), /school number changed/);
  await assert.rejects(() => service.get({ ...job, identity: {} }));
});
test("insights: full-window conflicts stay unresolved on smaller pages", async () => {
  const { service, job } = setup();
  job.rows = [msg(lid, { remoteJidAlt: pn }), msg(lid, { remoteJidAlt: "966500000002@s.whatsapp.net" })];
  const result = await service.get(job);
  assert.equal(result.totals.unresolvedThreads, 1); assert.equal(service.fields(result, lid).phoneNumber, null);
  assert.equal(service.fields(result, lid).phoneNumberReason, "conflicting phone mappings");
});
test("insights: line-local caches never share mappings", async () => {
  const a = setup(), b = setup(); b.job.rows = [msg("966500000002@s.whatsapp.net")];
  const ar = await a.service.get(a.job), br = await b.service.get(b.job);
  assert.equal(a.service.fields(ar, pn).phoneNumber, "+966500000001"); assert.equal(b.service.fields(br, pn).phoneNumber, null);
});
test("insights: identity changes during enrichment fail closed", async () => {
  let checks = 0;
  const { service, job } = setup({ identity: async () => ({ name: "synthetic", ownerJid: ++checks === 1 ? owner : pn }) });
  await assert.rejects(() => service.get(job), /school number changed/);
});
test("insights: chat and record pages enrich only protected responses without changing counts", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), mod = { exports: {} }, date = "2026-11-10";
  const rows = [msg(lid, { remoteJidAlt: pn }), msg(pn, {}, true)].map((m, i) => ({ ...m, id: "synthetic-" + i, messageTimestamp: 1794261600 + i, message: { conversation: "synthetic message" }, messageType: "conversation" }));
  const seededJobs = new Map();
  const source = fs.readFileSync(__dirname + "/retrieval.js", "utf8").replace("const jobs = new Map()", "const jobs = seededJobs");
  vm.runInNewContext(source, { module: mod, process: { env: { WA_REPORT_READ_TOKEN: "read-test", HIS_READ_KEY: "read-test", CONNECT_KEY: "admin-test" } }, seededJobs,
    require: name => name === "./windowed" ? () => {} : name === "./phone-numbers" ? { ...require("./phone-numbers"), install() {} } : require(name) });
  seededJobs.set(date, { date, status: "complete", created: Date.now(), coverage: { complete: true, verifiedAt: "snapshot" }, identity: { name: "synthetic", ownerJid: owner }, rows, ...mod.exports.aggregate(rows) });
  const routes = new Map();
  mod.exports.install({ get: (path, fn) => routes.set(path, fn) }, { instance: "synthetic", baseUrl: "https://example.invalid", apiKey: "synthetic",
    axios: { get: async url => ({ data: url.includes("fetchInstances") ? [{ name: "synthetic", ownerJid: owner }] : [] }), post: async url => ({ data: url.includes("findMessages") ? { messages: { records: [] } } : [] }) } });
  const response = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  for (const path of ["/insights", "/insights/records"]) {
    for (const offset of [0, 1]) {
      const res = response(); await routes.get(path)(req("read-test", { date, limit: "1", offset: String(offset), transcript: "true" }), res);
      assert.equal(res.code, 200); assert.equal(res.body.summary.totalMessages, 2);
      assert.equal(res.body.phoneResolution.uniquePhoneNumbers, 1); assert.equal(res.body.phoneResolution.resolvedThreads, 2);
      const entries = res.body.chats || res.body.messages; assert.equal(entries.length, 1); assert.equal(entries[0].phoneNumber, "+966500000001");
      assert.equal(res.body.pagination.nextOffset, offset === 0 ? 1 : null); assert.equal(res.headers.Vary, "Authorization"); assert.equal(res.headers["Cache-Control"], "no-store");
    }
    const publicRes = response(); await routes.get(path)(req("", { date }), publicRes);
    assert.equal(publicRes.body.phoneResolution, undefined); assert.equal((publicRes.body.chats || publicRes.body.messages)[0].phoneNumber, undefined);
    const denied = response(); await routes.get(path)(req("wrong", { date }), denied);
    assert.equal(denied.code, 403); assert.equal(denied.body.chats, undefined); assert.equal(denied.body.messages, undefined);
  }
});
}
