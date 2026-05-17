import { GoogleGenAI } from "@google/genai";
import { requireSession } from "../lib/auth.js";

// Streaming Gemini proxy. Same NDJSON wire format as anthropic-generate.js:
//   {"type":"text","delta":"..."}
//   {"type":"keepalive"}
//   {"type":"done","text":"..."}
//   {"type":"error","message":"..."}
//
// The @google/genai SDK's generateContentStream() returns an AsyncIterable of
// chunks; each chunk has a .text accessor with the new text. We forward those
// as 'text' frames and accumulate for the terminal 'done' frame. On request
// abort we break the read loop — the SDK doesn't expose an upstream AbortSignal
// we can plumb in, but at least we stop holding the connection.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const started = Date.now();
  const { model, contents, systemInstruction, thinkingConfig, stage, runId, internalPipelineCall } = req.body || {};
  const isInternalPipelineCall = internalPipelineCall === true;
  const tag = `[run=${runId || '?'}] provider=gemini stage=${stage || '?'} model=${model || '?'}`;

  if (!model || !contents) {
    console.warn(`${tag} status=bad_request msg="missing model or contents"`);
    return res.status(400).json({ error: 'Missing required fields: model, contents' });
  }
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    console.error(`${tag} status=misconfigured msg="GEMINI_API_KEY not set"`);
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let clientGone = false;
  let responseClosed = false;
  const onRequestAborted = () => {
    if (clientGone) return;
    clientGone = true;
    console.warn(`${tag} status=client_disconnected close_source=req_aborted internal_pipeline_call=${isInternalPipelineCall} duration_ms=${Date.now() - started}`);
  };
  const onResponseClosed = () => {
    if (res.writableFinished || clientGone || responseClosed) return;
    responseClosed = true;
    if (isInternalPipelineCall) {
      console.warn(`${tag} status=response_closed close_source=response_closed internal_pipeline_call=true duration_ms=${Date.now() - started}`);
      return;
    }
    clientGone = true;
    console.warn(`${tag} status=client_disconnected close_source=response_closed internal_pipeline_call=false duration_ms=${Date.now() - started}`);
  };
  // See api/anthropic-generate.js for why req.on('close') is NOT used here.
  // body-parser closes req on the next tick and would fire a false positive.
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
    console.log(`${tag} status=start streaming=true`);

    const ai = new GoogleGenAI({ apiKey });
    const config = {
      systemInstruction,
      responseMimeType: "application/json",
      ...(thinkingConfig ? { thinkingConfig } : {}),
    };

    const stream = await ai.models.generateContentStream({ model, contents, config });

    let accumulatedText = '';
    for await (const chunk of stream) {
      if (clientGone) break;
      const delta = chunk?.text || '';
      if (delta) {
        accumulatedText += delta;
        if (!writeFrame({ type: 'text', delta }) && !isInternalPipelineCall) break;
      }
    }

    const duration = Date.now() - started;
    if (clientGone) {
      console.warn(`${tag} status=aborted_mid_stream duration_ms=${duration} chars_read=${accumulatedText.length}`);
    } else if (responseClosed) {
      console.warn(`${tag} status=completed_after_response_closed duration_ms=${duration} response_chars=${accumulatedText.length} internal_pipeline_call=${isInternalPipelineCall}`);
    } else {
      console.log(`${tag} status=ok duration_ms=${duration} response_chars=${accumulatedText.length}`);
      writeFrame({ type: 'done', text: accumulatedText });
    }
    clearInterval(keepalive);
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    clearInterval(keepalive);
    const duration = Date.now() - started;
    if (clientGone) {
      console.warn(`${tag} status=aborted duration_ms=${duration}`);
    } else {
      const msg = (error?.message || '').replace(/"/g, "'");
      console.error(`${tag} status=error duration_ms=${duration} msg="${msg}"`);
      writeFrame({ type: 'error', message: error?.message || 'Internal server error' });
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
