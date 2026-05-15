import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { encrypt, decrypt, type EncryptedBlob } from "./crypto.ts";
import { makeLogger } from "./logger.ts";

const log = makeLogger("wallets");
export const CONTROL_WALLET_NAME = "LARP";

export type AffixKind = "prefix" | "suffix" | "none";

export interface WalletRecord {
  name: string;
  pubkey: string;
  label: string;            // word/letters the vanity address spells (for sequencer)
  affix: AffixKind;         // where in the pubkey the label sits
  enabled: boolean;
  notes?: string;
  encrypted: EncryptedBlob;
}

export interface WalletStore {
  version: 2;
  wallets: WalletRecord[];
}

export interface LoadedWallet {
  name: string;
  pubkey: string;
  label: string;
  affix: AffixKind;
  enabled: boolean;
  keypair: Keypair;
}

const STORE_PATH = "config/wallets.encrypted.json";

export function isReservedControlWallet(input: { name?: string; label?: string; affix?: AffixKind }): boolean {
  if ((input.name ?? "").trim() === CONTROL_WALLET_NAME) return true;
  return (input.label ?? "").trim().toUpperCase() === "LARP" && input.affix === "prefix";
}

export function readStore(): WalletStore {
  const raw = readFileSync(STORE_PATH, "utf8");
  const parsed = JSON.parse(raw) as any;
  // Migrate v1 → v2: add label/affix defaults, drop mode.
  if (parsed.version === 1) {
    const wallets: WalletRecord[] = (parsed.wallets ?? []).map((w: any) => ({
      name: w.name,
      pubkey: w.pubkey,
      label: w.label ?? "",
      affix: w.affix ?? "none",
      enabled: isReservedControlWallet(w) ? true : (w.enabled ?? true),
      notes: w.notes,
      encrypted: w.encrypted,
    }));
    return { version: 2, wallets };
  }
  if (parsed.version !== 2) throw new Error(`unsupported wallet store version: ${parsed.version}`);
  return {
    version: 2,
    wallets: (parsed.wallets ?? []).map((w: any) => ({
      ...w,
      enabled: isReservedControlWallet(w) ? true : (w.enabled ?? true),
    })),
  } as WalletStore;
}

export function writeStore(store: WalletStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function parseSecret(input: string): Keypair {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function addWallet(
  store: WalletStore,
  input: { name: string; label: string; affix: AffixKind; notes?: string },
  keypair: Keypair,
  password: string,
): WalletRecord {
  if (isReservedControlWallet(input) && input.name !== CONTROL_WALLET_NAME) {
    throw new Error("LARP prefix is reserved as the hard control wallet");
  }
  if (store.wallets.some((w) => w.name === input.name)) {
    throw new Error(`wallet with name "${input.name}" already exists`);
  }
  const secretB58 = bs58.encode(keypair.secretKey);
  const record: WalletRecord = {
    name: input.name,
    pubkey: keypair.publicKey.toBase58(),
    label: input.label,
    affix: input.affix,
    enabled: true,
    notes: input.notes,
    encrypted: encrypt(secretB58, password),
  };
  store.wallets.push(record);
  return record;
}

export function loadAllWallets(password: string): LoadedWallet[] {
  const store = readStore();
  const loaded: LoadedWallet[] = [];
  for (const w of store.wallets) {
    try {
      const secretB58 = decrypt(w.encrypted, password);
      const kp = Keypair.fromSecretKey(bs58.decode(secretB58));
      if (kp.publicKey.toBase58() !== w.pubkey) {
        log.warn(`pubkey mismatch for ${w.name}, skipping`);
        continue;
      }
      loaded.push({ name: w.name, pubkey: w.pubkey, label: w.label, affix: w.affix, enabled: w.enabled, keypair: kp });
    } catch (err) {
      throw new Error(
        `failed to decrypt wallet "${w.name}" — wrong password? (${(err as Error).message})`,
      );
    }
  }
  return loaded;
}
