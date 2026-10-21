const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PhoneMap, unreadReport, format } = require("./unread");

test("LIDs and group identifiers never become phone numbers", () => {
  assert.equal(format("123456789@lid"), null);
  assert.equal(format("123456789@g.us"), null);
  assert.equal(format("966500000001:2@s.whatsapp.net"), "+966500000001");
});
test("explicit roster/contact pairs resolve without display-name matching", () => {
  const m = new PhoneMap();
  m.contact({ id: "123@lid", phoneNumber: "966500000001@s.whatsapp.net" }, "group roster");
  assert.equal(m.resolve("123@lid").number, "+966500000001");
  m.contact({ remoteJid: "966500000002@s.whatsapp.net", pushName: "Same name" }, "contact");
  assert.equal(m.resolve("456@lid").number, null);
});
test("conflicting mappings remain unavailable", () => {
  const m = new PhoneMap();
  m.add("123@lid", "966500000001@s.whatsapp.net", "contact");
  m.add("123@lid", "966500000002@s.whatsapp.net", "roster");
  assert.equal(m.resolve("123@lid").number, null);
  assert.match(m.resolve("123@lid").numberSource, /conflicting/);
});
test("outbound sender and unrelated participant cannot be mistaken for contact", () => {
  const m = new PhoneMap();
  m.message({ key: { remoteJid: "123@lid", fromMe: true,
    senderPn: "966500000001@s.whatsapp.net", participantPn: "966500000002@s.whatsapp.net" } }, "123@lid");
  assert.equal(m.resolve("123@lid").number, null);
  m.message({ key: { remoteJid: "456@lid", remoteJidAlt: "966500000003@s.whatsapp.net" } }, "123@lid");
  assert.equal(m.resolve("123@lid").number, null);
});
test("inbound sender and direct alternate identifiers can resolve contact", () => {
  const m = new PhoneMap();
  m.message({ key: { remoteJid: "123@lid", fromMe: false, senderPn: "966500000001@s.whatsapp.net" } }, "123@lid");
  assert.equal(m.resolve("123@lid").number, "+966500000001");
});
function harness({ unreadAfter = 2, suffix = "6444", failChats = false, failOptional = false, autoRead = false } = {}) {
  const calls = []; let reads = 0;
  const axios = {
    get: async url => {
      calls.push(url);
      if (url.includes("/settings/find/")) return { data: { readMessages: autoRead } };
      return { data: [{ name: "line-one", ownerJid: "966500006444@s.whatsapp.net", connectionStatus: "open" }] };
    },
    post: async (url, body) => {
      calls.push(url);
      if (url.includes("/chat/findChats/")) {
        if (failChats) throw new Error("upstream private error");
        reads++;
        return { data: [
          { remoteJid: "123@lid", pushName: "Test", unreadCount: reads === 1 ? 2 : unreadAfter },
          { remoteJid: "456@lid", pushName: "Unknown", unreadCount: 1 },
          { remoteJid: "987@g.us", name: "Group", unreadCount: 3 }
        ] };
      }
      if (failOptional) throw new Error("optional source unavailable");
      if (url.includes("/chat/findContacts/")) return { data: [] };
      assert.match(url, /\/chat\/findMessages\//);
      assert.equal(body.offset, 50);
      return { data: { messages: { records: body.where.key.remoteJid === "123@lid" ? [{
        key: { remoteJid: "123@lid", fromMe: false, remoteJidAlt: "966500000001@s.whatsapp.net" }
      }] : [] } } };
    }
  };
  const run = () => unreadReport({ axios, baseUrl: "https://example.test", apiKey: "NEVER_RETURN",
    instance: "line-one", line: 1, expectedSuffix: suffix,
    fetchGroups: async () => { if (failOptional) throw new Error("optional"); return []; } });
  return { run, calls };
}
test("snapshot resolves numbers, preserves counters, includes groups, and only calls lookups", async () => {
  const h = harness(); const r = await h.run();
  assert.equal(r.items[0].number, "+966500000001");
  assert.equal(r.items[0].counterUnchanged, true);
  assert.equal(r.items[1].number, null);
  assert.equal(r.unreadChatRecords, 3);
  assert.equal(r.groups.length, 1);
  assert.equal(r.autoReadMessages, false);
  assert.equal(r.accountNumber, "+966500006444");
  assert.equal(JSON.stringify(r).includes("NEVER_RETURN"), false);
  assert.ok(h.calls.every(url => /\/(instance\/fetchInstances|settings\/find|chat\/findChats|chat\/findContacts|chat\/findMessages)(\/|$)/.test(url)));
});
test("changed unread counter is reported, not hidden", async () => {
  const r = await harness({ unreadAfter: 0 }).run();
  assert.equal(r.items[0].unreadAfter, 0);
  assert.equal(r.items[0].counterUnchanged, false);
});
test("wrong account suffix fails before chat retrieval", async () => {
  const h = harness({ suffix: "9999" });
  await assert.rejects(h.run, /suffix/);
  assert.equal(h.calls.some(x => x.includes("findChats")), false);
});
test("chat failure is never reported as zero unread", async () => {
  await assert.rejects(harness({ failChats: true }).run);
});
test("missing mapping sources are explicit, not fabricated numbers", async () => {
  const r = await harness({ failOptional: true }).run();
  assert.equal(r.resolvedNumbers, 0);
  assert.ok(r.warnings.length > 0);
});
test("enabled auto-read produces a warning and no mutation", async () => {
  const r = await harness({ autoRead: true }).run();
  assert.match(r.warnings.join(" "), /enabled/);
});
function bridge() {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const module = { exports: {} };
  const requests = [];
  const fakeUnread = async args => {
    requests.push(args);
    return { items: [{ number: "+966500000001", unreadBefore: 1, unreadAfter: 1 }] };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "commands.js"), "utf8"), {
    module, process: { env: { EVO_API_URL: "https://example.test", EVO_API_KEY: "test-key" } },
    require: name => {
      if (name === "./unread") return { unreadReport: fakeUnread };
      if (name === "./retrieval") return { dayBounds: () => ({ start: 0 }) };
      throw new Error("Unexpected require " + name);
    }, console, Buffer, setTimeout
  });
  const result = module.exports.install({ axios: {}, api: "https://clickup.test", token: "private-token",
    listId: "private-list", report: {}, fetchGroups: async () => [],
    lines: ["first", "second"], cron: { schedule() {} } });
  return { ...result, requests };
}
test("private command bridge selects line 1 and verifies the 6444 suffix", async () => {
  const h = bridge();
  const r = await h.run("unread line 1 ending 6444");
  assert.equal(r.done, true);
  assert.equal(h.requests[0].instance, "first");
  assert.equal(h.requests[0].expectedSuffix, "6444");
  assert.match(r.text, /\+966500000001/);
});
test("private command rejects malformed input and unknown lines", async () => {
  const h = bridge();
  await assert.rejects(h.run("unread line 3"), /Unknown line/);
  await assert.rejects(h.run("unread line 1 and send something"), /Use:/);
  assert.equal(h.requests.length, 0);
});
