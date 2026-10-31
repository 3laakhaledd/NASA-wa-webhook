'use strict';
// Private text sends are driven by an explicitly approved ClickUp command.
// No group identifiers, public send endpoint, credentials, or message text in logs.
async function sendText({ cmd, desc, taskId, axios, api, H, lines, evoBase, evoH, rename, comment }) {
  const m = cmd.match(/^send-text\s+to\s+\+?(\d{10,15})\s+from\s+\+?(\d{10,15})$/i);
  if (!m || !taskId) throw new Error('Use: RUN: send-text to +RECIPIENT from +SENDER');
  let payload;
  try { payload = JSON.parse(String(desc || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch (_) { throw new Error('Text-send description must contain a JSON payload'); }
  if (payload.approved !== true || payload.recipient !== m[1] || payload.sender !== m[2])
    throw new Error('Explicit approval and matching sender/recipient are required');
  if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 2 ||
      payload.messages.some(t => typeof t !== 'string' || !t.trim() || t.length > 20000))
    throw new Error('Provide one or two nonempty text messages, each at most 20000 characters');
  // Re-read immediately before claiming; a claimed task never matches the RUN scanner.
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
  // This durable claim happens BEFORE the first irreversible request. Never auto-retry
  // a partial batch or a timeout; inspect receipts and WhatsApp before manual recovery.
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
