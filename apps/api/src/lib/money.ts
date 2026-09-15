/**
 * Exact decimal arithmetic for numeric(38, 8) columns.
 * All money math happens on scaled bigints (1 unit = 1e-8) so there is
 * never any floating-point drift.
 */

const DECIMALS = 8;
const SCALE_FACTOR = 10n ** BigInt(DECIMALS);
const AMOUNT_PATTERN = /^\d+(\.\d{1,8})?$/;

export function toScaled(decimal: string): bigint {
	const [intPart, fracPart = ""] = decimal.split(".");
	const fracPadded = fracPart.padEnd(DECIMALS, "0");
	return BigInt(intPart + fracPadded);
}

export function fromScaled(scaled: bigint): string {
	const sign = scaled < 0n ? "-" : "";
	const abs = scaled < 0n ? -scaled : scaled;
	const intPart = abs / SCALE_FACTOR;
	const fracPart = (abs % SCALE_FACTOR).toString().padStart(DECIMALS, "0");
	return `${sign}${intPart}.${fracPart}`;
}

/**
 * Parses user-supplied amount input into a normalized 8-decimal string.
 * Returns null when the input is not a valid positive amount.
 */
export function parseAmount(input: string | number): string | null {
	let raw: string;
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input <= 0) return null;
		raw = input.toFixed(DECIMALS);
	} else {
		raw = input.trim();
	}
	if (!AMOUNT_PATTERN.test(raw)) return null;
	const scaled = toScaled(raw);
	if (scaled <= 0n) return null;
	return fromScaled(scaled);
}

export function addAmounts(a: string, b: string): string {
	return fromScaled(toScaled(a) + toScaled(b));
}

export function subAmounts(a: string, b: string): string {
	return fromScaled(toScaled(a) - toScaled(b));
}

/**
 * Multiplies two 8-decimal amounts exactly; the product is floored to
 * 8 decimals (used for amount x price_per_token).
 */
export function mulAmounts(a: string, b: string): string {
	return fromScaled((toScaled(a) * toScaled(b)) / SCALE_FACTOR);
}

export function compareAmounts(a: string, b: string): number {
	const left = toScaled(a);
	const right = toScaled(b);
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

/**
 * Normalizes a DB/driver-supplied numeric ("60", 60, "60.00000000")
 * into the canonical 8-decimal string used in API responses.
 * Needed because the relational query path loses trailing zeros.
 */
export function normalizeAmount(value: string | number): string {
	return fromScaled(toScaled(typeof value === "number" ? value.toFixed(DECIMALS) : value));
}
