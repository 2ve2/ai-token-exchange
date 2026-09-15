import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ERROR_MESSAGES } from "@/constants/errors";
import { ESCROW_WALLET_ID, TREASURY_WALLET_ID } from "@/constants/escrow";
import { db } from "@/db";
import { ledgerEntries, transactions } from "@/db/schema";
import { isIdempotencyConflict } from "@/lib/database-errors";
import { addAmounts, compareAmounts, normalizeAmount, parseAmount, subAmounts } from "@/lib/money";
import { lockWallets, mustGetWallet, updateWalletBalance } from "@/lib/tx";
import { transactionService } from "@/services/transactionService";
import { walletService } from "@/services/walletService";

const SYSTEM_WALLET_IDS = new Set([ESCROW_WALLET_ID, TREASURY_WALLET_ID]);

export interface TransferInput {
	recipientWalletId: string;
	amount: string | number;
	idempotencyKey: string;
}

export interface TransferView {
	idempotent_replay: boolean;
	transaction: {
		id: string;
		type: string;
		status: string;
		amount: string;
		idempotency_key: string | null;
		created_at: Date;
	};
	sender: { wallet_id: string; balance_after: string };
	recipient: { wallet_id: string; username: string };
}

export const transferService = {
	/**
	 * Executes a peer-to-peer transfer atomically:
	 * lock both wallets -> verify balance -> transaction row ->
	 * two ledger entries -> update balances (+version bump).
	 */
	async transfer(senderUserId: string, input: TransferInput): Promise<TransferView> {
		const senderWallet = await walletService.getWalletByUserId(senderUserId);
		if (!senderWallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}

		if (input.recipientWalletId === senderWallet.walletId) {
			throw new HTTPException(400, { message: "Cannot transfer to yourself" });
		}

		// System wallets (escrow/treasury) are internal counterparties
		// only — user transfers into them would strand the tokens
		if (SYSTEM_WALLET_IDS.has(input.recipientWalletId)) {
			throw new HTTPException(400, { message: "Cannot transfer to a system wallet" });
		}

		const amount = parseAmount(input.amount);
		if (!amount) {
			throw new HTTPException(400, { message: ERROR_MESSAGES.INVALID_AMOUNT });
		}

		const existing = await transactionService.getTransactionByIdempotencyKey(input.idempotencyKey);
		if (existing) {
			return this.getTransferView(existing.id, true);
		}

		const recipientWallet = await walletService.getWalletByWalletId(input.recipientWalletId);
		if (!recipientWallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}

		try {
			const transactionId = await db.transaction(async (tx) => {
				const locked = await lockWallets(tx, [senderWallet.id, recipientWallet.id]);
				const sender = mustGetWallet(locked, senderWallet.id);
				const recipient = mustGetWallet(locked, recipientWallet.id);

				if (compareAmounts(sender.balance, amount) < 0) {
					throw new HTTPException(400, { message: ERROR_MESSAGES.INSUFFICIENT_BALANCE });
				}

				const senderBalanceAfter = subAmounts(sender.balance, amount);
				const recipientBalanceAfter = addAmounts(recipient.balance, amount);

				const [txn] = await tx
					.insert(transactions)
					.values({
						type: "transfer",
						status: "completed",
						idempotencyKey: input.idempotencyKey,
						metadata: {
							sender_wallet_id: sender.id,
							recipient_wallet_id: recipient.id,
							amount,
						},
					})
					.returning({ id: transactions.id });
				if (!txn) {
					throw new Error("Failed to create transaction");
				}

				await tx.insert(ledgerEntries).values([
					{
						transactionId: txn.id,
						walletId: sender.id,
						direction: "debit",
						amount,
						balanceAfter: senderBalanceAfter,
					},
					{
						transactionId: txn.id,
						walletId: recipient.id,
						direction: "credit",
						amount,
						balanceAfter: recipientBalanceAfter,
					},
				]);

				await updateWalletBalance(tx, sender, senderBalanceAfter);
				await updateWalletBalance(tx, recipient, recipientBalanceAfter);

				return txn.id;
			});

			return await this.getTransferView(transactionId, false);
		} catch (error) {
			if (isIdempotencyConflict(error)) {
				const winner = await transactionService.getTransactionByIdempotencyKey(
					input.idempotencyKey,
				);
				if (winner) {
					return this.getTransferView(winner.id, true);
				}
			}
			throw error;
		}
	},

	/**
	 * Builds the canonical transfer response from the committed ledger.
	 * Shared by fresh transfers and idempotent replays so both are
	 * guaranteed to return the identical shape.
	 */
	async getTransferView(transactionId: string, idempotentReplay: boolean): Promise<TransferView> {
		const txn = await db.query.transactions.findFirst({
			where: eq(transactions.id, transactionId),
			with: {
				ledgerEntries: {
					with: {
						wallet: { with: { user: true } },
					},
				},
			},
		});
		if (!txn) {
			throw new Error("Transaction not found after commit");
		}

		const debit = txn.ledgerEntries.find((entry) => entry.direction === "debit");
		const credit = txn.ledgerEntries.find((entry) => entry.direction === "credit");
		if (!debit || !credit) {
			throw new Error("Ledger entries incomplete for transfer");
		}

		return {
			idempotent_replay: idempotentReplay,
			transaction: {
				id: txn.id,
				type: txn.type,
				status: txn.status,
				amount: normalizeAmount(debit.amount),
				idempotency_key: txn.idempotencyKey,
				created_at: txn.createdAt,
			},
			sender: {
				wallet_id: debit.wallet.walletId,
				balance_after: normalizeAmount(debit.balanceAfter),
			},
			recipient: {
				wallet_id: credit.wallet.walletId,
				username: credit.wallet.user.username,
			},
		};
	},
};
