import { existsSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import bs58 from "bs58";
import {
  readStore,
  writeStore,
  loadAllWallets,
  addWallet as addWalletToStore,
  parseSecret,
  isReservedControlWallet,
  CONTROL_WALLET_NAME,
  type WalletStore,
} from "./wallets.ts";
import type { LoadedWallet, AffixKind } from "./wallets.ts";
import { encrypt } from "./crypto.ts";

const STORE_PATH = "config/wallets.encrypted.json";

export interface PublicWalletInfo {
  name: string;
  pubkey: string;
  label: string;
  affix: AffixKind;
  enabled: boolean;
  notes?: string;
}

export interface SessionSnapshot {
  state: "fresh" | "locked" | "unlocked";
  walletCount: number;
}

class Session extends EventEmitter {
  private password: string | null = null;
  private loaded: LoadedWallet[] | null = null;

  isUnlocked(): boolean {
    return this.loaded !== null && this.password !== null;
  }

  snapshot(): SessionSnapshot {
    if (!existsSync(STORE_PATH)) {
      return { state: "fresh", walletCount: 0 };
    }
    const store = readStore();
    const wc = store.wallets.length;
    if (wc === 0) return { state: "fresh", walletCount: 0 };
    if (this.isUnlocked()) return { state: "unlocked", walletCount: wc };
    return { state: "locked", walletCount: wc };
  }

  unlock(password: string): SessionSnapshot {
    if (!existsSync(STORE_PATH)) {
      mkdirSync("config", { recursive: true });
      writeStore({ version: 2, wallets: [] });
      this.password = password;
      this.loaded = [];
      this.emit("change");
      return this.snapshot();
    }
    const store = readStore();
    if (store.wallets.length === 0) {
      this.password = password;
      this.loaded = [];
      this.emit("change");
      return this.snapshot();
    }
    this.loaded = loadAllWallets(password);
    this.password = password;
    this.emit("change");
    return this.snapshot();
  }

  lock(): void {
    this.loaded = null;
    this.password = null;
    this.emit("change");
  }

  rotatePassword(newPassword: string): void {
    if (!this.isUnlocked() || !this.password || !this.loaded) throw new Error("session is locked");
    const oldStore = readStore();
    const notesByName = new Map(oldStore.wallets.map((w) => [w.name, w.notes]));
    const next: WalletStore = { version: 2, wallets: [] };
    for (const lw of this.loaded) {
      const secretB58 = bs58.encode(lw.keypair.secretKey);
      next.wallets.push({
        name: lw.name,
        pubkey: lw.pubkey,
        label: lw.label,
        affix: lw.affix,
        enabled: lw.enabled,
        notes: notesByName.get(lw.name),
        encrypted: encrypt(secretB58, newPassword),
      });
    }
    writeStore(next);
    this.password = newPassword;
    this.loaded = loadAllWallets(newPassword);
    this.emit("change");
  }

  listPublic(): PublicWalletInfo[] {
    if (!existsSync(STORE_PATH)) return [];
    const store = readStore();
    return store.wallets.map((w) => ({
      name: w.name,
      pubkey: w.pubkey,
      label: w.label,
      affix: w.affix,
      enabled: w.enabled,
      notes: w.notes,
    }));
  }

  getLoadedByName(name: string): LoadedWallet | undefined {
    return this.loaded?.find((w) => w.name === name && w.enabled);
  }

  getLoadedByNameAny(name: string): LoadedWallet | undefined {
    return this.loaded?.find((w) => w.name === name);
  }

  addWallet(input: {
    name: string;
    secret: string;
    label: string;
    affix: AffixKind;
    notes?: string;
  }): PublicWalletInfo {
    if (!this.isUnlocked() || !this.password) throw new Error("session is locked");
    if (isReservedControlWallet(input) && input.name !== CONTROL_WALLET_NAME) {
      throw new Error("LARP prefix is reserved as the hard control wallet");
    }
    const kp = parseSecret(input.secret);
    const store = readStore();
    addWalletToStore(
      store,
      { name: input.name, label: input.label, affix: input.affix, notes: input.notes },
      kp,
      this.password,
    );
    writeStore(store);
    this.loaded = loadAllWallets(this.password);
    this.emit("change");
    const w = store.wallets.find((x) => x.name === input.name)!;
    return { name: w.name, pubkey: w.pubkey, label: w.label, affix: w.affix, enabled: w.enabled, notes: w.notes };
  }

  updateWallet(
    name: string,
    patch: { label?: string; affix?: AffixKind; enabled?: boolean; notes?: string },
  ): PublicWalletInfo {
    return this.updateWallets([name], patch)[0]!;
  }

  updateWallets(
    names: string[],
    patch: { label?: string; affix?: AffixKind; enabled?: boolean; notes?: string },
  ): PublicWalletInfo[] {
    if (!this.isUnlocked() || !this.password) throw new Error("session is locked");
    const store = readStore();
    const requested = new Set(names);
    const found = store.wallets.filter((x) => requested.has(x.name));
    if (found.length !== requested.size) {
      const known = new Set(found.map((w) => w.name));
      const missing = names.find((name) => !known.has(name));
      throw new Error(`wallet not found: ${missing}`);
    }
    for (const w of found) {
      if (patch.label !== undefined) w.label = patch.label;
      if (patch.affix !== undefined) w.affix = patch.affix;
      if (patch.enabled !== undefined) w.enabled = isReservedControlWallet(w) ? true : patch.enabled;
      if (patch.notes !== undefined) w.notes = patch.notes;
    }
    writeStore(store);
    if (this.loaded) {
      for (const lw of this.loaded) {
        const w = found.find((x) => x.name === lw.name);
        if (!w) continue;
        lw.label = w.label;
        lw.affix = w.affix;
        lw.enabled = w.enabled;
      }
    }
    this.emit("change");
    return found.map((w) => ({ name: w.name, pubkey: w.pubkey, label: w.label, affix: w.affix, enabled: w.enabled, notes: w.notes }));
  }

  /**
   * Bulk import. Skips wallets whose `name` already exists (returned in `skipped`).
   * Returns per-row errors rather than throwing on the first failure so the caller
   * can show a summary.
   */
  addWalletsBulk(inputs: Array<{
    name: string;
    secret: string;
    label: string;
    affix: AffixKind;
    notes?: string;
  }>): { added: PublicWalletInfo[]; skipped: string[]; errors: { name: string; error: string }[] } {
    if (!this.isUnlocked() || !this.password) throw new Error("session is locked");
    const store = readStore();
    const existingNames = new Set(store.wallets.map((w) => w.name));
    const existingPubkeys = new Set(store.wallets.map((w) => w.pubkey));
    const added: PublicWalletInfo[] = [];
    const skipped: string[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const input of inputs) {
      if (!input.name) { errors.push({ name: input.name ?? "(unnamed)", error: "name required" }); continue; }
      if (!input.secret) { errors.push({ name: input.name, error: "secret required" }); continue; }
      if (isReservedControlWallet(input) && input.name !== CONTROL_WALLET_NAME) { skipped.push(input.name); continue; }
      if (existingNames.has(input.name)) { skipped.push(input.name); continue; }
      try {
        const kp = parseSecret(input.secret);
        const pubkey = kp.publicKey.toBase58();
        if (existingPubkeys.has(pubkey)) { skipped.push(input.name); continue; }
        addWalletToStore(
          store,
          { name: input.name, label: input.label, affix: input.affix, notes: input.notes },
          kp,
          this.password,
        );
        existingNames.add(input.name);
        existingPubkeys.add(pubkey);
        added.push({
          name: input.name,
          pubkey,
          label: input.label,
          affix: input.affix,
          enabled: true,
          notes: input.notes,
        });
      } catch (e) {
        errors.push({ name: input.name, error: (e as Error).message });
      }
    }
    if (added.length > 0) {
      writeStore(store);
      this.loaded = loadAllWallets(this.password);
      this.emit("change");
    }
    return { added, skipped, errors };
  }

  deleteWallet(name: string): void {
    if (!this.isUnlocked() || !this.password) throw new Error("session is locked");
    if (name === CONTROL_WALLET_NAME) throw new Error("LARP is the hard control wallet and cannot be deleted");
    const store = readStore();
    store.wallets = store.wallets.filter((w) => w.name !== name);
    writeStore(store);
    this.loaded = loadAllWallets(this.password);
    this.emit("change");
  }
}

export const session = new Session();
