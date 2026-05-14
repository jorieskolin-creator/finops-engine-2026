import { requireSession } from "../lib/auth.js";

// Streaming Anthropic proxy.
//
// Wire format to the client is NDJSON (one JSON object per line):
//   {"type":"text","delta":"..."}        text chunks as they arrive
//   {"type":"keepalive"}                  every 15s while idle, keeps the
//                                         proxy connection alive
//   {"type":"done","text":"...","usage":...}  terminal success frame
//   {"type":"error","message":"..."}      terminal error frame
//
// Two infrastructure benefits over the previous buffered implementation:
//   1. The TCP connection between browser ↔ Railway ↔ Express has data
//      flowing every <=15s, so edge idle-timeouts can't kill it mid-call.
//   2. If the client disconnects (browser close, network drop), we abort
//      the upstream Anthropic call instead of paying for a response no
//      one is waiting for.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const started = Date.now();
  const { model, messages, systemPrompt, maxTokens, thinking, stage, runId } = req.body || {};
  const tag = `[run=${runId || '?'}] provider=anthropic stage=${stage || '?'} model=${model || '?'}`;

  if (!model || !messages) {
    console.warn(`${tag} status=bad_request msg="missing model or messages"`);
    return res.status(400).json({ error: 'Missing required fields: model, messages' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`${tag} status=misconfigured msg="ANTHROPIC_API_KEY not set"`);
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  // Best-effort hint to disable proxy buffering (nginx/cloudflare convention).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const upstreamController = new AbortController();
  let clientGone = false;
  const onClientGone = () => {
    if (clientGone) return;
    if (res.writableFinished) return;
    clientGone = true;
    console.warn(`${tag} status=client_disconnected duration_ms=${Date.now() - started}`);
    upstreamController.abort();
  };
  req.on('close', onClientGone);
  res.on('close', onClientGone);

  const writeFrame = (obj) => {
    if (res.writableEnded || clientGone) return false;
    try {
      res.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  };

  const keepalive = setInterval(() => writeFrame({ type: 'keepalive' }), 15000);

  try {
    console.log(`${tag} status=start streaming=true`);

    const payload = {
      model,
      max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      system: systemPrompt || '',
      messages,
      stream: true,
    };
    if (thinking && typeof thinking === 'object') payload.thinking = thinking;

    const upstreamResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: upstreamController.signal,
    });

    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '');
      const duration = Date.now() - started;
      console.error(`${tag} status=upstream_error http=${upstreamResp.status} duration_ms=${duration} msg="${errorText.replace(/"/g, "'").substring(0, 500)}"`);
      writeFrame({ type: 'error', message: `Anthropic API Error (${upstreamResp.status}): ${errorText.substring(0, 500)}` });
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
      return;
    }

    let accumulatedText = '';
    let usage = null;
    const reader = upstreamResp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      if (clientGone) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines (\n\n). Each event may have
      // multiple lines; we only care about "data: ..." lines.
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const evt of events) {
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }

          if (parsed.type === 'message_start' && parsed.message?.usage) {
            usage = { ...(usage || {}), ...parsed.message.usage };
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            const delta = parsed.delta.text || '';
            if (delta) {
              accumulatedText += delta;
              if (!writeFrame({ type: 'text', delta })) break;
            }
          } else if (parsed.type === 'message_delta' && parsed.usage) {
            usage = { ...(usage || {}), ...parsed.usage };
          } else if (parsed.type === 'error') {
            const msg = parsed.error?.message || 'upstream error';
            console.error(`${tag} status=stream_error duration_ms=${Date.now() - started} msg="${msg.replace(/"/g, "'")}"`);
            writeFrame({ type: 'error', message: msg });
            clearInterval(keepalive);
            if (!res.writableEnded) res.end();
            return;
          }
        }
      }
    }

    const duration = Date.now() - started;
    if (clientGone) {
      console.warn(`${tag} status=aborted_mid_stream duration_ms=${duration} chars_read=${accumulatedText.length}`);
    } else {
      console.log(`${tag} status=ok duration_ms=${duration} response_chars=${accumulatedText.length} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0}`);
      writeFrame({ type: 'done', text: accumulatedText, usage });
    }
    clearInterval(keepalive);
    if (!res.writableEnded) res.end();
  } catch (error) {
    clearInterval(keepalive);
    const duration = Date.now() - started;
    if (error?.name === 'AbortError' || clientGone) {
      console.warn(`${tag} status=aborted duration_ms=${duration}`);
    } else {
      const msg = (error?.message || '').replace(/"/g, "'");
      console.error(`${tag} status=error duration_ms=${duration} msg="${msg}"`);
      writeFrame({ type: 'error', message: error?.message || 'Internal server error' });
    }
    if (!res.writableEnded) res.end();
  }
}
