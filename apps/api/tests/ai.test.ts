import { expect, test } from "bun:test";
import { db } from "../src/db";
import { transactions } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { authJson, createUser, fund, getBalance, unique } from "./helpers";

async function ollamaAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

const MODEL = process.env.TEST_AI_MODEL ?? "qwen2.5:3b";

test("mint credits the wallet from the treasury", async () => {
	const user = await createUser();

	const minted = await authJson(user.token, "/wallet/mint", "POST", {});
	expect(minted.status).toBe(200);
	const result = minted.json.result as {
		amount: string;
		balance_after: string;
		transaction: { type: string; status: string };
	};
	expect(result.amount).toBe("100.00000000");
	expect(result.balance_after).toBe("100.00000000");
	expect(result.transaction.type).toBe("mint");
	expect(await getBalance(user.walletId)).toBe("100.00000000");

	const custom = await authJson(user.token, "/wallet/mint", "POST", { amount: 5.5 });
	expect(custom.status).toBe(200);
	expect(await getBalance(user.walletId)).toBe("105.50000000");

	const tooMuch = await authJson(user.token, "/wallet/mint", "POST", { amount: 99999 });
	expect(tooMuch.status).toBe(400);
}, 30000);

test("generate: insufficient balance is rejected with 402 before any provider call", async () => {
	const user = await createUser(); // balance 0

	const result = await authJson(user.token, "/ai/generate", "POST", {
		prompt: "hello",
		model: MODEL,
	});
	expect(result.status).toBe(402);
	expect(result.json.error).toBe("Insufficient balance");
	expect(await getBalance(user.walletId)).toBe("0.00000000");
}, 30000);

test("generate: unknown model is rejected", async () => {
	const user = await createUser();
	await authJson(user.token, "/wallet/mint", "POST", {});

	const result = await authJson(user.token, "/ai/generate", "POST", {
		prompt: "hello",
		model: "gpt-99",
	});
	expect(result.status).toBe(400);
	expect(String(result.json.error)).toContain("not available");
}, 30000);

test("generate: metered tokens, exact settle, usage log", async () => {
	if (!(await ollamaAvailable())) {
		throw new Error("Ollama is not reachable — start it to run this test");
	}

	const user = await createUser();
	await authJson(user.token, "/wallet/mint", "POST", {});
	const balanceBefore = await getBalance(user.walletId);

	const result = await authJson(user.token, "/ai/generate", "POST", {
		prompt: "Reply with exactly one word: blue",
		model: MODEL,
	});
	expect(result.status).toBe(200);

	const view = result.json.result as {
		request_id: string;
		response: string;
		tokens: { prompt: number; completion: number; total: number };
		billing: { hold: string; cost: string; refunded: string; balance_after: string };
		transaction: { id: string; status: string };
	};

	expect(view.tokens.total).toBeGreaterThan(0);
	expect(view.tokens.prompt + view.tokens.completion).toBe(view.tokens.total);
	expect(typeof view.response).toBe("string");
	expect(view.transaction.status).toBe("completed");

	// hold > cost for a short prompt: partial refund happened
	expect(view.billing.refunded).not.toBe("0.00000000");

	// Final balance = before - cost exactly
	const balanceAfter = await getBalance(user.walletId);
	expect(balanceAfter).toBe(view.billing.balance_after);
	const expected = balanceBefore.replace(".", "");
	const actual = balanceAfter.replace(".", "");
	expect(BigInt(expected) - BigInt(actual)).toBe(
		BigInt(view.billing.cost.replace(".", "")),
	);

	// Reserve transaction completed + usage log written
	const txn = await db.query.transactions.findFirst({
		where: eq(transactions.id, view.transaction.id),
	});
	expect(txn?.status).toBe("completed");

	const usage = await authJson(user.token, "/ai/usage?limit=10", "GET");
	expect(usage.status).toBe(200);
	const usageResult = usage.json.result as {
		usage: { model: string; tokens_used: number; cost: string; request_id: string | null }[];
		total: number;
	};
	expect(usageResult.total).toBeGreaterThanOrEqual(1);
	const entry = usageResult.usage.find((u) => u.request_id === view.request_id);
	expect(entry?.model).toBe(MODEL);
	expect(entry?.tokens_used).toBe(view.tokens.total);
	expect(entry?.cost).toBe(view.billing.cost);
}, 120000);
