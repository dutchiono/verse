/**
 * Batch import wallets from a CSV file.
 *
 * Expected CSV columns (with header row):
 *   Word, Type, Short Wallet, Wallet Address, Private Key, Source File
 *
 * Usage:
 *   bun run scripts/batch-import-wallets.ts wallets.csv [password]
 *
 * Password falls back to AUTO_UNLOCK_PASSWORD in .env.
 * Wallets are matched by pubkey — duplicates are skipped silently.
 * Naming:
 *   Prefix → WORD, WORD-2, WORD-3 …
 *   Suffix → WORD-s, WORD-s2, WORD-s3 …
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { readStore, writeStore } from "../src/core/wallets.ts";
import { encrypt } from "../src/core/crypto.ts";

type AffixKind = "prefix" | "suffix" | "none";

const [csvPath, cliPassword] = process.argv.slice(2);
if (!csvPath) {
  console.error("Usage: bun run scripts/batch-import-wallets.ts <wallets.csv> [password]");
  process.exit(1);
}

const password = cliPassword ?? process.env.AUTO_UNLOCK_PASSWORD ?? "";
if (!password) {
  console.error("Password required — pass as second arg or set AUTO_UNLOCK_PASSWORD in .env");
  process.exit(1);
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot generate unique name for base "${base}"`);
}

const store = readStore();
const existingPubkeys = new Set(store.wallets.map((w) => w.pubkey));
const takenNames = new Set(store.wallets.map((w) => w.name));

const raw = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const rows = raw.slice(1); // skip header

let added = 0;
let skipped = 0;
let errors = 0;

for (const line of rows) {
  if (!line.trim()) continue;
  const cols = line.split(",");
  const word    = cols[0]?.trim() ?? "";
  const type    = cols[1]?.trim() ?? ""; // "Prefix" | "Suffix"
  const pubkey  = cols[3]?.trim() ?? "";
  const privkey = cols[4]?.trim() ?? "";

  if (!word || !pubkey || !privkey) {
    console.warn(`SKIP malformed row: ${line.slice(0, 60)}`);
    skipped++;
    continue;
  }

  if (existingPubkeys.has(pubkey)) {
    const existing = store.wallets.find((w) => w.pubkey === pubkey);
    console.log(`SKIP  ${word} ${type.padEnd(6)} ${pubkey.slice(0, 8)}…  (already imported as "${existing?.name}")`);
    skipped++;
    continue;
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(privkey));
  } catch {
    console.error(`ERROR ${word} ${type}: invalid private key`);
    errors++;
    continue;
  }

  if (keypair.publicKey.toBase58() !== pubkey) {
    console.error(`ERROR ${word} ${type}: private key does not match pubkey ${pubkey.slice(0, 8)}…`);
    errors++;
    continue;
  }

  const affix: AffixKind = type === "Prefix" ? "prefix" : type === "Suffix" ? "suffix" : "none";
  const nameBase = affix === "suffix" ? `${word}-s` : word;
  const name = uniqueName(nameBase, takenNames);
  takenNames.add(name);

  const secretB58 = bs58.encode(keypair.secretKey);
  store.wallets.push({
    name,
    pubkey,
    label: word,
    affix,
    enabled: true,
    encrypted: encrypt(secretB58, password),
  });
  existingPubkeys.add(pubkey);

  console.log(`ADD   ${name.padEnd(10)} (${word} ${type.toLowerCase()}) ${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`);
  added++;
}

if (added > 0) {
  writeStore(store);
  console.log(`\nWrote ${store.wallets.length} total wallets to config/wallets.encrypted.json`);
} else {
  console.log("\nNothing new to write.");
}

console.log(`\nResult: ${added} added, ${skipped} skipped, ${errors} errors`);
