/** Same as `dev.ts` but enables port pre-clean (see `dev.ts` header). */
process.env.DEV_NUCLEAR = "1";
await import("./dev.ts");
