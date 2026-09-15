import { Hono } from "hono";
import { successResponse, validationErrorResponse } from "@/lib/response-helpers";
import { aiProxyService } from "@/services/aiProxyService";
import type { AppEnv } from "@/types/context";
import { GenerateSchema } from "@/types/schemas";

const app = new Hono<AppEnv>();

/**
 * POST /ai/generate
 * Proxies a prompt to a local Ollama model and bills the exact token
 * usage via the ledger (reserve -> generate -> settle).
 */
app.post("/generate", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = GenerateSchema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const result = await aiProxyService.generate(c.get("user").id, {
		prompt: parsed.data.prompt,
		model: parsed.data.model,
	});

	return successResponse(c, result, "Generation complete");
});

/**
 * GET /ai/usage
 * Paginated AI usage history for the authenticated user.
 * Query: limit (1-100, default 20), offset (>= 0)
 */
app.get("/usage", async (c) => {
	let limit = Number(c.req.query("limit")) || 20;
	let offset = Number(c.req.query("offset")) || 0;
	if (limit < 1 || limit > 100) limit = 20;
	if (offset < 0) offset = 0;

	const result = await aiProxyService.getUsage(c.get("user").id, { limit, offset });
	return successResponse(c, result);
});

export { app as aiRoutes };
