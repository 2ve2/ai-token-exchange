/**
 * Marketplace escrow: a single system-owned wallet that holds tokens
 * locked in active listings. Seeded by migration with fixed UUIDs
 * and an unusable password hash so the system user can never log in.
 */
export const SYSTEM_ESCROW_USER_ID = "f0000000-0000-4000-8000-000000000001";
export const SYSTEM_ESCROW_WALLET_ROW_ID = "f0000000-0000-4000-8000-000000000002";
export const ESCROW_WALLET_ID = "ESCROW00";

/**
 * System treasury: the counterparty for mint (demo top-ups) and AI
 * billing holds. Seeded with 1,000,000,000 credits; its balance
 * decreases as users mint, so demo accounting stays double-entry.
 */
export const SYSTEM_TREASURY_USER_ID = "f0000000-0000-4000-8000-000000000003";
export const SYSTEM_TREASURY_WALLET_ROW_ID = "f0000000-0000-4000-8000-000000000004";
export const TREASURY_WALLET_ID = "MINT0000";
