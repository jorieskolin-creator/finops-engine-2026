import { GoogleGenAI } from "@google/genai";
import { requireSession } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { model, contents, systemInstruction, thinkingConfig } = req.body;

    if (!model || !contents) {
      return res.status(400).json({ error: 'Missing required fields: model, contents' });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
    }

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

    return res.status(200).json({ text: response.text });
  } catch (error) {
    console.error('[FinOps API Proxy] Gemini Error:', error.message);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
