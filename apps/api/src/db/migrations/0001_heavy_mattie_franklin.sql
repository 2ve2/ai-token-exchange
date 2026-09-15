ALTER TYPE "public"."transaction_type" ADD VALUE 'escrow_lock';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE 'escrow_release';--> statement-breakpoint
INSERT INTO "users" ("id", "email", "username", "password_hash")
VALUES ('f0000000-0000-4000-8000-000000000001', 'system.escrow@internal.local', 'system_escrow', '!unloginable')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "wallets" ("id", "wallet_id", "user_id", "balance", "version")
VALUES ('f0000000-0000-4000-8000-000000000002', 'ESCROW00', 'f0000000-0000-4000-8000-000000000001', '0', 0)
ON CONFLICT DO NOTHING;