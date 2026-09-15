import { z } from "zod";

export const RegisterSchema = z.object({
	email: z.email("A valid email is required"),
	username: z
		.string()
		.min(3, "Username must be at least 3 characters")
		.max(30, "Username must be at most 30 characters")
		.regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
	password: z
		.string()
		.min(8, "Password must be at least 8 characters")
		.max(100, "Password must be at most 100 characters"),
});

export const LoginSchema = z.object({
	email: z.email("A valid email is required"),
	password: z.string().min(1, "Password is required"),
});

export const TransferSchema = z.object({
	recipient_wallet_id: z
		.string()
		.trim()
		.min(1, "recipient_wallet_id is required")
		.max(64, "recipient_wallet_id is too long"),
	amount: z.union([z.number(), z.string()], {
		error: "Amount must be a number or numeric string",
	}),
	idempotency_key: z
		.string()
		.trim()
		.min(1, "idempotency_key is required")
		.max(100, "idempotency_key is too long"),
});

export const ListingCreateSchema = z.object({
	amount: z.union([z.number(), z.string()], {
		error: "Amount must be a number or numeric string",
	}),
	price_per_token: z.union([z.number(), z.string()], {
		error: "Price per token must be a number or numeric string",
	}),
});

export const BuyListingSchema = z.object({
	idempotency_key: z
		.string()
		.trim()
		.min(1, "idempotency_key is required when provided")
		.max(100, "idempotency_key is too long")
		.optional(),
});

export const MintSchema = z.object({
	amount: z
		.union([z.number(), z.string()], {
			error: "Amount must be a number or numeric string",
		})
		.optional(),
});

export const GenerateSchema = z.object({
	prompt: z.string().trim().min(1, "Prompt is required").max(8000, "Prompt is too long"),
	model: z.string().trim().min(1, "Model is required"),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
