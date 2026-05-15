import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readStore, writeStore, parseSecret, addWallet, type AffixKind } from "../core/wallets.ts";
import { makeLogger } from "../core/logger.ts";

const log = makeLogger("import");

const VALID_AFFIX: AffixKind[] = ["prefix", "suffix", "none"];

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const name = (await rl.question("Wallet name (e.g. brrr-1): ")).trim();
    if (!name) throw new Error("name required");

    const label = (await rl.question("Label (word in vanity address, e.g. BRRR): ")).trim();
    const affixRaw = (await rl.question(`Affix [${VALID_AFFIX.join("|")}] (default: prefix): `)).trim();
    const affix: AffixKind = (affixRaw || "prefix") as AffixKind;
    if (!VALID_AFFIX.includes(affix)) throw new Error(`invalid affix: ${affix}`);

    const notes = (await rl.question("Notes (optional): ")).trim() || undefined;

    stdout.write("Paste private key (base58 or JSON array). Input is visible:\n");
    const secretLine = await rl.question("> ");
    const keypair = parseSecret(secretLine);

    const password = (await rl.question("Encryption password (>= 8 chars): ")).trim();
    if (password.length < 8) throw new Error("password must be at least 8 chars");
    const confirm = (await rl.question("Confirm password: ")).trim();
    if (password !== confirm) throw new Error("passwords do not match");

    const store = readStore();
    const record = addWallet(store, { name, label, affix, notes }, keypair, password);
    writeStore(store);

    log.info("wallet imported", { name: record.name, pubkey: record.pubkey, label: record.label });
    stdout.write(`\nSaved. Pubkey: ${record.pubkey}\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  log.error("import failed", { err: (err as Error).message });
  process.exit(1);
});
