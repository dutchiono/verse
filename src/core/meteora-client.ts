import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
  TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { makeLogger } from "./logger.ts";

const log = makeLogger("meteora");

export interface DbcPoolPrice {
  /** Token price in SOL (e.g. 0.000012 SOL per token) */
  priceSol: number;
  /** SOL locked in the pool right now */
  quoteReserveSol: number;
  /** Tokens in the pool right now (UI units) */
  baseReserveTokens: number;
  /** 0–1: how far along the bonding curve to graduation */
  curveProgress: number;
  /** Market cap in SOL (priceSol × totalSupply). Requires supply to be passed in. */
  mcapSol: number | null;
}

/**
 * Safely convert a BN (big-number) to a JavaScript float by treating it as
 * a fixed-point integer with `exp` decimal places.
 *
 * BN.toNumber() throws if the value exceeds 2^53. This avoids that by doing
 * the decimal shift as a string operation first, then parsing only the
 * significant portion as a float.
 */
function bnToFloat(bn: { toString(): string }, exp: number): number {
  const s = bn.toString();
  if (exp === 0) return Number(s);
  if (s.length <= exp) {
    // e.g. "123" with exp=6 → "0.000123"
    return parseFloat("0." + s.padStart(exp, "0"));
  }
  const intPart = s.slice(0, s.length - exp);
  const fracPart = s.slice(s.length - exp, s.length - exp + 9); // 9 sig frac digits
  return parseFloat(intPart + "." + fracPart);
}

/** Map raw decimal count to TokenDecimal enum; fall back to NINE for unknowns. */
function toTokenDecimal(d: number): TokenDecimal {
  if (d === 6) return TokenDecimal.SIX;
  if (d === 7) return TokenDecimal.SEVEN;
  if (d === 8) return TokenDecimal.EIGHT;
  return TokenDecimal.NINE;
}

let _client: DynamicBondingCurveClient | null = null;
let _conn: Connection | null = null;

function getClient(connection: Connection): DynamicBondingCurveClient {
  // Use the static factory — it has an optional commitment param (defaults to "confirmed").
  if (!_client || _conn !== connection) {
    _client = DynamicBondingCurveClient.create(connection, "confirmed");
    _conn = connection;
  }
  return _client;
}

/**
 * Fetch the current price and reserves for a Meteora DBC pool via the SDK.
 *
 * @param connection    - Solana RPC connection
 * @param poolAddress   - Pool account address (base58)
 * @param tokenDecimals - Decimals of the base (project) token
 * @param totalSupply   - Optional: total token supply in UI units for mcap calc
 */
export async function getDbcPoolPrice(
  connection: Connection,
  poolAddress: string,
  tokenDecimals: number,
  totalSupply?: number | null,
): Promise<DbcPoolPrice | null> {
  try {
    const client = getClient(connection);
    // Read methods live on client.state (StateService)
    const pool = await client.state.getPool(new PublicKey(poolAddress));
    if (!pool) {
      log.warn("getPool returned null", { pool: poolAddress });
      return null;
    }

    const baseDecimal = toTokenDecimal(tokenDecimals);
    const quoteDecimal = TokenDecimal.NINE; // SOL always has 9 decimals

    // getPriceFromSqrtPrice returns a Decimal (quote per base = SOL per token)
    const priceDecimal = getPriceFromSqrtPrice(pool.sqrtPrice, baseDecimal, quoteDecimal);
    const priceSol = priceDecimal.toNumber();

    const quoteReserveSol = bnToFloat(pool.quoteReserve, 9);
    const baseReserveTokens = bnToFloat(pool.baseReserve, tokenDecimals);

    let curveProgress = 0;
    try {
      curveProgress = await client.state.getPoolQuoteTokenCurveProgress(new PublicKey(poolAddress));
    } catch {
      // non-critical — omit if it fails
    }

    const mcapSol =
      totalSupply != null && totalSupply > 0 && Number.isFinite(priceSol)
        ? priceSol * totalSupply
        : null;

    return { priceSol, quoteReserveSol, baseReserveTokens, curveProgress, mcapSol };
  } catch (e) {
    log.error("getDbcPoolPrice failed", { pool: poolAddress, err: (e as Error).message });
    return null;
  }
}
