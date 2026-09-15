/**
 * Database error handling utilities
 * Provides type-safe error handling for database operations
 */

export class DatabaseError extends Error {
	constructor(
		message: string,
		public code: string,
		public constraint?: string,
		public detail?: string,
	) {
		super(message);
		this.name = "DatabaseError";
	}
}

export enum DatabaseErrorCode {
	UNIQUE_VIOLATION = "23505",
	FOREIGN_KEY_VIOLATION = "23503",
	NOT_NULL_VIOLATION = "23502",
	CHECK_VIOLATION = "23514",
	CONNECTION_ERROR = "08000",
	INVALID_CATALOG_NAME = "3D000",
}

/**
 * Walks the error cause chain (Drizzle wraps driver errors in
 * DrizzleQueryError) and returns the first object carrying a
 * PostgreSQL SQLSTATE code.
 */
export function findPostgresError(error: unknown): unknown {
	const PG_SQLSTATE = /^[0-9A-Z]{5}$/;
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (typeof current === "object" && current !== null && !visited.has(current)) {
		visited.add(current);
		if ("code" in current && PG_SQLSTATE.test(String((current as { code?: unknown }).code))) {
			return current;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

/**
 * Detects a lost idempotency race: another request inserted a
 * transaction with the same idempotency_key first.
 */
export function isIdempotencyConflict(error: unknown): boolean {
	const pgError = findPostgresError(error);
	if (pgError === null || typeof pgError !== "object") return false;
	const candidate = pgError as { code?: unknown; constraint?: string; constraint_name?: string };
	if (candidate.code !== "23505") return false;
	const constraint = candidate.constraint_name ?? candidate.constraint ?? "";
	return constraint.includes("idempotency_key");
}

export function parseDatabaseError(error: unknown): DatabaseError {
	const isErrorWithCode = (
		err: unknown,
	): err is {
		code: string;
		constraint?: string;
		constraint_name?: string;
		detail?: string;
		message?: string;
	} => {
		return typeof err === "object" && err !== null && "code" in err;
	};

	const isErrorWithMessage = (err: unknown): err is { message: string } => {
		return typeof err === "object" && err !== null && "message" in err;
	};

	if (isErrorWithCode(error)) {
		// postgres.js exposes the PG wire field name (constraint_name)
		const constraint = error.constraint ?? error.constraint_name;
		switch (error.code) {
			case DatabaseErrorCode.UNIQUE_VIOLATION:
				return new DatabaseError(
					"Resource already exists",
					"UNIQUE_VIOLATION",
					constraint,
					error.detail,
				);

			case DatabaseErrorCode.FOREIGN_KEY_VIOLATION:
				return new DatabaseError(
					"Referenced resource not found",
					"FOREIGN_KEY_VIOLATION",
					constraint,
					error.detail,
				);

			case DatabaseErrorCode.NOT_NULL_VIOLATION:
				return new DatabaseError(
					"Required field missing",
					"NOT_NULL_VIOLATION",
					constraint,
					error.detail,
				);

			case DatabaseErrorCode.CHECK_VIOLATION:
				return new DatabaseError(
					"Data validation failed",
					"CHECK_VIOLATION",
					constraint,
					error.detail,
				);

			case DatabaseErrorCode.CONNECTION_ERROR:
				return new DatabaseError(
					"Database connection failed",
					"CONNECTION_ERROR",
					undefined,
					error.detail,
				);

			default:
				return new DatabaseError(
					"Database operation failed",
					"UNKNOWN_ERROR",
					undefined,
					error.message,
				);
		}
	}

	if (isErrorWithMessage(error)) {
		if (error.message.includes("unique constraint") || error.message.includes("duplicate key")) {
			return new DatabaseError(
				"Resource already exists",
				"UNIQUE_VIOLATION",
				undefined,
				error.message,
			);
		}

		if (
			error.message.includes("foreign key constraint") ||
			error.message.includes("violates foreign key")
		) {
			return new DatabaseError(
				"Referenced resource not found",
				"FOREIGN_KEY_VIOLATION",
				undefined,
				error.message,
			);
		}

		if (error.message.includes("not null constraint") || error.message.includes("null value")) {
			return new DatabaseError(
				"Required field missing",
				"NOT_NULL_VIOLATION",
				undefined,
				error.message,
			);
		}
	}

	const errorMessage = isErrorWithMessage(error) ? error.message : "Unknown database error";
	return new DatabaseError("Database operation failed", "UNKNOWN_ERROR", undefined, errorMessage);
}

/**
 * Maps database errors to HTTP status codes
 */
export function getHttpStatusForDatabaseError(error: DatabaseError): 400 | 409 | 500 | 503 {
	switch (error.code) {
		case "UNIQUE_VIOLATION":
			return 409; // Conflict
		case "FOREIGN_KEY_VIOLATION":
			return 400; // Bad Request
		case "NOT_NULL_VIOLATION":
			return 400; // Bad Request
		case "CHECK_VIOLATION":
			return 400; // Bad Request
		case "CONNECTION_ERROR":
			return 503; // Service Unavailable
		default:
			return 500; // Internal Server Error
	}
}

/**
 * Gets user-friendly error message for database errors
 */
export function getUserFriendlyMessage(error: DatabaseError): string {
	switch (error.code) {
		case "UNIQUE_VIOLATION":
			if (error.constraint?.includes("email")) {
				return "An account with this email already exists";
			}
			if (error.constraint?.includes("username")) {
				return "This username is already taken";
			}
			if (error.constraint?.includes("wallet_id")) {
				return "A wallet with this ID already exists";
			}
			if (error.constraint?.includes("idempotency_key")) {
				return "This request was already processed";
			}
			return "This resource already exists";

		case "FOREIGN_KEY_VIOLATION":
			return "Invalid reference to another resource";

		case "NOT_NULL_VIOLATION":
			return "Required information is missing";

		case "CHECK_VIOLATION":
			if (error.constraint?.includes("balance")) {
				return "Insufficient balance";
			}
			return "Invalid data provided";

		case "CONNECTION_ERROR":
			return "Database temporarily unavailable. Please try again later.";

		default:
			return "An unexpected error occurred. Please try again.";
	}
}
