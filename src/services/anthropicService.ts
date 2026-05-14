
const callAnthropicGenerate = async (model: string, messages: any[], systemPrompt: string): Promise<{ text: string }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 595000);

  try {
    const response = await fetch('/api/anthropic-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, systemPrompt }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic Proxy Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const callOpusStrategy = async (messages: any[], systemPrompt: string): Promise<{ text: string }> => {
  return callAnthropicGenerate('claude-opus-4-7', messages, systemPrompt);
};

export const callSonnetValidator = async (messages: any[], systemPrompt: string): Promise<{ text: string }> => {
  return callAnthropicGenerate('claude-sonnet-4-6', messages, systemPrompt);
};

export { callAnthropicGenerate };
