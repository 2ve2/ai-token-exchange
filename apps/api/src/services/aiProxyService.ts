import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { env } from "@/config/env";
import {
	availableModels,
	MODEL_PRICES,
	NUM_PREDICT_CAP,
	PROMPT_BUFFER_TOKENS,
	PROVIDER_TIMEOUT_MS,
} from "@/constants/ai-pricing";
import { ERROR_MESSAGES } from "@/constants/errors";
import { db } from "@/db";
import { aiUsageLogs, ledgerEntries, transactions } from "@/db/schema";
import {
	addAmounts,
	compareAmounts,
	fromScaled,
	normalizeAmount,
	subAmounts,
	toScaled,
} from "@/lib/money";
import { lockWallets, mustGetWallet, updateWalletBalance } from "@/lib/tx";
import { walletService } from "@/services/walletService";

/** Exact cost for a token count at a per-1k price (floored to 8 decimals). */
function costForTokens(pricePer1k: string, tokens: number): string {
	const safeTokens = Math.max(0, Math.trunc(tokens));
	return fromScaled((toScaled(pricePer1k) * BigInt(safeTokens)) / 1000n);
}

interface ProviderGeneration {
	text: string;
	promptTokens: number;
	completionTokens: number;
}

async function callProvider(model: string, prompt: string): Promise<ProviderGeneration> {
	const res = await fetch(`${env.OLLAMA_BASE_URL}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			prompt,
			stream: false,
			options: { num_predict: NUM_PREDICT_CAP },
		}),
		signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Ollama returned HTTP ${res.status}`);
	}
	const data = (await res.json()) as {
		response?: unknown;
		done?: boolean;
		prompt_eval_count?: number;
		eval_count?: number;
	};
	if (!data.done) {
		throw new Error("Ollama returned an incomplete generation");
	}
	return {
		text: String(data.response ?? ""),
		promptTokens: Number(data.prompt_eval_count ?? 0),
		completionTokens: Number(data.eval_count ?? 0),
	};
}

export interface GenerateView {
	request_id: string;
	model: string;
	response: string;
	tokens: { prompt: number; completion: number; total: number };
	billing: {
		hold: string;
		cost: string;
		refunded: string;
		clamped: boolean;
		balance_after: string;
	};
	transaction: { id: string; type: string; status: string };
}

/**
 * Net cost per generation: the user's debits minus credits across the
 * reserve transaction and any settlement/refund reversals linked to it
 * via metadata.generation_transaction_id. (The reserve's debit alone is
 * the hold, not the final cost.)
 */
async function resolveNetCosts(
	userWalletRowId: string,
	reserveIds: string[],
): Promise<Map<string, string>> {
	const reversalRows = await db
		.select({
			id: transactions.id,
			parentId: sql<string>`${transactions.metadata}->>'generation_transaction_id'`,
		})
		.from(transactions)
		.where(
			and(
				eq(transactions.type, "ai_usage"),
				inArray(sql`${transactions.metadata}->>'generation_transaction_id'`, reserveIds),
			),
		);

	const allTxnIds = [...reserveIds, ...reversalRows.map((r) => r.id)];
	const entryRows = await db
		.select({
			transactionId: ledgerEntries.transactionId,
			direction: ledgerEntries.direction,
			amount: ledgerEntries.amount,
		})
		.from(ledgerEntries)
		.where(
			and(
				inArray(ledgerEntries.transactionId, allTxnIds),
				eq(ledgerEntries.walletId, userWalletRowId),
			),
		);

	const netUnits = new Map<string, bigint>();
	for (const entry of entryRows) {
		const delta = entry.direction === "debit" ? toScaled(entry.amount) : -toScaled(entry.amount);
		netUnits.set(entry.transactionId, (netUnits.get(entry.transactionId) ?? 0n) + delta);
	}
	// Fold each reversal's net into its parent generation
	for (const reversal of reversalRows) {
		const folded = netUnits.get(reversal.id) ?? 0n;
		netUnits.set(reversal.parentId, (netUnits.get(reversal.parentId) ?? 0n) + folded);
	}

	const costs = new Map<string, string>();
	for (const reserveId of reserveIds) {
		costs.set(reserveId, fromScaled(netUnits.get(reserveId) ?? 0n));
	}
	return costs;
}

