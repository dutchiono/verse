import "dotenv/config";
import { makeLogger } from "./core/logger.ts";
import { getHeliusEndpoints, makeConnection, makeReadConnection } from "./core/rpc.ts";
import { session } from "./core/state.ts";
import { TokenInfoClient } from "./core/token-info.ts";
import { SequencerRunner } from "./core/sequencer-runner.ts";
import { startServer } from "./server/api.ts";

const log = makeLogger("main");

async function main(): Promise<void> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY missing from .env");
  const port = Number(process.env.SERVER_PORT ?? 7000);

  const snap = session.snapshot();
  log.info(`session state: ${snap.state} (${snap.walletCount} wallet(s) on disk)`);
  log.info("waiting for dashboard to unlock — keys remain encrypted until then");

  const endpoints = getHeliusEndpoints(apiKey);
  const conn = makeConnection(endpoints);
  const readConn = makeReadConnection();
  const tokenInfo = new TokenInfoClient(endpoints.http);
  const sequencer = new SequencerRunner(
    conn,
    (name) => session.getLoadedByName(name)?.keypair ?? null,
    (name) => session.getLoadedByNameAny(name)?.keypair ?? null,
  );

  startServer(port, { conn, readConn, tokenInfo, sequencer });

  // Auto-unlock is disabled by default. Enable explicitly only for trusted dev environments.
  const autoPass = process.env.AUTO_UNLOCK_PASSWORD;
  const allowAutoUnlock = process.env.ALLOW_AUTO_UNLOCK === "1";
  if (autoPass && allowAutoUnlock) {
    try {
      session.unlock(autoPass);
      log.info("auto-unlocked via AUTO_UNLOCK_PASSWORD");
    } catch (e) {
      log.warn("auto-unlock failed — check AUTO_UNLOCK_PASSWORD matches the stored password", {
        err: (e as Error).message,
      });
    }
  } else if (autoPass && !allowAutoUnlock) {
    log.warn("AUTO_UNLOCK_PASSWORD is set but ignored because ALLOW_AUTO_UNLOCK is not 1");
  }

  const webPort = Number(process.env.VITE_PORT ?? 7003);
  log.info(`verse running. open http://localhost:${webPort} (or wherever vite serves).`);

  const shutdown = () => {
    log.info("shutting down");
    sequencer.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal", { err: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
