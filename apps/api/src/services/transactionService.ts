import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type Transaction, transactions } from "@/db/schema";

export const transactionService = {
	async getTransactionByIdempotencyKey(key: string): Promise<Transaction | null> {
		const [txn] = await db
			.select()
			.from(transactions)
			.where(eq(transactions.idempotencyKey, key))
			.limit(1);
		return txn ?? null;
	},
};
