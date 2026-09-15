// Loaded via `bun test --preload` before any test imports:
// marks the environment so lib/auth uses cheap bcrypt rounds in tests.
process.env.NODE_ENV = "test";
