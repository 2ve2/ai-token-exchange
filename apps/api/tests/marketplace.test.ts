import { expect, test } from "bun:test";
import { app } from "../src/app";
import { ESCROW_WALLET_ID } from "../src/constants/escrow";
import { addAmounts } from "../src/lib/money";
import { authJson, createUser, fund, getBalance, unique } from "./helpers";

interface ListingResult {
	listing: { id: string; amount: string; price_per_token: string; status: string };
	seller_balance_after: string;
}

function listingId(result: Record<string, unknown>): string {
	return ((result as { listing: { id: string } }).listing).id;
}

test("creating a listing escrows the tokens immediately", async () => {
	const seller = await createUser();
	await fund(seller.walletId, "50.00000000");
	const escrowBefore = await getBalance(ESCROW_WALLET_ID);

	const result = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 20,
		price_per_token: 0.5,
	});
	expect(result.status).toBe(201);
	const created = result.json.result as ListingResult;
	expect(created.listing.status).toBe("active");
	expect(created.listing.amount).toBe("20.00000000");
	expect(created.seller_balance_after).toBe("30.00000000");

	// Seller balance dropped and escrow grew by exactly the amount
	expect(await getBalance(seller.walletId)).toBe("30.00000000");
	expect(await getBalance(ESCROW_WALLET_ID)).toBe(addAmounts(escrowBefore, "20.00000000"));
}, 30000);

test("listing creation with insufficient balance is rejected and nothing changes", async () => {
	const seller = await createUser();
	await fund(seller.walletId, "5.00000000");

	const result = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 10,
		price_per_token: 1,
	});
	expect(result.status).toBe(400);
	expect(result.json.error).toBe("Insufficient balance");
	expect(await getBalance(seller.walletId)).toBe("5.00000000");
}, 30000);

test("public listing feed is sorted by price ascending and paginated", async () => {
	const seller = await createUser();
	await fund(seller.walletId, "1000.00000000");

	for (const price of [0.9, 0.1, 0.5]) {
		const res = await authJson(seller.token, "/marketplace/listings", "POST", {
			amount: 1,
			price_per_token: price,
		});
		expect(res.status).toBe(201);
	}

	// Public: no Authorization header at all
	const page = await app.request("/marketplace/listings?limit=2");
	expect(page.status).toBe(200);
	const pageJson = (await page.json()) as {
		result: { listings: { price_per_token: string; seller_username: string }[]; total: number };
	};
	expect(pageJson.result.listings).toHaveLength(2);
	expect(pageJson.result.total).toBeGreaterThanOrEqual(3);
	const prices = pageJson.result.listings.map((l) => l.price_per_token);
	const sorted = [...prices].sort();
	expect(prices).toEqual(sorted);
	expect(pageJson.result.listings[0]?.seller_username).toMatch(/^t\d+/);

	// Offset skips the cheapest entries
	const page2 = await app.request("/marketplace/listings?limit=2&offset=2");
	const page2Json = (await page2.json()) as { result: { listings: unknown[] } };
	expect(page2Json.result.listings).toHaveLength(2);
}, 30000);

test("happy-path buy: four ledger movements, correct balances, listing fulfilled", async () => {
	const seller = await createUser();
	const buyer = await createUser();
	await fund(seller.walletId, "10.00000000");
	await fund(buyer.walletId, "10.00000000");

	const created = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 10,
		price_per_token: 0.5,
	});
	expect(created.status).toBe(201);
	const listing = listingId(created.json.result as Record<string, unknown>);

	const bought = await authJson(buyer.token, `/marketplace/listings/${listing}/buy`, "POST", {
		idempotency_key: `buy-${unique()}`,
	});
	expect(bought.status).toBe(200);
	const purchase = bought.json.result as {
		payment: string;
		token_amount: string;
		buyer: { balance_after: string };
		seller: { username: string };
		listing: { status: string };
	};
	expect(purchase.payment).toBe("5.00000000");
	expect(purchase.token_amount).toBe("10.00000000");
	expect(purchase.buyer.balance_after).toBe("15.00000000"); // 10 - 5 payment + 10 tokens
	expect(purchase.listing.status).toBe("fulfilled");

	// Buyer: 10 - 5 + 10 = 15; Seller: 0 available + 5 payment; escrow drained by 10
	expect(await getBalance(buyer.walletId)).toBe("15.00000000");
	expect(await getBalance(seller.walletId)).toBe("5.00000000");

	// Second buy attempt: 409
	const retry = await authJson(buyer.token, `/marketplace/listings/${listing}/buy`, "POST", {});
	expect(retry.status).toBe(409);
	expect(retry.json.error).toBe("Listing is no longer available");
}, 30000);

