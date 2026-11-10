const test = require("node:test");
const assert = require("node:assert/strict");
const { phone, resolve, authorized, install } = require("./phone-numbers");
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
