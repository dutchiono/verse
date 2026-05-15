import { readStore } from "../core/wallets.ts";

const store = readStore();
if (store.wallets.length === 0) {
  console.log("No wallets imported yet. Use the dashboard Roster page or: bun run import-wallet");
  process.exit(0);
}

console.log(`\n${store.wallets.length} wallet(s):\n`);
for (const w of store.wallets) {
  const label = w.label ? `[${w.label}] ` : "";
  console.log(`  ${w.name.padEnd(20)} ${label}${w.pubkey}  (${w.affix})${w.notes ? `  — ${w.notes}` : ""}`);
}
console.log();
