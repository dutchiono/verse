import { PublicKey, type Connection } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * SPL balance (UI amount) for owner + mint, or null if no ATA for either token program.
 */
export async function getWalletTokenUiBalance(
  connection: Connection,
  ownerPubkey: string,
  mintPubkey: string,
): Promise<number | null> {
  const r = await getWalletTokenBalance(connection, ownerPubkey, mintPubkey);
  return r?.uiAmount ?? null;
}

/**
 * Batched SPL UI balances for many owners against one mint.
 * This avoids the old N-wallet loop of getAccountInfo + getTokenAccountBalance calls.
 */
/**
 * Full token balance info including the exact raw amount string (avoids float precision).
 * Returns null if no ATA exists.
 */
export async function getWalletTokenBalance(
  connection: Connection,
  ownerPubkey: string,
  mintPubkey: string,
): Promise<{ uiAmount: number; rawAmount: string; decimals: number } | null> {
  const owner = new PublicKey(ownerPubkey);
  const mint = new PublicKey(mintPubkey);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mint, owner, false, programId);
      const info = await connection.getAccountInfo(ata, "confirmed");
      if (!info) continue;
      const b = await connection.getTokenAccountBalance(ata, "confirmed");
      const rawAmount = b.value.amount; // exact string, e.g. "1234567890"
      const decimals = b.value.decimals;
      const uiAmount = b.value.uiAmount ?? parseFloat(b.value.uiAmountString ?? "0");
      return { uiAmount, rawAmount, decimals };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("429") || msg.toLowerCase().includes("rate limited")) throw e;
      /* try next program */
    }
  }
  return null;
}