export const aiProxyService = {
	/**
	 * Reserve -> generate -> settle.
	 *
	 * 1. Reserve a generous hold (pending ai_usage txn, debit user /
	 *    credit treasury) under lock — 402 BEFORE any provider call if
	 *    the balance can't cover it.
	 * 2. Call Ollama and meter actual tokens (prompt_eval + eval).
	 * 3. Settle: refund the unused hold with a reversing entry and mark
	 *    the reserve completed. If cost exceeds the hold (pathological
	 *    tokenization), the charge is clamped to the hold.
	 * 4. On provider failure: full reversing refund, reserve -> failed.
	 */
	async generate(userId: string, input: { prompt: string; model: string }): Promise<GenerateView> {
		const price = MODEL_PRICES[input.model];
		if (!price) {
			throw new HTTPException(400, {
				message: `Model '${input.model}' is not available. Available models: ${availableModels().join(", ")}`,
			});
		}

		const wallet = await walletService.getWalletByUserId(userId);
		if (!wallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}
		const treasury = await walletService.getTreasuryWallet();

		// Generous hold: output cap + prompt chars (>= tokens for any
		// tokenizer we use) + buffer. Unused portion is refunded.
		const holdTokens = NUM_PREDICT_CAP + input.prompt.length + PROMPT_BUFFER_TOKENS;
		const hold = costForTokens(price, holdTokens);
		const requestId = crypto.randomUUID();

		// --- 1) Reserve ---
		const reserveTxnId = await db.transaction(async (tx) => {
			const locked = await lockWallets(tx, [wallet.id, treasury.id]);
			const user = mustGetWallet(locked, wallet.id);
			const source = mustGetWallet(locked, treasury.id);

			if (compareAmounts(user.balance, hold) < 0) {
				throw new HTTPException(402, { message: ERROR_MESSAGES.INSUFFICIENT_BALANCE });
			}

			const userAfter = subAmounts(user.balance, hold);
			const treasuryAfter = addAmounts(source.balance, hold);

			const [txn] = await tx
				.insert(transactions)
				.values({
					type: "ai_usage",
					status: "pending",
					metadata: {
						kind: "reserve",
						request_id: requestId,
						model: input.model,
						hold,
						hold_tokens: holdTokens,
					},
				})
				.returning({ id: transactions.id });
			if (!txn) {
				throw new Error("Failed to create reservation");
			}

			await tx.insert(ledgerEntries).values([
				{
					transactionId: txn.id,
					walletId: user.id,
					direction: "debit",
					amount: hold,
					balanceAfter: userAfter,
				},
				{
					transactionId: txn.id,
					walletId: source.id,
					direction: "credit",
					amount: hold,
					balanceAfter: treasuryAfter,
				},
			]);

			await updateWalletBalance(tx, user, userAfter);
			await updateWalletBalance(tx, source, treasuryAfter);

			return txn.id;
		});

		// --- 2) Generate ---
		let generation: ProviderGeneration;
		try {
			generation = await callProvider(input.model, input.prompt);
		} catch (error) {
			console.error("AI provider failure:", error);
			const balanceAfter = await this.reverseHold(
				reserveTxnId,
				wallet.id,
				treasury.id,
				hold,
				"refund",
				requestId,
			);
			throw new HTTPException(502, {
				message: `AI provider failed — your reserved ${normalizeAmount(hold)} credits were refunded (balance: ${balanceAfter})`,
			});
		}

		// --- 3) Settle ---
		const tokensTotal = generation.promptTokens + generation.completionTokens;
		let cost = costForTokens(price, tokensTotal);
		let clamped = false;
		if (compareAmounts(cost, hold) > 0) {
			cost = hold;
			clamped = true;
		}
		const refund = subAmounts(hold, cost);

		const balanceAfter = await db.transaction(async (tx) => {
			let finalBalance: string | null = null;

			// Reverse the unused hold (skip zero-amount entries: the
			// ledger CHECK constraint requires amount > 0)
			if (compareAmounts(refund, "0.00000000") > 0) {
				const locked = await lockWallets(tx, [wallet.id, treasury.id]);
				const user = mustGetWallet(locked, wallet.id);
				const source = mustGetWallet(locked, treasury.id);

				const userAfter = addAmounts(user.balance, refund);
				const treasuryAfter = subAmounts(source.balance, refund);

				const [txn] = await tx
					.insert(transactions)
					.values({
						type: "ai_usage",
						status: "completed",
						metadata: {
							kind: "settlement",
							generation_transaction_id: reserveTxnId,
							request_id: requestId,
							cost,
							refund,
						},
					})
					.returning({ id: transactions.id });
				if (!txn) {
					throw new Error("Failed to create settlement");
				}

				await tx.insert(ledgerEntries).values([
					{
						transactionId: txn.id,
						walletId: source.id,
						direction: "debit",
						amount: refund,
						balanceAfter: treasuryAfter,
					},
					{
						transactionId: txn.id,
						walletId: user.id,
						direction: "credit",
						amount: refund,
						balanceAfter: userAfter,
					},
				]);

				await updateWalletBalance(tx, user, userAfter);
				await updateWalletBalance(tx, source, treasuryAfter);
				finalBalance = userAfter;
			}

			const marked = await tx
				.update(transactions)
				.set({ status: "completed" })
				.where(and(eq(transactions.id, reserveTxnId), eq(transactions.status, "pending")))
				.returning({ id: transactions.id });
			if (marked.length === 0) {
				throw new Error("Reservation already settled");
			}

			await tx.insert(aiUsageLogs).values({
				userId,
				transactionId: reserveTxnId,
				model: input.model,
				tokensUsed: tokensTotal,
				requestId,
			});

			if (finalBalance === null) {
				const current = await walletService.getWalletByUserId(userId);
				finalBalance = current?.balance ?? "0";
			}
			return normalizeAmount(finalBalance);
		});

		return {
			request_id: requestId,
			model: input.model,
			response: generation.text,
			tokens: {
				prompt: generation.promptTokens,
				completion: generation.completionTokens,
				total: tokensTotal,
			},
			billing: {
				hold: normalizeAmount(hold),
				cost: normalizeAmount(cost),
				refunded: normalizeAmount(refund),
				clamped,
				balance_after: balanceAfter,
			},
			transaction: { id: reserveTxnId, type: "ai_usage", status: "completed" },
		};
	},

	/**
	 * Reverses a hold back to the user (settlement refunds and full
	 * failure refunds) and closes the reserve transaction.
	 */
	async reverseHold(
		reserveTxnId: string,
		userWalletRowId: string,
		treasuryRowId: string,
		amount: string,
		kind: "settlement" | "refund",
		requestId: string,
	): Promise<string> {
		return db.transaction(async (tx) => {
			const locked = await lockWallets(tx, [userWalletRowId, treasuryRowId]);
			const user = mustGetWallet(locked, userWalletRowId);
			const source = mustGetWallet(locked, treasuryRowId);

			const userAfter = addAmounts(user.balance, amount);
			const treasuryAfter = subAmounts(source.balance, amount);

			const [txn] = await tx
				.insert(transactions)
				.values({
					type: "ai_usage",
					status: "completed",
					metadata: {
						kind,
						generation_transaction_id: reserveTxnId,
						request_id: requestId,
						amount,
					},
				})
				.returning({ id: transactions.id });
			if (!txn) {
				throw new Error("Failed to create reversal");
			}

			await tx.insert(ledgerEntries).values([
				{
					transactionId: txn.id,
					walletId: source.id,
					direction: "debit",
					amount,
					balanceAfter: treasuryAfter,
				},
				{
					transactionId: txn.id,
					walletId: user.id,
					direction: "credit",
					amount,
					balanceAfter: userAfter,
				},
			]);

			await updateWalletBalance(tx, user, userAfter);
			await updateWalletBalance(tx, source, treasuryAfter);

			const nextStatus = kind === "refund" ? "failed" : "completed";
			await tx
				.update(transactions)
				.set({ status: nextStatus })
				.where(eq(transactions.id, reserveTxnId));

			return normalizeAmount(userAfter);
		});
	},

	/**
	 * Paginated AI usage history for the authenticated user with the
	 * actual charged cost (the user-side debit entry of each bill).
	 */
	async getUsage(
		userId: string,
		query: { limit: number; offset: number },
	): Promise<{
		usage: {
			id: string;
			model: string;
			tokens_used: number;
			cost: string;
			status: string;
			request_id: string | null;
			created_at: Date;
		}[];
		total: number;
		limit: number;
		offset: number;
	}> {
		const wallet = await walletService.getWalletByUserId(userId);

		const rows = await db
			.select({
				id: aiUsageLogs.id,
				model: aiUsageLogs.model,
				tokensUsed: aiUsageLogs.tokensUsed,
				requestId: aiUsageLogs.requestId,
				createdAt: aiUsageLogs.createdAt,
				txnStatus: transactions.status,
				txnId: transactions.id,
			})
			.from(aiUsageLogs)
			.innerJoin(transactions, eq(aiUsageLogs.transactionId, transactions.id))
			.where(eq(aiUsageLogs.userId, userId))
			.orderBy(desc(aiUsageLogs.createdAt))
			.limit(query.limit)
			.offset(query.offset);

		const [countRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(aiUsageLogs)
			.where(eq(aiUsageLogs.userId, userId));

		// Net cost per generation = user's debits minus credits across the
		// reserve txn AND any settlement/refund reversals linked to it via
		// metadata.generation_transaction_id (the reserve's debit alone is
		// the hold, not the final cost)
		const costByTxn =
			wallet && rows.length > 0
				? await resolveNetCosts(
						wallet.id,
						rows.map((r) => r.txnId),
					)
				: new Map<string, string>();

		return {
			usage: rows.map((row) => ({
				id: row.id,
				model: row.model,
				tokens_used: row.tokensUsed,
				cost: costByTxn.get(row.txnId) ?? "0.00000000",
				status: row.txnStatus,
				request_id: row.requestId,
				created_at: row.createdAt,
			})),
			total: countRow?.count ?? 0,
			limit: query.limit,
			offset: query.offset,
		};
	},
};
