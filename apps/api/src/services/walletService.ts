import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_MINT_AMOUNT, MAX_MINT_AMOUNT } from "@/constants/ai-pricing";
import { ERROR_MESSAGES } from "@/constants/errors";
import { ESCROW_WALLET_ID, TREASURY_WALLET_ID } from "@/constants/escrow";
import { db } from "@/db";
import { ledgerEntries, transactions, type Wallet, wallets } from "@/db/schema";
import { addAmounts, compareAmounts, normalizeAmount, parseAmount, subAmounts } from "@/lib/money";
import { lockWallets, mustGetWallet, updateWalletBalance } from "@/lib/tx";

export const walletService = {
	async getWalletByUserId(userId: string): Promise<Wallet | null> {
		const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
		return wallet ?? null;
	},

	async getWalletByWalletId(walletId: string): Promise<Wallet | null> {
		const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
		return wallet ?? null;
	},

	/**
	 * The system escrow wallet (ESCROW00, seeded by migration).
	 * Holds tokens locked in active marketplace listings.
	 */
	async getEscrowWallet(): Promise<Wallet> {
		const wallet = await this.getWalletByWalletId(ESCROW_WALLET_ID);
		if (!wallet) {
			throw new Error("Escrow wallet is not seeded — run migrations");
		}
		return wallet;
	},

	/**
	 * The system treasury wallet (MINT0000, seeded by migration with
	 * 1,000,000,000 credits). Counterparty for mint and AI billing holds.
	 */
	async getTreasuryWallet(): Promise<Wallet> {
		const wallet = await this.getWalletByWalletId(TREASURY_WALLET_ID);
		if (!wallet) {
			throw new Error("Treasury wallet is not seeded — run migrations");
		}
		return wallet;
	},

	/**
	 * Demo top-up: credits the caller's wallet from the system treasury
	 * using the standard double-entry ledger pattern (type: mint).
	 */
	async mintToWallet(
		userId: string,
		amountInput?: string | number,
	): Promise<{
		transaction: { id: string; type: string; status: string };
		amount: string;
		balance_after: string;
	}> {
		const amount = parseAmount(amountInput ?? DEFAULT_MINT_AMOUNT);
		if (!amount) {
			throw new HTTPException(400, { message: ERROR_MESSAGES.INVALID_AMOUNT });
		}
		if (compareAmounts(amount, MAX_MINT_AMOUNT) > 0) {
			throw new HTTPException(400, {
				message: `Mint amount exceeds the demo limit of ${normalizeAmount(MAX_MINT_AMOUNT)}`,
			});
		}

		const wallet = await this.getWalletByUserId(userId);
		if (!wallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}
		const treasury = await this.getTreasuryWallet();

		return db.transaction(async (tx) => {
			const locked = await lockWallets(tx, [wallet.id, treasury.id]);
			const user = mustGetWallet(locked, wallet.id);
			const source = mustGetWallet(locked, treasury.id);

			const userAfter = addAmounts(user.balance, amount);
			const treasuryAfter = subAmounts(source.balance, amount);

			const [txn] = await tx
				.insert(transactions)
				.values({
					type: "mint",
					status: "completed",
					metadata: {
						recipient_wallet_id: user.id,
						treasury_wallet_id: source.id,
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

			return {
				transaction: { id: txn.id, type: "mint", status: "completed" },
				amount,
				balance_after: normalizeAmount(userAfter),
			};
		});
	},

	/**
	 * Read-only lookup used by the send-flow confirmation screen:
	 * resolves a shareable wallet_id to the owner's display username.
	 */
	async getWalletOwnerByWalletId(
		walletId: string,
	): Promise<{ wallet_id: string; username: string } | null> {
		const wallet = await db.query.wallets.findFirst({
			where: eq(wallets.walletId, walletId),
			columns: { walletId: true },
			with: { user: { columns: { username: true } } },
		});
		if (!wallet) {
			return null;
		}
		return { wallet_id: wallet.walletId, username: wallet.user.username };
	},
};
