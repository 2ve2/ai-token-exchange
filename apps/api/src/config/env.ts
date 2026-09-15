import { z } from "zod";

const envSchema = z.object({
	DATABASE_URL: z.string().url(),
	PORT: z.coerce.number().int().positive().default(3000),
	JWT_SECRET: z.string().min(32, "JWT secret must be at least 32 characters"),
	OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
});

export const env = envSchema.parse(process.env);
