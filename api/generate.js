import { GoogleGenAI } from "@google/genai";
import { requireSession } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const started = Date.now();
  const { model, contents, systemInstruction, thinkingConfig, stage, runId } = req.body || {};
  const tag = `[run=${runId || '?'}] provider=gemini stage=${stage || '?'} model=${model || '?'}`;

  try {
    if (!model || !contents) {
      console.warn(`${tag} status=bad_request msg="missing model or contents"`);
      return res.status(400).json({ error: 'Missing required fields: model, contents' });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      console.error(`${tag} status=misconfigured msg="GEMINI_API_KEY not set"`);
      return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
    }

    console.log(`${tag} status=start`);

    const ai = new GoogleGenAI({ apiKey });

    const config = {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      ...(thinkingConfig ? { thinkingConfig } : {})
    };

    const response = await ai.models.generateContent({
      model: model,
      contents: contents,
      config
    });

    const duration = Date.now() - started;
    const textLen = response.text?.length || 0;
    console.log(`${tag} status=ok duration_ms=${duration} response_chars=${textLen}`);

    return res.status(200).json({ text: response.text });
  } catch (error) {
    const duration = Date.now() - started;
    console.error(`${tag} status=error duration_ms=${duration} msg="${(error.message || '').replace(/"/g, "'")}"`);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
