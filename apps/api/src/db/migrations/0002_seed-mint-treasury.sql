INSERT INTO "users" ("id", "email", "username", "password_hash")
VALUES ('f0000000-0000-4000-8000-000000000003', 'system.treasury@internal.local', 'system_treasury', '!unloginable')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "wallets" ("id", "wallet_id", "user_id", "balance", "version")
VALUES ('f0000000-0000-4000-8000-000000000004', 'MINT0000', 'f0000000-0000-4000-8000-000000000003', '1000000000', 0)
ON CONFLICT DO NOTHING;
