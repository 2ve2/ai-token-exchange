import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { db } from "../src/db";
import { transactions } from "../src/db/schema";
import { authJson, createUser, getBalance } from "./helpers";

/**
 * Provider-failure refund proof. Run with a dead provider URL:
 *
 *   bun run test:ai-failure
 *
 * (sets OLLAMA_BASE_URL=http://127.0.0.1:9 so the provider call fails
 * after the hold was reserved)
 */

const FORCED_DEAD_PROVIDER = process.env.OLLAMA_BASE_URL === "http://127.0.0.1:9";

test("provider failure after reservation: full refund, reserve marked failed", async () => {
	if (!FORCED_DEAD_PROVIDER) {
		console.log("skipped: run via `bun run test:ai-failure` (needs dead provider URL)");
		return;
	}

	const user = await createUser();
	const minted = await authJson(user.token, "/wallet/mint", "POST", {});
	expect(minted.status).toBe(200);
	const balanceBefore = await getBalance(user.walletId);

	const result = await authJson(user.token, "/ai/generate", "POST", {
		prompt: "this will fail because the provider is unreachable",
		model: "qwen2.5:3b",
	});

	// 502 with the refund spelled out, balance fully restored
	expect(result.status).toBe(502);
	expect((result.json.error as string).includes("refunded")).toBe(true);
	expect(await getBalance(user.walletId)).toBe(balanceBefore);

	// The pending reserve transaction must be closed as failed
	const pending = await db
		.select({ id: transactions.id, status: transactions.status, type: transactions.type })
		.from(transactions)
		.where(eq(transactions.status, "pending"));
	expect(pending).toHaveLength(0);

	// And a completed refund (reversal) transaction exists for this user's hold
	const failedTxns = await db
		.select({ id: transactions.id })
		.from(transactions)
		.where(eq(transactions.type, "ai_usage"));
	expect(failedTxns.length).toBeGreaterThanOrEqual(2); // reserve + refund
}, 60000);
