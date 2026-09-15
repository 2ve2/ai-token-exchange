import { customAlphabet } from "nanoid";

// Alphanumeric only, ambiguous characters (0/O, 1/l/I) removed so the
// code stays readable when shared between humans.
const WALLET_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const WALLET_ID_LENGTH = 8;

export const generateWalletId = customAlphabet(WALLET_ID_ALPHABET, WALLET_ID_LENGTH);
