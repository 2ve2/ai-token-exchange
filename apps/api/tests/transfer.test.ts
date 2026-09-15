import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { db } from "../src/db";
import { transactions } from "../src/db/schema";
import { normalizeAmount } from "../src/lib/money";
import { app } from "../src/app";
import { createUser, fund, getBalance, unique } from "./helpers";

async function transfer(token: string, body: Record<string, unknown>) {
	const res = await app.request("/transfer", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("self-transfer is rejected", async () => {
	const user = await createUser();
	const result = await transfer(user.token, {
		recipient_wallet_id: user.walletId,
		amount: 1,
		idempotency_key: `self-${unique()}`,
	});
	expect(result.status).toBe(400);
	expect(result.json.error).toBe("Cannot transfer to yourself");
}, 30000);

test("transfer to a system wallet is rejected", async () => {
	const user = await createUser();
	await fund(user.walletId, "10.00000000");
	for (const systemId of ["ESCROW00", "MINT0000"]) {
		const result = await transfer(user.token, {
			recipient_wallet_id: systemId,
			amount: 1,
			idempotency_key: `sys-${systemId}-${unique()}`,
		});
		expect(result.status).toBe(400);
		expect(result.json.error).toBe("Cannot transfer to a system wallet");
	}
	expect(await getBalance(user.walletId)).toBe("10.00000000");
}, 30000);

test("idempotent replay returns the original transaction result", async () => {
	const sender = await createUser();
	const recipient = await createUser();
	await fund(sender.walletId, "10.00000000");
	const key = `replay-${unique()}`;

	const first = await transfer(sender.token, {
		recipient_wallet_id: recipient.walletId,
		amount: 3.5,
		idempotency_key: key,
	});
	expect(first.status).toBe(200);
	expect(first.json.message).toBe("Transfer successful");

	const balanceAfterFirst = await getBalance(sender.walletId);

	const second = await transfer(sender.token, {
		recipient_wallet_id: recipient.walletId,
		amount: 3.5,
		idempotency_key: key,
	});
	expect(second.status).toBe(200);

	const firstResult = first.json.result as { idempotent_replay: boolean; transaction: { id: string } };
	const secondResult = second.json.result as {
		idempotent_replay: boolean;
		transaction: { id: string };
	};

	expect(secondResult.idempotent_replay).toBe(true);
	expect(firstResult.idempotent_replay).toBe(false);
	expect(secondResult.transaction.id).toBe(firstResult.transaction.id);
	expect(await getBalance(sender.walletId)).toBe(balanceAfterFirst);
}, 30000);

test("two concurrent transfers exceeding balance: exactly one succeeds", async () => {
	const sender = await createUser();
	const recipientA = await createUser();
	const recipientB = await createUser();
	await fund(sender.walletId, "100.00000000");

	const [resA, resB] = await Promise.all([
		transfer(sender.token, {
			recipient_wallet_id: recipientA.walletId,
			amount: 60,
			idempotency_key: `conc-${unique()}-a`,
		}),
		transfer(sender.token, {
			recipient_wallet_id: recipientB.walletId,
			amount: 60,
			idempotency_key: `conc-${unique()}-b`,
		}),
	]);

	const statuses = [resA.status, resB.status].sort();
	expect(statuses).toEqual([200, 400]);

	const winner = resA.status === 200 ? resA : resB;
	const loser = resA.status === 200 ? resB : resA;

	const loserResult = loser.json as { error?: string };
	expect(loserResult.error).toBe("Insufficient balance");

	const winnerResult = winner.json.result as {
		transaction: { id: string; status: string; amount: string };
		sender: { balance_after: string };
	};
	expect(winnerResult.transaction.status).toBe("completed");
	expect(winnerResult.transaction.amount).toBe("60.00000000");

	const senderBalance = await getBalance(sender.walletId);
	expect(senderBalance).toBe("40.00000000");

	const recipientABalance = await getBalance(recipientA.walletId);
	const recipientBBalance = await getBalance(recipientB.walletId);
	expect([recipientABalance, recipientBBalance].sort()).toEqual(["0.00000000", "60.00000000"]);

	const winnerTxn = await db.query.transactions.findFirst({
		where: eq(transactions.id, winnerResult.transaction.id),
		with: { ledgerEntries: true },
	});
	expect(winnerTxn?.ledgerEntries).toHaveLength(2);

	const debit = winnerTxn?.ledgerEntries.find((e) => e.direction === "debit");
	const credit = winnerTxn?.ledgerEntries.find((e) => e.direction === "credit");
	expect(debit).toBeDefined();
	expect(credit).toBeDefined();
	expect(normalizeAmount(debit?.balanceAfter ?? "0")).toBe("40.00000000");
	expect(normalizeAmount(credit?.balanceAfter ?? "0")).toBe("60.00000000");
	expect(normalizeAmount(debit?.amount ?? "0")).toBe("60.00000000");

	for (const balance of [senderBalance, recipientABalance, recipientBBalance]) {
		expect(BigInt(balance.replace(".", "")) >= 0n).toBe(true);
	}
}, 60000);
