import {
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
  type Keypair,
  type PublicKey,
} from "@solana/web3.js";

export const KEEP_LAMPORTS = 0;
const FEE_FALLBACK_LAMPORTS = 5_000;

/**
 * Transfer an exact SOL amount from one keypair to a destination pubkey.
 */
export async function transferSol(
  conn: Connection,
  from: Keypair,
  to: PublicKey,
  lamports: number,
): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }),
  );
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

/**
 * Transfer all sweepable SOL from a keypair back to a destination.
 * The only intended leftover is the network fee needed to land this transfer.
 */
export async function drainSol(
  conn: Connection,
  from: Keypair,
  to: PublicKey,
  knownBalanceLamports?: number,
): Promise<{ sig: string; lamports: number } | null> {
  const balance = knownBalanceLamports ?? await conn.getBalance(from.publicKey, "confirmed");
  const fee = await estimateTransferFee(conn, from.publicKey, to);
  const sendable = balance - fee - KEEP_LAMPORTS;
  if (sendable <= 0) return null;
  try {
    const sig = await transferSol(conn, from, to, sendable);
    return { sig, lamports: sendable };
  } catch (e) {
    const fallbackSendable = balance - fee - FEE_FALLBACK_LAMPORTS;
    if (fallbackSendable <= 0 || fallbackSendable >= sendable) throw e;
    const sig = await transferSol(conn, from, to, fallbackSendable);
    return { sig, lamports: fallbackSendable };
  }
}

async function estimateTransferFee(conn: Connection, from: PublicKey, to: PublicKey): Promise<number> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: from,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 }),
  );
  return (await conn.getFeeForMessage(tx.compileMessage(), "confirmed")).value ?? FEE_FALLBACK_LAMPORTS;
}
