import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { db } from "@/db";
import { type Wallet, wallets } from "@/db/schema";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockWallet(tx: Tx, walletRowId: string): Promise<Wallet> {
	const [row] = await tx.select().from(wallets).where(eq(wallets.id, walletRowId)).for("update");
	if (!row) {
		throw new HTTPException(404, { message: "Wallet not found" });
	}
	return row;
}

/**
 * Locks multiple wallets with SELECT ... FOR UPDATE in globally sorted
 * row-id order so every flow (transfer, escrow lock, purchase, release)
 * acquires locks in the same order — deadlock-free by construction.
 */
export async function lockWallets(tx: Tx, walletRowIds: string[]): Promise<Map<string, Wallet>> {
	const map = new Map<string, Wallet>();
	for (const id of [...new Set(walletRowIds)].sort()) {
		map.set(id, await lockWallet(tx, id));
	}
	return map;
}

export function mustGetWallet(locked: Map<string, Wallet>, walletRowId: string): Wallet {
	const wallet = locked.get(walletRowId);
	if (!wallet) {
		throw new Error("Wallet missing from lock set");
	}
	return wallet;
}

/**
 * Writes the new balance and bumps the optimistic-locking version.
 * Under FOR UPDATE this always matches; a zero-row update means a
 * concurrency anomaly and aborts the transaction.
 */
export async function updateWalletBalance(
	tx: Tx,
	wallet: Wallet,
	nextBalance: string,
): Promise<void> {
	const rows = await tx
		.update(wallets)
		.set({ balance: nextBalance, version: wallet.version + 1 })
		.where(and(eq(wallets.id, wallet.id), eq(wallets.version, wallet.version)))
		.returning({ id: wallets.id });
	if (rows.length === 0) {
		throw new Error("Concurrent wallet modification detected");
	}
}
