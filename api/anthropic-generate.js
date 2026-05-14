import { requireSession } from "../lib/auth.js";

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

  try {
    if (!model || !messages) {
      console.warn(`${tag} status=bad_request msg="missing model or messages"`);
      return res.status(400).json({ error: 'Missing required fields: model, messages' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(`${tag} status=misconfigured msg="ANTHROPIC_API_KEY not set"`);
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    console.log(`${tag} status=start`);

    const payload = {
      model,
      max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      system: systemPrompt || '',
      messages,
    };
    if (thinking && typeof thinking === 'object') {
      payload.thinking = thinking;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const duration = Date.now() - started;
      console.error(`${tag} status=upstream_error http=${response.status} duration_ms=${duration} msg="${errorText.replace(/"/g, "'").substring(0, 500)}"`);
      return res.status(response.status).json({ error: `Anthropic API Error: ${errorText}` });
    }

    const data = await response.json();
    const textContent = data.content?.find(c => c.type === 'text');
    const text = textContent?.text || '';

    const duration = Date.now() - started;
    const usage = data.usage || {};
    console.log(`${tag} status=ok duration_ms=${duration} response_chars=${text.length} input_tokens=${usage.input_tokens || 0} output_tokens=${usage.output_tokens || 0}`);

    return res.status(200).json({ text });
  } catch (error) {
    const duration = Date.now() - started;
    console.error(`${tag} status=error duration_ms=${duration} msg="${(error.message || '').replace(/"/g, "'")}"`);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
