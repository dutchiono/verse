import { PublicKey, type Connection } from "@solana/web3.js";
import type { PoolType } from "./pools-store.ts";

interface ProgramInfo {
  type: PoolType;
  name: string;
  /** True if we have price-fetch + on-chain reserve logic for this pool family. */
  pricingSupported: boolean;
}

/**
 * Known on-chain programs we recognise as DEX pools or launchpads.
 *
 * To support a new launchpad: add its program ID here with a new PoolType in
 * pools-store.ts. The pool will be tradable via Jupiter immediately; price/MC
 * feeds need to be implemented per-program separately.
 */
export const KNOWN_PROGRAMS: Record<string, ProgramInfo> = {
  // Meteora — fully supported (has price feed via SDK).
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN": {
    type: "meteora-dbc",
    name: "Meteora Dynamic Bonding Curve",
    pricingSupported: true,
  },
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": {
    type: "meteora-damm",
    name: "Meteora DAMM v2",
    pricingSupported: false,
  },
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": {
    type: "meteora-damm",
    name: "Meteora DAMM (CP-AMM v1)",
    pricingSupported: false,
  },
  // Pump.fun — tracked only (no native price math yet).
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": {
    type: "pumpfun-bc",
    name: "Pump.fun bonding curve",
    pricingSupported: false,
  },
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": {
    type: "pumpfun-amm",
    name: "PumpSwap (graduated pump.fun)",
    pricingSupported: false,
  },
  // Raydium — tracked only.
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": {
    type: "raydium-v4",
    name: "Raydium AMM v4",
    pricingSupported: false,
  },
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": {
    type: "raydium-cpmm",
    name: "Raydium CPMM",
    pricingSupported: false,
  },
};

export type PoolDetectionResult =
  | { status: "ok"; type: PoolType; programId: string; programName: string; pricingSupported: boolean }
  | { status: "unsupported"; programId: string; reason: string }
  | { status: "not-found"; reason: string }
  | { status: "error"; reason: string };

/**
 * Detect the pool family by looking at the account's owning program.
 * Returns either a known PoolType or a clear reason it couldn't be matched.
 */
export async function detectPoolType(
  connection: Connection,
  address: string,
): Promise<PoolDetectionResult> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    return { status: "error", reason: "not a valid Solana pubkey" };
  }
  try {
    const info = await connection.getAccountInfo(pubkey, "confirmed");
    if (!info) {
      return {
        status: "not-found",
        reason: "no account at this address on chain — check the address (maybe wrong network or wrong field?)",
      };
    }
    const programId = info.owner.toBase58();
    const known = KNOWN_PROGRAMS[programId];
    if (known) {
      return {
        status: "ok",
        type: known.type,
        programId,
        programName: known.name,
        pricingSupported: known.pricingSupported,
      };
    }
    return {
      status: "unsupported",
      programId,
      reason: `account is owned by an unrecognised program (${programId}). To add support, register the program ID in src/core/pool-detect.ts. You can still save this pool manually but features that depend on the pool family won't work.`,
    };
  } catch (e) {
    return { status: "error", reason: (e as Error).message };
  }
}
