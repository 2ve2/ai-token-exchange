/**
 * Per-model pricing for the AI proxy, in credits per 1,000 tokens.
 * Local Ollama models only — cloud-routed models are deliberately
 * excluded (zero-cost, no external API key risk).
 */
export const MODEL_PRICES: Record<string, string> = {
	"qwen2.5:3b": "0.01",
	"qwen2.5:1.5b-instruct-q4_K_M": "0.005",
	"phi3:latest": "0.008",
};

export function availableModels(): string[] {
	return Object.keys(MODEL_PRICES);
}

/** Hard cap on generated tokens per request (also caps the billing hold). */
export const NUM_PREDICT_CAP = 512;

/**
 * Extra tokens added to the reservation estimate on top of
 * num_predict + prompt length. The hold is generous on purpose —
 * unused reservation is refunded after generation.
 */
export const PROMPT_BUFFER_TOKENS = 64;

export const MAX_PROMPT_CHARS = 8000;
export const PROVIDER_TIMEOUT_MS = 120_000;

/** Demo mint limits. */
export const DEFAULT_MINT_AMOUNT = "100";
export const MAX_MINT_AMOUNT = "10000";
