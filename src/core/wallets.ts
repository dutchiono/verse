import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { encrypt, decrypt, type EncryptedBlob } from "./crypto.ts";
import { makeLogger } from "./logger.ts";

const log = makeLogger("wallets");

export type AffixKind = "prefix" | "suffix" | "none";
export type WalletRole = "sequence" | "controller";

export interface WalletRecord {
  name: string;
  pubkey: string;
  label: string;            // word/letters the vanity address spells (for sequencer)
  affix: AffixKind;         // where in the pubkey the label sits
  role: WalletRole;
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
  role: WalletRole;
  enabled: boolean;
  keypair: Keypair;
}

const STORE_PATH = "config/wallets.encrypted.json";

function normalizeRole(w: any): WalletRole {
  if (w.role === "controller") return "controller";
  if (w.role === "sequence") return "sequence";
  return String(w.name ?? "").trim() === "LARP" ? "controller" : "sequence";
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
      role: normalizeRole(w),
      enabled: w.enabled ?? true,
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
      role: normalizeRole(w),
      enabled: w.enabled ?? true,
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
  input: { name: string; label: string; affix: AffixKind; role?: WalletRole; notes?: string },
  keypair: Keypair,
  password: string,
): WalletRecord {
  if (store.wallets.some((w) => w.name === input.name)) {
    throw new Error(`wallet with name "${input.name}" already exists`);
  }
  const secretB58 = bs58.encode(keypair.secretKey);
  const record: WalletRecord = {
    name: input.name,
    pubkey: keypair.publicKey.toBase58(),
    label: input.label,
    affix: input.affix,
    role: input.role ?? "sequence",
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
      loaded.push({ name: w.name, pubkey: w.pubkey, label: w.label, affix: w.affix, role: w.role, enabled: w.enabled, keypair: kp });
    } catch (err) {
      throw new Error(
        `failed to decrypt wallet "${w.name}" — wrong password? (${(err as Error).message})`,
      );
    }
  }
  return loaded;
}
