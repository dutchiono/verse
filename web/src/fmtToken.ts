/** Format SPL UI amount for display (compact). */
export function fmtTokenUi(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "0";
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1e-8) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n < 1 ? n.toFixed(4) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Format a token price in SOL (can be very small). */
export function fmtPrice(priceSol: number | null | undefined): string {
  if (priceSol === null || priceSol === undefined || !Number.isFinite(priceSol)) return "—";
  if (priceSol === 0) return "0 SOL";
  if (priceSol >= 1) return `${priceSol.toLocaleString(undefined, { maximumSignificantDigits: 5 })} SOL`;
  if (priceSol >= 1e-4) return `${priceSol.toFixed(6)} SOL`;
  if (priceSol >= 1e-7) return `${priceSol.toFixed(9)} SOL`;
  return `${priceSol.toExponential(3)} SOL`;
}

/** Format a market cap in SOL. */
export function fmtMcap(mcapSol: number | null | undefined): string {
  if (mcapSol === null || mcapSol === undefined || !Number.isFinite(mcapSol)) return "—";
  if (mcapSol >= 1_000_000) return `${(mcapSol / 1_000_000).toFixed(2)}M◎`;
  if (mcapSol >= 1_000) return `${(mcapSol / 1_000).toFixed(2)}K◎`;
  return `${mcapSol.toFixed(2)}◎`;
}
