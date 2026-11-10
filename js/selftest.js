// Self-test: open the app with ?selftest (e.g. http://localhost:8766/?selftest).
// It clicks through the main features with a fake model and fake server replies, so it needs no GPU
// and takes a few seconds, then puts your chats and settings back exactly as they were.
// Results appear in a panel and in window.__selftest = { passed, failed, results }.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 8000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const results = [];
  const errors = [];
  addEventListener('error', (e) => errors.push(e.message));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message || e.reason)));

  // ---- results panel
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;width:380px;max-height:70vh;overflow:auto;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:13px/1.45 -apple-system,system-ui,sans-serif;padding:12px 14px';
  panel.innerHTML = '<b>Qwen Chat self-test</b> <span id="st-sum">running…</span><div id="st-list" style="margin-top:8px"></div>';
  document.body.appendChild(panel);
  const show = () => {
    panel.querySelector('#st-list').innerHTML = results.map((r) => `<div style="margin:3px 0">${r.ok ? '✅' : '❌'} ${esc(r.name)} <span style="color:var(--muted)">${r.ms} ms</span>${r.ok ? '' : `<div style="color:#c0392b;margin-left:22px">${esc(r.error)}</div>`}</div>`).join('');
  };

  // ---- keep your data safe: snapshot now, restore at the end
  const KEYS = ['qc.chats', 'qc.settings', 'qc.memories'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
  const savedSettings = JSON.parse(JSON.stringify(settings));
  const realFetch = window.fetch;
  chats = []; current = null; renderList();
  Object.assign(settings, { auto: false, verify: false, web: false, memory: false, think: false, jev: false, accounts: false, skillsOff: [] });

  // ---- fake model and server
  const calls = [];
  let agentScript = [];  // replies for model turns that offer tools, in order
  let fakeConn = null;   // fake /connectors/status reply, when set
  const enc = new TextEncoder();
  const ndjson = (objs) => new Response(new ReadableStream({ start(c) { for (const o of objs) c.enqueue(enc.encode(JSON.stringify(o) + '\n')); c.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    calls.push({ url: u, body });
    if (u.startsWith('/api/chat')) {
      const lastText = String(body?.messages?.at(-1)?.content || '');
      if (body?.stream && lastText.includes('SLOW')) {
        const parts = ['Once ', 'upon ', 'a ', 'time, ', 'a ', 'keeper ', 'kept ', 'the ', 'light.'];
        return new Response(new ReadableStream({ async start(c) {
          const stop = () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch {} };
          opts.signal?.addEventListener('abort', stop);
          for (const t of parts) {
            await sleep(120);
            if (opts.signal?.aborted) return;
            c.enqueue(enc.encode(JSON.stringify({ message: { content: t } }) + '\n'));
          }
          c.enqueue(enc.encode(JSON.stringify({ done: true, eval_count: 9, eval_duration: 1e8 }) + '\n'));
          c.close();
        } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      if (body?.stream && lastText.includes('LONGTHINK') && body.think)
        return ndjson([{ message: { thinking: 'Step 1… step 2… so the total is 42' } }, { done: true, done_reason: 'length', eval_count: 16000, eval_duration: 1e9 }]);
      if (body?.stream && lastText.includes('ran out of thinking time'))
        return ndjson([{ message: { content: 'From the work so far, the answer is 42.' } }, { done: true, done_reason: 'stop', eval_count: 9, eval_duration: 1e8 }]);
      if (body?.tools?.length && agentScript.length) return ndjson([{ message: agentScript.shift() }, { done: true, eval_count: 5, eval_duration: 1e8 }]);
      if (body?.stream === false) return json({ message: { content: 'Hello from the self-test model.' }, logprobs: [] });
      return ndjson([{ message: { content: 'Hello from ' } }, { message: { content: 'the self-test model.' } }, { done: true, eval_count: 6, eval_duration: 1e8 }]);
    }
    if (u.startsWith('/code/tool')) return json(body?.dry_run ? { preview: `--- a/${body.args?.path}\n+++ b/${body.args?.path}\n+${body.args?.content || ''}` } : { result: 'done' });
    if (u.startsWith('/connectors/status') && fakeConn) return json(fakeConn);
    if (u.startsWith('/connectors/tool')) return json(body?.dry_run ? { preview: `To: ${body.args?.to}\nSubject: ${body.args?.subject}\n\n${body.args?.body}` } : { result: 'Sent' });
    if (u.startsWith('/ocr')) return ndjson([{ total: 1 }, { page: 1, text: 'टेस्ट — text from the fake scanner' }, { done: true, engine: 'fake-vision' }]);
    if (u.startsWith('/voice/transcribe')) return json({ text: 'fake transcript' });
    return realFetch(url, opts);  // the page's own files, skills, model list
  };
  const finished = () => until(() => !controller, 'the reply to finish');
  const lastReply = () => current?.messages.filter((m) => m.role === 'assistant').at(-1)?.content || '';

  const test = async (name, fn) => {
    const t = performance.now();
    try { await fn(); results.push({ name, ok: true, ms: Math.round(performance.now() - t) }); }
    catch (e) { results.push({ name, ok: false, error: e.message, ms: Math.round(performance.now() - t) }); controller?.abort(); await sleep(100); }
    show();
  };

  try {
    await test('Every feature file loaded', async () => {
      for (const f of ['generate', 'generateCode', 'generateAccounts', 'verifyAnswer', 'extractPdf', 'ocrFile', 'startRecording',
        'finishTranscript', 'renderConnectors', 'loadSkill', 'skillTool', 'exportChat', 'recallMemories', 'scoreOptions'])
        assert(typeof window[f] === 'function', `${f} is missing`);
    });

    await test('Chat: a message gets a streamed reply', async () => {
      newChat(); send('Hi there');
      await finished();
      assert(lastReply() === 'Hello from the self-test model.', `reply was "${lastReply()}"`);
      assert(els.messages.textContent.includes('Hello from the self-test model.'), 'reply not shown on the page');
    });

    await test('Thinking: an answer cut off by the budget is rescued and labelled', async () => {
      settings.think = true;
      newChat(); send('LONGTHINK what is the total?');
      await finished();
      settings.think = false;
      const think = calls.filter((c) => c.url.startsWith('/api/chat') && c.body?.think).at(-1)?.body;
      assert(think?.options?.num_predict > 0 && think.options.num_ctx >= think.options.num_predict, 'thinking request has no token budget');
      const rescue = calls.filter((c) => c.url.startsWith('/api/chat')).at(-1)?.body;
      assert(rescue?.think === false && rescue.messages.at(-1).content.includes('so the total is 42'), 'rescue request missing the reasoning');
      assert(lastReply() === 'From the work so far, the answer is 42.', `reply was "${lastReply()}"`);
      assert(current.messages.at(-1).rescued && els.messages.textContent.includes('Ran out of thinking time'), 'rescue not labelled');
    });

    await test('Thinking: a finished answer is not rescued', async () => {
      settings.think = true;
      newChat(); send('Hi with thinking');
      await finished();
      settings.think = false;
      assert(lastReply() === 'Hello from the self-test model.' && !current.messages.at(-1).rescued, 'finished answer was rescued');
    });

    await test('Skills: the / picker lists skills and /name reaches the model', async () => {
      await until(() => skillsList.length, 'the skills list');
      els.input.value = '/gr'; els.input.dispatchEvent(new Event('input'));
      assert([...document.querySelectorAll('#slash-pop b')].some((b) => b.textContent === '/grilling'), '/grilling not offered for "/gr"');
      els.input.value = ''; els.input.dispatchEvent(new Event('input'));
      newChat(); send('/grilling my plan');
      await finished();
      assert(current.messages[0].skill === 'grilling', 'message not marked with the skill');
      const sys = calls.filter((c) => c.url.startsWith('/api/chat') && c.body?.stream).at(-1)?.body?.messages?.[0]?.content || '';
      assert(sys.includes('<skill-instructions name="grilling">'), 'skill instructions not sent to the model');
    });

    await test('Attachments: a text file becomes part of the message', async () => {
      newChat();
      await addFiles([new File(['line one\nline two'], 'notes.txt', { type: 'text/plain' })]);
      assert(pending[0]?.text === 'line one\nline two', 'text not read');
      pending = []; renderPending();
    });

    await test('Attachments: a scanned PDF page is read by OCR', async () => {
      const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
      await addFiles([new File([pdf], 'scan.pdf', { type: 'application/pdf' })]);
      const f = pending[0];
      assert(f && f.ocr, 'the blank page was not sent to OCR');
      assert(f.text.includes('fake scanner'), 'OCR text missing from the attachment');
      assert(document.querySelector('.file-chip .fsize')?.textContent.includes('read from scan'), 'chip not marked "read from scan"');
      pending = []; renderPending();
    });

    await test('Verify: attached files count as evidence', async () => {
      const docs = attachedDocs([{ role: 'user', content: '<file name="a.pdf">\nTotal Rs. 2,950\n</file>\n\nWhat is the total?' }, { role: 'assistant', content: 'x' }]);
      assert(docs.includes('Total Rs. 2,950'), 'attached document not given to the fact-checker');
    });

    await test('Code mode: edits wait for approval, and Deny stops them', async () => {
      newChat(); setCodeRoot('/tmp/qwen-selftest');
      agentScript = [{ content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'x.txt', content: 'hello' } } }] }, { content: 'Okay, I left it.' }];
      send('Make x.txt');
      const card = await until(() => document.querySelector('details.tool.ask'), 'the approval card');
      assert(card.querySelector('[data-approve="once"]') && card.querySelector('[data-approve="deny"]'), 'Allow/Deny buttons missing');
      card.querySelector('[data-approve="deny"]').click();
      await finished();
      assert(!calls.some((c) => c.url.startsWith('/code/tool') && c.body?.dry_run === false), 'the edit ran even though it was denied');
      assert(lastReply() === 'Okay, I left it.', `final reply was "${lastReply()}"`);
      assert(document.querySelector('details.tool.denied'), 'card not marked declined');
    });

    await test('Accounts: emails need Send / Don\'t send, with no "always allow"', async () => {
      fakeConn = { providers: [{ id: 'google', name: 'Google', products: 'Gmail', configured: true, connected: true, account: 'me@test', redirect_uri: '', secret: 'required', scopes: [] }],
        tools: [{ type: 'function', function: { name: 'gmail_send', description: 'send', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } }],
        write_tools: ['gmail_send'], can_connect: true };
      await refreshConnectors();
      settings.accounts = true;
      newChat();
      agentScript = [{ content: '', tool_calls: [{ function: { name: 'gmail_send', arguments: { to: 'bob@example.com', subject: 'Hi', body: 'Test' } } }] }, { content: 'Not sent.' }];
      send('Email Bob');
      const card = await until(() => document.querySelector('details.tool.ask'), 'the send approval card');
      assert(card.textContent.includes('bob@example.com'), 'preview does not show the recipient');
      assert(!card.querySelector('[data-approve="always"]'), 'sending offers "always allow"');
      card.querySelector('[data-approve="deny"]').click();
      await finished();
      assert(!calls.some((c) => c.url.startsWith('/connectors/tool') && c.body?.dry_run === false), 'the email was sent although declined');
      settings.accounts = false; fakeConn = null;
    });

    await test('Accounts: a reply cut off by the thinking budget is rescued too', async () => {
      fakeConn = { providers: [{ id: 'google', name: 'Google', products: 'Gmail', configured: true, connected: true, account: 'me@test', redirect_uri: '', secret: 'required', scopes: [] }],
        tools: [{ type: 'function', function: { name: 'gmail_search', description: 'search', parameters: { type: 'object', properties: {} } } }], write_tools: [], can_connect: true };
      await refreshConnectors();
      const savedCaps = modelCaps[els.model.value];
      modelCaps[els.model.value] = ['completion', 'tools', 'thinking'];
      settings.accounts = true; settings.think = true;
      newChat(); send('LONGTHINK what is the total?');
      await finished();
      settings.accounts = false; settings.think = false; fakeConn = null; modelCaps[els.model.value] = savedCaps;
      const think = calls.filter((c) => c.url.startsWith('/api/chat') && c.body?.think && c.body?.tools).at(-1)?.body;
      assert(think?.options?.num_predict > 0, 'agent thinking request has no token budget');
      const m = current.messages.at(-1);
      assert(m.rescued && m.content === 'From the work so far, the answer is 42.', `reply was "${m.content}"`);
      assert(els.messages.textContent.includes('Ran out of thinking time'), 'rescue not labelled');
    });

    await test('Connectors: typed setup details survive a redraw', async () => {
      openConnectors(); await sleep(50);
      conn.setupOpen = 'google'; renderConnectors();
      document.querySelector('#conn-list [data-field="client_id"]').value = 'typed-id';
      renderConnectors();
      const v = document.querySelector('#conn-list [data-field="client_id"]')?.value;
      $('#conn-dlg').close();
      assert(v === 'typed-id', 'what was typed got wiped');
    });

    await test('Voice: Send while transcribing sends the whole text once', async () => {
      newChat();
      const r = { before: '', after: '', committedText: '', liveText: 'partial words' };
      voice.finishing = r; els.input.value = 'partial words';
      send(els.input.value);
      assert(current === null || !current.messages.length, 'a partial message was sent early');
      assert(voice.sendWhenDone, 'send was not deferred');
      finishTranscript(r, 'the whole sentence');
      await finished();
      const users = current.messages.filter((m) => m.role === 'user');
      assert(users.length === 1 && users[0].content === 'the whole sentence', `sent: ${JSON.stringify(users.map((m) => m.content))}`);
      assert(els.input.value === '', 'text left behind in the message box');
    });

    await test('Switching chats lets a reply finish in the background', async () => {
      newChat(); send('SLOW tell me a story');
      const chatA = current;
      await sleep(250);
      assert(controller && liveRun?.chat === chatA, 'reply did not start');
      openChat(chats.find((c) => c !== chatA && c.messages.length).id);   // leave chat A mid-reply
      assert(controller, 'switching chats stopped the reply');
      assert(!busyHere() && els.send.title !== 'Stop', 'Stop is shown in a chat that is not replying');
      assert(document.querySelector('.chat-item.busy'), 'the replying chat is not marked in the sidebar');
      openChat(chatA.id); await sleep(150);
      assert(els.messages.textContent.includes('Once'), 'coming back did not show the live reply');
      await finished();
      assert(chatA.messages.at(-1)?.content === 'Once upon a time, a keeper kept the light.', `reply was "${chatA.messages.at(-1)?.content}"`);
      assert(!document.querySelector('.chat-item.busy'), 'sidebar still shows it as busy');
    });

    await test('Sending in another chat while one is replying is refused with a message', async () => {
      newChat(); send('SLOW another story');
      const chatA = current;
      await sleep(200);
      newChat();
      const before = chats.length;
      send('This should wait');
      assert(chats.length === before && !current, 'a second message was started while a reply was running');
      assert($('#toast').textContent.includes('still answering'), 'no explanation shown');
      await finished();
      assert(chatA.messages.at(-1)?.role === 'assistant', 'the first reply did not finish');
    });

    await test('A reply cut off by a reload offers Retry and never re-runs by itself', async () => {
      const cut = { id: 'cut' + Date.now(), title: 'Cut off', created: Date.now(), messages: [{ role: 'user', content: 'Unanswered question', time: Date.now() }] };
      chats.unshift(cut);
      const n = calls.length;
      openChat(cut.id);
      const bar = document.querySelector('.interrupted');
      assert(bar, 'no "didn\'t finish" notice with Retry');
      await sleep(400);
      assert(!calls.slice(n).some((c) => c.url.startsWith('/api/chat')), 'it re-ran the request by itself');
      bar.querySelector('button').click();
      await finished();
      assert(cut.messages.at(-1)?.role === 'assistant', 'Retry did not produce a reply');
      assert(!document.querySelector('.interrupted'), 'notice still shown after Retry');
    });

    await test('A stopped reply does not start the memory job', async () => {
      settings.memory = true;
      newChat(); send('SLOW a long answer please');
      await sleep(250);
      const n = calls.length;
      els.send.click();   // Stop
      await finished(); await sleep(300);
      settings.memory = false;
      assert(current.messages.at(-1)?.content !== 'Once upon a time, a keeper kept the light.', 'reply was not stopped');
      assert(!calls.slice(n).some((c) => c.url.startsWith('/api/chat') && c.body?.format && String(c.body?.messages?.at(-1)?.content || '').includes("The user's message")), 'memory learning ran after a stopped reply');
    });

    await test('No errors in the page during the test', async () => {
      assert(!errors.length, errors.slice(0, 3).join(' | '));
    });
  } finally {
    // ---- put everything back
    window.fetch = realFetch;
    controller?.abort();
    voice.finishing = null; voice.sendWhenDone = false;
    for (const [k, v] of Object.entries(saved)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, savedSettings);
    chats = store.get('qc.chats', []); current = null; codeDraft = null;
    renderList(); newChat(); updateCodeUI(); updateAccountsUI(); refreshConnectors();
  }
  // Check the restore stuck (nothing late wrote test data back)
  const lateWrites = [], realSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { if (k === 'qc.chats') lateWrites.push(new Error().stack.split('\n').slice(2, 7).map((x) => x.trim()).join(' < ')); return realSet.call(this, k, v); };
  await sleep(1500);
  Storage.prototype.setItem = realSet;
  await test('Your chats and settings were put back', async () => {
    const now = Object.fromEntries(KEYS.map((k) => [k, localStorage.getItem(k)]));
    for (const k of Object.keys(saved)) assert(now[k] === saved[k], `${k} differs after the test (${String(now[k]).length} vs ${String(saved[k]).length} chars)${lateWrites.length ? '; late write from: ' + lateWrites[0] : '; no late write, so the restore itself is off'}${(() => { const x = String(now[k]), y = String(saved[k]); let i = 0; while (i < x.length && x[i] === y[i]) i++; return ` — first difference at ${i}: now "…${x.slice(Math.max(0, i - 60), i + 60)}…" vs before "…${y.slice(Math.max(0, i - 60), i + 60)}…"`; })()}`);
  });
  const passed = results.filter((r) => r.ok).length, failed = results.length - passed;
  panel.querySelector('#st-sum').textContent = `${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`;
  window.__selftest = { passed, failed, results };
})();
