import { Hono } from "hono";
import { successResponse, validationErrorResponse } from "@/lib/response-helpers";
import { marketplaceService } from "@/services/marketplaceService";
import type { AppEnv } from "@/types/context";
import { BuyListingSchema, ListingCreateSchema } from "@/types/schemas";

const app = new Hono<AppEnv>();

/**
 * POST /marketplace/listings
 * Create a listing; the amount is escrowed immediately (escrow_lock).
 */
app.post("/listings", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = ListingCreateSchema.safeParse(body);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const result = await marketplaceService.createListing(c.get("user").id, {
		amount: parsed.data.amount,
		pricePerToken: parsed.data.price_per_token,
	});

	return successResponse(c, result, "Listing created", 201);
});

/**
 * GET /marketplace/listings
 * Public feed of active listings, price ascending, paginated.
 * Query: limit (1-100, default 20), offset (>= 0)
 */
app.get("/listings", async (c) => {
	let limit = Number(c.req.query("limit")) || 20;
	let offset = Number(c.req.query("offset")) || 0;
	if (limit < 1 || limit > 100) limit = 20;
	if (offset < 0) offset = 0;

	const result = await marketplaceService.getListings({ limit, offset });
	return successResponse(c, result);
});

/**
 * POST /marketplace/listings/:id/buy
 * Buy an active listing (whole lot). Optional idempotency_key.
 */
app.post("/listings/:id/buy", async (c) => {
	const body = await c.req.json().catch(() => null);
	const parsed = BuyListingSchema.safeParse(body ?? {});
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return validationErrorResponse(c, first?.message ?? "Invalid input", first?.path.join("."));
	}

	const result = await marketplaceService.buy(
		c.get("user").id,
		c.req.param("id"),
		parsed.data.idempotency_key,
	);

	return successResponse(c, result, "Purchase successful");
});

/**
 * POST /marketplace/listings/:id/cancel
 * Seller-only: cancel an active listing, escrowed tokens are released.
 */
app.post("/listings/:id/cancel", async (c) => {
	const result = await marketplaceService.cancel(c.get("user").id, c.req.param("id"));
	return successResponse(c, result, "Listing cancelled");
});

export { app as marketplaceRoutes };
