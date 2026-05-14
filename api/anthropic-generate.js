import { requireSession } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { model, messages, systemPrompt } = req.body;

    if (!model || !messages) {
      return res.status(400).json({ error: 'Missing required fields: model, messages' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 8192,
        system: systemPrompt || '',
        messages: messages
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[FinOps API Proxy] Anthropic Error:', errorText);
      return res.status(response.status).json({ error: `Anthropic API Error: ${errorText}` });
    }

    const data = await response.json();
    const textContent = data.content?.find(c => c.type === 'text');

    return res.status(200).json({ text: textContent?.text || '' });
  } catch (error) {
    console.error('[FinOps API Proxy] Error:', error.message);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
