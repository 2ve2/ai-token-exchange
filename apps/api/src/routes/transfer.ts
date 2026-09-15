import { Hono } from "hono";
import { successResponse, validationErrorResponse } from "@/lib/response-helpers";
import { transferService } from "@/services/transferService";
import type { AppEnv } from "@/types/context";
import { TransferSchema } from "@/types/schemas";

const app = new Hono<AppEnv>();

/**
 * POST /transfer
 * Peer-to-peer transfer identified by the recipient's wallet_id.
 * Idempotent per idempotency_key: replays return the original result.
 */
app.post("/", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = TransferSchema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const result = await transferService.transfer(c.get("user").id, {
		recipientWalletId: parsed.data.recipient_wallet_id,
		amount: parsed.data.amount,
		idempotencyKey: parsed.data.idempotency_key,
	});

	return successResponse(c, result, "Transfer successful");
});

export { app as transferRoutes };
