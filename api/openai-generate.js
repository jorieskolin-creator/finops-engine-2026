import { requireSession } from "../lib/auth.js";

// Non-streaming OpenAI Responses proxy.
//
// The client-side router still expects the same NDJSON terminal frame used by
// the streaming Gemini/Anthropic proxies, but this endpoint deliberately waits
// for the full OpenAI response before writing. Phase 3 fact-checking benefits
// more from reliability than partial-token streaming.

const extractOutputText = (payload) => {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') parts.push(c.text);
      if (typeof c?.output_text === 'string') parts.push(c.output_text);
    }
  }
  return parts.join('');
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const started = Date.now();
  const { model, input, instructions, reasoning, maxOutputTokens, stage, runId } = req.body || {};
  const tag = `[run=${runId || '?'}] provider=openai stage=${stage || '?'} model=${model || '?'}`;

  if (!model || !input) {
    console.warn(`${tag} status=bad_request msg="missing model or input"`);
    return res.status(400).json({ error: 'Missing required fields: model, input' });
  }
  const apiKey = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(`${tag} status=misconfigured msg="GPT_API_KEY or OPENAI_API_KEY not set"`);
    return res.status(500).json({ error: 'GPT_API_KEY or OPENAI_API_KEY not configured on server' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
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
  req.on('aborted', onClientGone);
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
    console.log(`${tag} status=start streaming=false`);

    const body = {
      model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(typeof maxOutputTokens === 'number' && maxOutputTokens > 0
        ? { max_output_tokens: maxOutputTokens }
        : {}),
    };

    const upstreamResp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: upstreamController.signal,
    });

    const duration = Date.now() - started;
    if (!upstreamResp.ok) {
      const errorText = await upstreamResp.text().catch(() => '');
      console.error(`${tag} status=upstream_error http=${upstreamResp.status} duration_ms=${duration} msg="${errorText.replace(/"/g, "'").substring(0, 500)}"`);
      writeFrame({ type: 'error', message: `OpenAI API Error (${upstreamResp.status}): ${errorText.substring(0, 500)}` });
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
      return;
    }

    const payload = await upstreamResp.json();
    const text = extractOutputText(payload);
    const usage = payload?.usage || null;
    if (clientGone) {
      console.warn(`${tag} status=aborted_before_write duration_ms=${duration} response_chars=${text.length}`);
    } else {
      console.log(`${tag} status=ok duration_ms=${duration} response_chars=${text.length} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0}`);
      writeFrame({ type: 'done', text, usage });
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