test("two concurrent buys on the same listing: exactly one wins, the other gets 409", async () => {
	const seller = await createUser();
	const buyerA = await createUser();
	const buyerB = await createUser();
	await fund(seller.walletId, "10.00000000");
	await fund(buyerA.walletId, "100.00000000");
	await fund(buyerB.walletId, "100.00000000");

	const created = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 10,
		price_per_token: 0.5,
	});
	const listing = listingId(created.json.result as Record<string, unknown>);

	const [resA, resB] = await Promise.all([
		authJson(buyerA.token, `/marketplace/listings/${listing}/buy`, "POST", {}),
		authJson(buyerB.token, `/marketplace/listings/${listing}/buy`, "POST", {}),
	]);

	const statuses = [resA.status, resB.status].sort();
	expect(statuses).toEqual([200, 409]);

	const winner = resA.status === 200 ? resA : resB;
	const loser = resA.status === 200 ? resB : resA;
	expect((loser.json as { error: string }).error).toBe("Listing is no longer available");
	expect((winner.json.result as { listing: { status: string } }).listing.status).toBe("fulfilled");

	// Winner is the only buyer whose balance changed
	const balances = [await getBalance(buyerA.walletId), await getBalance(buyerB.walletId)].sort();
	expect(balances).toEqual(["100.00000000", "105.00000000"]);
	expect(await getBalance(seller.walletId)).toBe("5.00000000");
}, 30000);

test("buy with insufficient balance: 400 and the listing stays active and retryable", async () => {
	const seller = await createUser();
	const buyer = await createUser();
	await fund(seller.walletId, "10.00000000");
	await fund(buyer.walletId, "1.00000000");

	const created = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 10,
		price_per_token: 0.5,
	});
	const listing = listingId(created.json.result as Record<string, unknown>);

	const failed = await authJson(buyer.token, `/marketplace/listings/${listing}/buy`, "POST", {});
	expect(failed.status).toBe(400);
	expect(failed.json.error).toBe("Insufficient balance");

	// Listing untouched by the failed attempt
	const feed = await app.request("/marketplace/listings");
	const feedJson = (await feed.json()) as { result: { listings: { id: string }[] } };
	expect(feedJson.result.listings.some((l) => l.id === listing)).toBe(true);

	// Fund the buyer and retry: now it works
	await fund(buyer.walletId, "10.00000000");
	const retried = await authJson(buyer.token, `/marketplace/listings/${listing}/buy`, "POST", {});
	expect(retried.status).toBe(200);
}, 30000);

test("cancel releases escrow; guards for non-seller, double cancel, buying a cancelled listing", async () => {
	const seller = await createUser();
	const other = await createUser();
	const buyer = await createUser();
	await fund(seller.walletId, "50.00000000");
	await fund(buyer.walletId, "100.00000000");

	const created = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 20,
		price_per_token: 0.8,
	});
	const listing = listingId(created.json.result as Record<string, unknown>);
	expect(await getBalance(seller.walletId)).toBe("30.00000000");

	// Non-seller cancel: 403
	const notOwner = await authJson(other.token, `/marketplace/listings/${listing}/cancel`, "POST");
	expect(notOwner.status).toBe(403);
	expect(notOwner.json.error).toBe("You can only cancel your own listing");

	// Seller cancel: escrow released
	const cancelled = await authJson(seller.token, `/marketplace/listings/${listing}/cancel`, "POST");
	expect(cancelled.status).toBe(200);
	const cancelResult = cancelled.json.result as {
		listing: { status: string };
		seller_balance_after: string;
	};
	expect(cancelResult.listing.status).toBe("cancelled");
	expect(cancelResult.seller_balance_after).toBe("50.00000000");
	expect(await getBalance(seller.walletId)).toBe("50.00000000");

	// Double cancel: 409
	const again = await authJson(seller.token, `/marketplace/listings/${listing}/cancel`, "POST");
	expect(again.status).toBe(409);

	// Buying a cancelled listing: 409
	const buyCancelled = await authJson(
		buyer.token,
		`/marketplace/listings/${listing}/buy`,
		"POST",
		{},
	);
	expect(buyCancelled.status).toBe(409);
	expect(buyCancelled.json.error).toBe("Listing is no longer available");
}, 30000);

test("buying your own listing is rejected", async () => {
	const seller = await createUser();
	await fund(seller.walletId, "10.00000000");

	const created = await authJson(seller.token, "/marketplace/listings", "POST", {
		amount: 5,
		price_per_token: 0.5,
	});
	const listing = listingId(created.json.result as Record<string, unknown>);

	const result = await authJson(seller.token, `/marketplace/listings/${listing}/buy`, "POST", {});
	expect(result.status).toBe(400);
	expect(result.json.error).toBe("Cannot buy your own listing");
}, 30000);
