import { Hono } from "hono";
import { normalizeAmount } from "@/lib/money";
import { notFoundResponse, successResponse, validationErrorResponse } from "@/lib/response-helpers";
import { walletService } from "@/services/walletService";
import type { AppEnv } from "@/types/context";
import { MintSchema } from "@/types/schemas";

const app = new Hono<AppEnv>();

/**
 * GET /wallet
 * Returns the authenticated user's wallet_id and current balance
 */
app.get("/", async (c) => {
	const user = c.get("user");

	const wallet = await walletService.getWalletByUserId(user.id);
	if (!wallet) {
		return notFoundResponse(c, "Wallet not found");
	}

	return successResponse(c, {
		wallet_id: wallet.walletId,
		balance: normalizeAmount(wallet.balance),
	});
});

/**
 * POST /wallet/mint
 * Demo-only top-up: credits the caller's wallet from the system
 * treasury via the standard ledger pattern (type: mint).
 * Body (optional): { amount } — defaults to 100, capped at 10000.
 */
app.post("/mint", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = MintSchema.safeParse(body ?? {});
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const result = await walletService.mintToWallet(c.get("user").id, parsed.data.amount);
	return successResponse(c, result, "Minted");
});

/**
 * GET /wallet/lookup/:wallet_id
 * Read-only recipient lookup for the transfer confirmation screen
 * ("You're sending to @username") — never mutates balances.
 */
app.get("/lookup/:wallet_id", async (c) => {
	const walletId = c.req.param("wallet_id");

	const owner = await walletService.getWalletOwnerByWalletId(walletId);
	if (!owner) {
		return notFoundResponse(c, "Wallet not found");
	}

	return successResponse(c, owner);
});

export { app as walletRoutes };
