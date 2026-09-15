import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { ERROR_MESSAGES } from "@/constants/errors";
import { db } from "@/db";
import { type Listing, ledgerEntries, listings, transactions, users } from "@/db/schema";
import { isIdempotencyConflict } from "@/lib/database-errors";
import {
	addAmounts,
	compareAmounts,
	mulAmounts,
	normalizeAmount,
	parseAmount,
	subAmounts,
} from "@/lib/money";
import { lockWallets, mustGetWallet, updateWalletBalance } from "@/lib/tx";
import { transactionService } from "@/services/transactionService";
import { walletService } from "@/services/walletService";

export interface ListingView {
	id: string;
	amount: string;
	price_per_token: string;
	status: string;
	created_at: Date;
}

export interface ListingWithSellerView extends ListingView {
	seller_username: string;
}

export interface PurchaseView {
	idempotent_replay: boolean;
	transaction: { id: string; type: string; status: string; created_at: Date };
	listing: ListingView;
	buyer: { wallet_id: string; balance_after: string };
	seller: { wallet_id: string; username: string };
	payment: string;
	token_amount: string;
}

function toListingView(listing: Listing): ListingView {
	return {
		id: listing.id,
		amount: normalizeAmount(listing.amount),
		price_per_token: normalizeAmount(listing.pricePerToken),
		status: listing.status,
		created_at: listing.createdAt,
	};
}

