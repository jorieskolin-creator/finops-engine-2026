import { requireSession } from "../lib/auth.js";
import {
  completeInternalModelResult,
  failInternalModelResult,
  registerInternalModelResult
} from "../lib/internalModelResults.js";

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

const compactReason = (value) =>
  typeof value === 'string' && value.length > 0 ? value : 'unknown';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const started = Date.now();
  const { model, input, instructions, reasoning, maxOutputTokens, stage, runId, internalPipelineCall, internalCallId } = req.body || {};
  const isInternalPipelineCall = internalPipelineCall === true;
  const tag = `[run=${runId || '?'}] provider=openai stage=${stage || '?'} model=${model || '?'}`;
  const metadata = { runId, provider: 'openai', stage, model };
  const callIdLog = internalCallId ? ` internal_call_id=${internalCallId}` : '';

  if (!model || !input) {
    console.warn(`${tag} status=bad_request msg="missing model or input"`);
    return res.status(400).json({ error: 'Missing required fields: model, input' });
  }
  const apiKey = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(`${tag} status=misconfigured msg="GPT_API_KEY or OPENAI_API_KEY not set"`);
    return res.status(500).json({ error: 'GPT_API_KEY or OPENAI_API_KEY not configured on server' });
  }
  if (isInternalPipelineCall && internalCallId) {
    registerInternalModelResult(internalCallId, metadata);
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const upstreamController = new AbortController();
  let clientGone = false;
  let responseClosed = false;
  const onRequestAborted = () => {
    if (clientGone) return;
    clientGone = true;
    console.warn(`${tag} status=client_disconnected close_source=req_aborted internal_pipeline_call=${isInternalPipelineCall} duration_ms=${Date.now() - started}`);
    upstreamController.abort();
  };
  const onResponseClosed = () => {
    if (res.writableFinished || clientGone || responseClosed) return;
    responseClosed = true;
    if (isInternalPipelineCall) {
      console.warn(`${tag} status=response_closed close_source=response_closed internal_pipeline_call=true duration_ms=${Date.now() - started}${callIdLog}`);
      return;
    }
    clientGone = true;
    console.warn(`${tag} status=client_disconnected close_source=response_closed internal_pipeline_call=false duration_ms=${Date.now() - started}`);
    upstreamController.abort();
  };
  req.on('aborted', onRequestAborted);
  res.on('close', onResponseClosed);

  const writeFrame = (obj) => {
    if (res.writableEnded || res.destroyed || clientGone || responseClosed) return false;
    try {
      res.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      responseClosed = true;
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
      failInternalModelResult(internalCallId, `OpenAI API Error (${upstreamResp.status}): ${errorText.substring(0, 500)}`, metadata);
      console.error(`${tag} event=internal_result_error message="OpenAI API Error (${upstreamResp.status})"${callIdLog}`);
      writeFrame({ type: 'error', message: `OpenAI API Error (${upstreamResp.status}): ${errorText.substring(0, 500)}` });
      clearInterval(keepalive);
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }

    const payload = await upstreamResp.json();
    const text = extractOutputText(payload);
    const usage = payload?.usage || null;
    const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens || 0;
    const incompleteReason = payload?.status === 'incomplete'
      ? compactReason(payload?.incomplete_details?.reason)
      : '';
    if (clientGone) {
      console.warn(`${tag} status=aborted_before_write duration_ms=${duration} openai_status=${payload?.status || 'unknown'} incomplete_reason=${incompleteReason || 'none'} response_chars=${text.length} reasoning_tokens=${reasoningTokens}`);
    } else if (payload?.status === 'incomplete') {
      const msg = `OpenAI response incomplete: ${incompleteReason || 'unknown'}`;
      console.warn(`${tag} status=incomplete duration_ms=${duration} incomplete_reason=${incompleteReason || 'unknown'} response_chars=${text.length} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0} reasoning_tokens=${reasoningTokens}`);
      failInternalModelResult(internalCallId, msg, metadata);
      console.error(`${tag} event=internal_result_error message="${msg}"${callIdLog}`);
      writeFrame({ type: 'error', message: msg });
    } else if (text.trim().length === 0) {
      const msg = 'OpenAI response contained no visible output text';
      console.warn(`${tag} status=empty_output duration_ms=${duration} openai_status=${payload?.status || 'unknown'} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0} reasoning_tokens=${reasoningTokens}`);
      failInternalModelResult(internalCallId, msg, metadata);
      console.error(`${tag} event=internal_result_error message="${msg}"${callIdLog}`);
      writeFrame({ type: 'error', message: msg });
    } else if (responseClosed) {
      completeInternalModelResult(internalCallId, text, usage, metadata);
      console.warn(`${tag} status=completed_after_response_closed duration_ms=${duration} openai_status=${payload?.status || 'unknown'} incomplete_reason=${incompleteReason || 'none'} response_chars=${text.length} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0} reasoning_tokens=${reasoningTokens} internal_pipeline_call=${isInternalPipelineCall}${callIdLog}`);
      console.log(`${tag} level=info event=internal_result_stored status=done response_chars=${text.length}${callIdLog}`);
    } else {
      completeInternalModelResult(internalCallId, text, usage, metadata);
      console.log(`${tag} status=ok duration_ms=${duration} openai_status=${payload?.status || 'unknown'} response_chars=${text.length} input_tokens=${usage?.input_tokens || 0} output_tokens=${usage?.output_tokens || 0} reasoning_tokens=${reasoningTokens}`);
      writeFrame({ type: 'done', text, usage });
    }
    clearInterval(keepalive);
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    clearInterval(keepalive);
    const duration = Date.now() - started;
    if (error?.name === 'AbortError' || clientGone) {
      console.warn(`${tag} status=aborted duration_ms=${duration}`);
    } else {
      const msg = (error?.message || '').replace(/"/g, "'");
      console.error(`${tag} status=error duration_ms=${duration} msg="${msg}"`);
      failInternalModelResult(internalCallId, error?.message || 'Internal server error', metadata);
      console.error(`${tag} event=internal_result_error message="${msg}"${callIdLog}`);
      writeFrame({ type: 'error', message: error?.message || 'Internal server error' });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
