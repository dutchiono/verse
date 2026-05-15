import { EventEmitter } from "node:events";
import { PublicKey, type Connection } from "@solana/web3.js";
import { makeLogger } from "./logger.ts";
import type { HeliusWs } from "./rpc.ts";
import type { PoolConfig } from "./pools-store.ts";

const log = makeLogger("pool-watcher");

export interface PoolUpdate {
  poolId: string;
  poolAddress: string;
  slot: number;
  dataLen: number;
  lamports: number;
  dataB64: string;
  receivedAt: number;
}

interface ActiveSub {
  pool: PoolConfig;
  subId: number;
}

export class PoolWatcher extends EventEmitter {
  private ws: HeliusWs;
  private conn: Connection;
  private subs = new Map<string, ActiveSub>();
  private lastUpdate = new Map<string, PoolUpdate>();

  constructor(ws: HeliusWs, conn: Connection) {
    super();
    this.ws = ws;
    this.conn = conn;
  }

  getLastUpdate(poolId: string): PoolUpdate | undefined {
    return this.lastUpdate.get(poolId);
  }

  isWatching(poolId: string): boolean {
    return this.subs.has(poolId);
  }

  getConnection(): Connection {
    return this.conn;
  }

  async start(pool: PoolConfig): Promise<void> {
    if (this.subs.has(pool.id)) {
      log.debug(`already watching ${pool.id}`);
      return;
    }
    // Initial snapshot.
    try {
      const info = await this.conn.getAccountInfo(new PublicKey(pool.pool_address), "confirmed");
      if (info) {
        const update: PoolUpdate = {
          poolId: pool.id,
          poolAddress: pool.pool_address,
          slot: await this.conn.getSlot("confirmed"),
          dataLen: info.data.length,
          lamports: info.lamports,
          dataB64: info.data.toString("base64"),
          receivedAt: Date.now(),
        };
        this.lastUpdate.set(pool.id, update);
        this.emit("update", update);
        log.info(`snapshot ${pool.id}`, { dataLen: update.dataLen, lamports: update.lamports });
      } else {
        log.warn(`pool account not found: ${pool.pool_address} (${pool.id})`);
      }
    } catch (err) {
      log.error(`snapshot failed for ${pool.id}`, { err: (err as Error).message });
    }

    try {
      const subId = await this.ws.subscribe(
        "accountSubscribe",
        [pool.pool_address, { encoding: "base64", commitment: "confirmed" }],
        (msg: any) => this.handleNotification(pool, msg),
      );
      this.subs.set(pool.id, { pool, subId });
      log.info(`subscribed ${pool.id} → sub ${subId}`);
      this.emit("watch-start", pool.id);
    } catch (err) {
      log.error(`subscribe failed for ${pool.id}`, { err: (err as Error).message });
      throw err;
    }
  }

  async stop(poolId: string): Promise<void> {
    const active = this.subs.get(poolId);
    if (!active) return;
    try {
      await this.ws.unsubscribe(active.subId);
    } catch (err) {
      log.warn(`unsubscribe failed for ${poolId}`, { err: (err as Error).message });
    }
    this.subs.delete(poolId);
    log.info(`unsubscribed ${poolId}`);
    this.emit("watch-stop", poolId);
  }

  private handleNotification(pool: PoolConfig, msg: any): void {
    const value = msg?.result?.value;
    const slot = msg?.result?.context?.slot ?? 0;
    if (!value) return;
    const dataField = value.data;
    let dataB64 = "";
    let dataLen = 0;
    if (Array.isArray(dataField)) {
      dataB64 = dataField[0];
      dataLen = Buffer.from(dataB64, "base64").length;
    }
    const update: PoolUpdate = {
      poolId: pool.id,
      poolAddress: pool.pool_address,
      slot,
      dataLen,
      lamports: value.lamports ?? 0,
      dataB64,
      receivedAt: Date.now(),
    };
    this.lastUpdate.set(pool.id, update);
    this.emit("update", update);
    log.debug(`update ${pool.id}`, { slot, dataLen });
  }
}