export const marketplaceService = {
	/**
	 * Creates a listing and escrows the tokens in the same transaction:
	 * seller is debited immediately (escrow_lock), so the tokens can
	 * never be double-spent or double-listed.
	 */
	async createListing(
		sellerUserId: string,
		input: { amount: string | number; pricePerToken: string | number },
	): Promise<{ listing: ListingView; seller_balance_after: string }> {
		const amount = parseAmount(input.amount);
		if (!amount) {
			throw new HTTPException(400, { message: ERROR_MESSAGES.INVALID_AMOUNT });
		}
		const pricePerToken = parseAmount(input.pricePerToken);
		if (!pricePerToken) {
			throw new HTTPException(400, { message: ERROR_MESSAGES.INVALID_PRICE });
		}

		const sellerWallet = await walletService.getWalletByUserId(sellerUserId);
		if (!sellerWallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}
		const escrow = await walletService.getEscrowWallet();

		return db.transaction(async (tx) => {
			const locked = await lockWallets(tx, [sellerWallet.id, escrow.id]);
			const seller = mustGetWallet(locked, sellerWallet.id);
			const esc = mustGetWallet(locked, escrow.id);

			if (compareAmounts(seller.balance, amount) < 0) {
				throw new HTTPException(400, { message: ERROR_MESSAGES.INSUFFICIENT_BALANCE });
			}

			const sellerAfter = subAmounts(seller.balance, amount);
			const escrowAfter = addAmounts(esc.balance, amount);

			const [listing] = await tx
				.insert(listings)
				.values({
					sellerId: sellerUserId,
					amount,
					pricePerToken,
					status: "active",
				})
				.returning();
			if (!listing) {
				throw new Error("Failed to create listing");
			}

			const [txn] = await tx
				.insert(transactions)
				.values({
					type: "escrow_lock",
					status: "completed",
					metadata: {
						listing_id: listing.id,
						seller_wallet_id: seller.id,
						escrow_wallet_id: esc.id,
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
					walletId: seller.id,
					direction: "debit",
					amount,
					balanceAfter: sellerAfter,
				},
				{
					transactionId: txn.id,
					walletId: esc.id,
					direction: "credit",
					amount,
					balanceAfter: escrowAfter,
				},
			]);

			await updateWalletBalance(tx, seller, sellerAfter);
			await updateWalletBalance(tx, esc, escrowAfter);

			return {
				listing: toListingView(listing),
				seller_balance_after: normalizeAmount(sellerAfter),
			};
		});
	},

	/**
	 * Public marketplace feed: active listings, price ascending by
	 * default, paginated with limit/offset.
	 */
	async getListings(query: { limit: number; offset: number }) {
		const rows = await db
			.select({
				id: listings.id,
				amount: listings.amount,
				pricePerToken: listings.pricePerToken,
				status: listings.status,
				createdAt: listings.createdAt,
				sellerUsername: users.username,
			})
			.from(listings)
			.innerJoin(users, eq(listings.sellerId, users.id))
			.where(eq(listings.status, "active"))
			.orderBy(asc(listings.pricePerToken), asc(listings.createdAt))
			.limit(query.limit)
			.offset(query.offset);

		const [countRow] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(listings)
			.where(eq(listings.status, "active"));

		const result: {
			listings: ListingWithSellerView[];
			total: number;
			limit: number;
			offset: number;
		} = {
			listings: rows.map((row) => ({
				id: row.id,
				amount: normalizeAmount(row.amount),
				price_per_token: normalizeAmount(row.pricePerToken),
				status: row.status,
				created_at: row.createdAt,
				seller_username: row.sellerUsername,
			})),
			total: countRow?.count ?? 0,
			limit: query.limit,
			offset: query.offset,
		};
		return result;
	},

	/**
	 * Buys an active listing atomically:
	 * 1. claim the listing (guarded active -> fulfilled update, 0 rows = 409)
	 * 2. lock buyer + seller + escrow wallets (sorted, deadlock-free)
	 * 3. one `purchase` transaction with 4 ledger entries:
	 *    debit buyer payment / credit seller payment /
	 *    debit escrow tokens / credit buyer tokens
	 */
	async buy(
		buyerUserId: string,
		listingId: string,
		idempotencyKey?: string,
	): Promise<PurchaseView> {
		if (idempotencyKey) {
			const existing = await transactionService.getTransactionByIdempotencyKey(idempotencyKey);
			if (existing) {
				return this.getPurchaseView(existing.id, true);
			}
		}

		const listing = await this.getListingById(listingId);
		if (!listing) {
			throw new HTTPException(404, { message: ERROR_MESSAGES.LISTING_NOT_FOUND });
		}
		if (listing.sellerId === buyerUserId) {
			throw new HTTPException(400, { message: ERROR_MESSAGES.CANNOT_BUY_OWN });
		}

		const buyerWallet = await walletService.getWalletByUserId(buyerUserId);
		if (!buyerWallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}
		const sellerWallet = await walletService.getWalletByUserId(listing.sellerId);
		if (!sellerWallet) {
			throw new HTTPException(404, { message: "Seller wallet not found" });
		}
		const escrow = await walletService.getEscrowWallet();

		const tokenAmount = normalizeAmount(listing.amount);
		const payment = mulAmounts(listing.amount, listing.pricePerToken);

		try {
			const transactionId = await db.transaction(async (tx) => {
				const claimed = await tx
					.update(listings)
					.set({ status: "fulfilled" })
					.where(and(eq(listings.id, listing.id), eq(listings.status, "active")))
					.returning({ id: listings.id });
				if (claimed.length === 0) {
					throw new HTTPException(409, { message: ERROR_MESSAGES.LISTING_NOT_AVAILABLE });
				}

				const locked = await lockWallets(tx, [buyerWallet.id, sellerWallet.id, escrow.id]);
				const buyer = mustGetWallet(locked, buyerWallet.id);
				const seller = mustGetWallet(locked, sellerWallet.id);
				const esc = mustGetWallet(locked, escrow.id);

				if (compareAmounts(buyer.balance, payment) < 0) {
					throw new HTTPException(400, { message: ERROR_MESSAGES.INSUFFICIENT_BALANCE });
				}

				const buyerAfterPayment = subAmounts(buyer.balance, payment);
				const buyerAfterTokens = addAmounts(buyerAfterPayment, tokenAmount);
				const sellerAfter = addAmounts(seller.balance, payment);
				const escrowAfter = subAmounts(esc.balance, tokenAmount);

				const [txn] = await tx
					.insert(transactions)
					.values({
						type: "purchase",
						status: "completed",
						idempotencyKey: idempotencyKey ?? null,
						metadata: {
							listing_id: listing.id,
							token_amount: tokenAmount,
							price_per_token: normalizeAmount(listing.pricePerToken),
							payment,
						},
					})
					.returning({ id: transactions.id });
				if (!txn) {
					throw new Error("Failed to create transaction");
				}

				await tx.insert(ledgerEntries).values([
					{
						transactionId: txn.id,
						walletId: buyer.id,
						direction: "debit",
						amount: payment,
						balanceAfter: buyerAfterPayment,
					},
					{
						transactionId: txn.id,
						walletId: seller.id,
						direction: "credit",
						amount: payment,
						balanceAfter: sellerAfter,
					},
					{
						transactionId: txn.id,
						walletId: esc.id,
						direction: "debit",
						amount: tokenAmount,
						balanceAfter: escrowAfter,
					},
					{
						transactionId: txn.id,
						walletId: buyer.id,
						direction: "credit",
						amount: tokenAmount,
						balanceAfter: buyerAfterTokens,
					},
				]);

				await updateWalletBalance(tx, buyer, buyerAfterTokens);
				await updateWalletBalance(tx, seller, sellerAfter);
				await updateWalletBalance(tx, esc, escrowAfter);

				return txn.id;
			});

			return await this.getPurchaseView(transactionId, false);
		} catch (error) {
			if (idempotencyKey && isIdempotencyConflict(error)) {
				const winner = await transactionService.getTransactionByIdempotencyKey(idempotencyKey);
				if (winner) {
					return this.getPurchaseView(winner.id, true);
				}
			}
			throw error;
		}
	},

	/**
	 * Seller-only: cancels an active listing and releases the escrowed
	 * tokens back to the seller's available balance.
	 */
	async cancel(
		sellerUserId: string,
		listingId: string,
	): Promise<{ listing: ListingView; seller_balance_after: string }> {
		const listing = await this.getListingById(listingId);
		if (!listing) {
			throw new HTTPException(404, { message: ERROR_MESSAGES.LISTING_NOT_FOUND });
		}
		if (listing.sellerId !== sellerUserId) {
			throw new HTTPException(403, { message: ERROR_MESSAGES.NOT_OWN_LISTING });
		}
		if (listing.status !== "active") {
			throw new HTTPException(409, { message: ERROR_MESSAGES.LISTING_NOT_AVAILABLE });
		}

		const sellerWallet = await walletService.getWalletByUserId(sellerUserId);
		if (!sellerWallet) {
			throw new HTTPException(404, { message: "Wallet not found" });
		}
		const escrow = await walletService.getEscrowWallet();

		const tokenAmount = normalizeAmount(listing.amount);

		return db.transaction(async (tx) => {
			const claimed = await tx
				.update(listings)
				.set({ status: "cancelled" })
				.where(and(eq(listings.id, listing.id), eq(listings.status, "active")))
				.returning({ id: listings.id });
			if (claimed.length === 0) {
				throw new HTTPException(409, { message: ERROR_MESSAGES.LISTING_NOT_AVAILABLE });
			}

			const locked = await lockWallets(tx, [sellerWallet.id, escrow.id]);
			const seller = mustGetWallet(locked, sellerWallet.id);
			const esc = mustGetWallet(locked, escrow.id);

			const sellerAfter = addAmounts(seller.balance, tokenAmount);
			const escrowAfter = subAmounts(esc.balance, tokenAmount);

			const [txn] = await tx
				.insert(transactions)
				.values({
					type: "escrow_release",
					status: "completed",
					metadata: {
						listing_id: listing.id,
						token_amount: tokenAmount,
					},
				})
				.returning({ id: transactions.id });
			if (!txn) {
				throw new Error("Failed to create transaction");
			}

			await tx.insert(ledgerEntries).values([
				{
					transactionId: txn.id,
					walletId: esc.id,
					direction: "debit",
					amount: tokenAmount,
					balanceAfter: escrowAfter,
				},
				{
					transactionId: txn.id,
					walletId: seller.id,
					direction: "credit",
					amount: tokenAmount,
					balanceAfter: sellerAfter,
				},
			]);

			await updateWalletBalance(tx, seller, sellerAfter);
			await updateWalletBalance(tx, esc, escrowAfter);

			return {
				listing: toListingView({ ...listing, status: "cancelled" }),
				seller_balance_after: normalizeAmount(sellerAfter),
			};
		});
	},

	async getListingById(id: string): Promise<Listing | null> {
		const [listing] = await db.select().from(listings).where(eq(listings.id, id)).limit(1);
		return listing ?? null;
	},

	/**
	 * Reconstructs the purchase response purely from the committed
	 * ledger. The buyer is the only wallet holding BOTH a debit and a
	 * credit in the transaction; the seller is the other credit, the
	 * escrow wallet the other debit.
	 */
	async getPurchaseView(transactionId: string, idempotentReplay: boolean): Promise<PurchaseView> {
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

		const debitIds = new Set(
			txn.ledgerEntries.filter((e) => e.direction === "debit").map((e) => e.wallet.id),
		);
		const creditEntries = txn.ledgerEntries.filter((e) => e.direction === "credit");
		const buyerId = creditEntries.find((e) => debitIds.has(e.wallet.id))?.wallet.id;
		if (!buyerId) {
			throw new Error("Ledger entries incomplete for purchase");
		}

		const buyerDebit = txn.ledgerEntries.find(
			(e) => e.direction === "debit" && e.wallet.id === buyerId,
		);
		const buyerCredit = creditEntries.find((e) => e.wallet.id === buyerId);
		const sellerCredit = creditEntries.find((e) => e.wallet.id !== buyerId);
		if (!buyerDebit || !buyerCredit || !sellerCredit) {
			throw new Error("Ledger entries incomplete for purchase");
		}

		const listingId = txn.metadata?.listing_id;
		let listingView: ListingView | null = null;
		if (typeof listingId === "string") {
			const listing = await this.getListingById(listingId);
			if (listing) {
				listingView = toListingView(listing);
			}
		}
		if (!listingView) {
			throw new Error("Listing missing for purchase view");
		}

		return {
			idempotent_replay: idempotentReplay,
			transaction: {
				id: txn.id,
				type: txn.type,
				status: txn.status,
				created_at: txn.createdAt,
			},
			listing: listingView,
			buyer: {
				wallet_id: buyerCredit.wallet.walletId,
				balance_after: normalizeAmount(buyerCredit.balanceAfter),
			},
			seller: {
				wallet_id: sellerCredit.wallet.walletId,
				username: sellerCredit.wallet.user.username,
			},
			payment: normalizeAmount(buyerDebit.amount),
			token_amount: normalizeAmount(buyerCredit.amount),
		};
	},
};
