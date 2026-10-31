'use strict';
const parsePayload = desc => JSON.parse(String(desc || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
async function sendGroups(ctx) {
  const { cmd, desc, taskId, axios, api, H, lines, evoBase, evoH, rename, comment } = ctx;
  const m = cmd.match(/^send-text\s+groups\s+from\s+\+?(\d{10,15})$/i);
  if (!m || !taskId) throw new Error('Use: RUN: send-text groups from +SENDER');
  let p;
  try { p = parsePayload(desc); } catch (_) { throw new Error('Group-send payload must be JSON'); }
  if (p.approved !== true || p.sender !== m[1] || !Array.isArray(p.groups) || !p.groups.length || p.groups.length > 15 ||
      p.groups.some(g => typeof g !== 'string' || !g.trim()) || new Set(p.groups).size !== p.groups.length)
    throw new Error('Explicit approval, matching sender and 1-15 unique exact group names required');
  let messages = p.messages;
  if (p.sourceTaskId) {
    if (!/^[a-zA-Z0-9]+$/.test(p.sourceTaskId)) throw new Error('Invalid source task');
    const source = (await axios.get(api + '/task/' + p.sourceTaskId, H())).data;
    try { messages = parsePayload(source.description || source.text_content).messages; }
    catch (_) { throw new Error('Source message JSON unavailable; nothing sent'); }
  }
  if (!Array.isArray(messages) || messages.length !== 2 || messages.some(t => typeof t !== 'string' || !t.trim() || t.length > 20000))
    throw new Error('Exactly two nonempty text messages required');
  const digits = s => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  let data;
  try { data = (await axios.get(evoBase() + '/instance/fetchInstances', evoH())).data; }
  catch (_) { throw new Error('Sender verification unavailable; nothing sent'); }
  const instances = (Array.isArray(data) ? data : [data]).filter(Boolean).map(x => ({
    name: x.name || x.instance?.instanceName || x.instanceName,
    owner: x.ownerJid || x.instance?.ownerJid,
    state: x.connectionStatus || x.instance?.status || x.instance?.state
  })).filter(x => x.name && lines.includes(x.name) && digits(x.owner) === p.sender);
  if (instances.length !== 1 || instances[0].state !== 'open') throw new Error('Requested sender is not uniquely connected; nothing sent');
  const inst = instances[0];
  let all;
  try { all = (await axios.get(evoBase() + '/group/fetchAllGroups/' + encodeURIComponent(inst.name),
    { ...evoH(), params: { getParticipants: 'true' } })).data; }
  catch (_) { throw new Error('Group validation unavailable; nothing sent'); }
  if (!Array.isArray(all)) throw new Error('Group validation incomplete; nothing sent');
  const targets = p.groups.map(name => {
    const matches = all.filter(g => g.subject === name && typeof g.id === 'string' && g.id.endsWith('@g.us'));
    if (matches.length !== 1) throw new Error('Group not uniquely matched: ' + name + '. Nothing sent');
    return { name, id: matches[0].id };
  });
  if (new Set(targets.map(t => t.id)).size !== targets.length) throw new Error('Duplicate group targets; nothing sent');
  const current = (await axios.get(api + '/task/' + encodeURIComponent(taskId), H())).data;
  if (!/^\s*RUN\s*:/i.test(current.name || '')) throw new Error('Batch already claimed; not retrying');
  await rename(taskId, 'SENDING: ' + cmd);
  await comment(taskId, 'Approved batch claimed: ' + targets.length + ' exact groups, ' + (targets.length * 2) +
    ' messages from +' + p.sender + '. Order per group: link then announcement. No automatic retries.\n' + targets.map(t => t.name).join('\n'));
  const receipts = [];
  for (const target of targets) {
    const ids = [];
    for (let i = 0; i < messages.length; i++) {
      let sent;
      try { sent = await axios.post(evoBase() + '/message/sendText/' + encodeURIComponent(inst.name),
        { number: target.id, text: messages[i], linkPreview: i === 0 }, evoH()); }
      catch (_) { throw new Error('Send outcome uncertain for ' + target.name + ' message ' + (i + 1) +
        '. Previously confirmed: ' + receipts.length + '. Do not retry batch; inspect receipts.'); }
      const id = sent.data?.key?.id;
      if (!id) throw new Error('Receipt absent for ' + target.name + ' message ' + (i + 1) + '. Do not retry batch.');
      ids.push(id); receipts.push({ group: target.name, message: i + 1, id });
      try { await comment(taskId, target.name + ' | message ' + (i + 1) + '/2 accepted | id: ' + id + ' | ' + new Date().toISOString()); }
      catch (_) { throw new Error('Message accepted but receipt storage failed for ' + target.name + '. Do not retry batch.'); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return { done: true, text: 'Completed: ' + receipts.length + '/' + (targets.length * 2) + ' messages accepted across ' + targets.length +
    ' groups from +' + p.sender + ' (line ' + (lines.indexOf(inst.name) + 1) + '). Delivery/read status not asserted.\n' +
    targets.map(t => t.name + ': 2/2 accepted').join('\n') };
}
async function sendText(ctx) {
  const { cmd, desc, taskId, axios, api, H, lines, evoBase, evoH, rename, comment } = ctx;
  if (/^send-text\s+groups\b/i.test(cmd)) return sendGroups(ctx);
  const m = cmd.match(/^send-text\s+to\s+\+?(\d{10,15})\s+from\s+\+?(\d{10,15})$/i);
  if (!m || !taskId) throw new Error('Use: RUN: send-text to +RECIPIENT from +SENDER');
  let payload;
  try { payload = parsePayload(desc); }
  catch (_) { throw new Error('Text-send description must contain a JSON payload'); }
  if (payload.approved !== true || payload.recipient !== m[1] || payload.sender !== m[2])
    throw new Error('Explicit approval and matching sender/recipient are required');
  if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 2 ||
      payload.messages.some(t => typeof t !== 'string' || !t.trim() || t.length > 20000))
    throw new Error('Provide one or two nonempty text messages, each at most 20000 characters');
  const current = (await axios.get(api + '/task/' + encodeURIComponent(taskId), H())).data;
  if (!/^\s*RUN\s*:/i.test(current.name || '')) throw new Error('Text command already claimed; not retrying');
  const digits = s => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  let instances;
  try { instances = (await axios.get(evoBase() + '/instance/fetchInstances', evoH())).data; }
  catch (_) { throw new Error('Could not verify sender connection; nothing sent'); }
  const matches = (Array.isArray(instances) ? instances : [instances]).filter(Boolean).map(x => ({
    name: x.name || x.instance?.instanceName || x.instanceName,
    owner: x.ownerJid || x.instance?.ownerJid,
    state: x.connectionStatus || x.instance?.status || x.instance?.state
  })).filter(x => x.name && lines.includes(x.name) && digits(x.owner) === m[2]);
  if (matches.length !== 1 || matches[0].state !== 'open')
    throw new Error('Requested sender is not uniquely connected; nothing sent');
  const inst = matches[0];
  await rename(taskId, 'SENDING: ' + cmd);
  await comment(taskId, 'Approved private text batch claimed. Messages: ' + payload.messages.length +
    '. Sender: +' + m[2] + '; recipient: +' + m[1] + '. No automatic retries.');
  const receipts = [];
  for (let i = 0; i < payload.messages.length; i++) {
    let sent;
    try {
      sent = await axios.post(evoBase() + '/message/sendText/' + encodeURIComponent(inst.name), {
        number: m[1], text: payload.messages[i], linkPreview: i === 0
      }, evoH());
    } catch (_) {
      throw new Error('Message ' + (i + 1) + ' send result is uncertain. Prior confirmed messages: ' +
        receipts.length + '. Do not retry automatically; inspect WhatsApp and task receipts.');
    }
    const id = sent.data?.key?.id;
    if (!id) throw new Error('Message ' + (i + 1) + ' returned no receipt. Do not retry automatically.');
    receipts.push(id);
    try { await comment(taskId, 'Message ' + (i + 1) + '/' + payload.messages.length +
      ' accepted by WhatsApp. Message id: ' + id + '. Time: ' + new Date().toISOString()); }
    catch (_) { throw new Error('Message ' + (i + 1) + ' accepted but receipt storage failed. Do not retry automatically.'); }
  }
  return { done: true, text: 'Sent ' + receipts.length + ' separate private text messages from +' + m[2] +
    ' (line ' + (lines.indexOf(inst.name) + 1) + ') to +' + m[1] + '. Message ids: ' + receipts.join(', ') +
    '. Provider acceptance verified; recipient delivery/read status not asserted.' };
}
module.exports = { sendText };
