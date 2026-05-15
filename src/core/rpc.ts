import { Connection } from "@solana/web3.js";
import WebSocket from "ws";
import { makeLogger } from "./logger.ts";

const log = makeLogger("rpc");
export const READ_RPC_URL = process.env.SOLANA_READ_RPC_URL ?? "https://api.mainnet.solana.com";

export interface HeliusEndpoints {
  http: string;
  ws: string;
}

export function getHeliusEndpoints(apiKey: string): HeliusEndpoints {
  if (!apiKey) throw new Error("HELIUS_API_KEY is required");
  return {
    http: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    ws: `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`,
  };
}

export function makeConnection(endpoints: HeliusEndpoints): Connection {
  return new Connection(endpoints.http, {
    commitment: "confirmed",
    wsEndpoint: endpoints.ws,
    // Don't let web3.js retry 429s internally — it compounds rate-limit cascades.
    // Let the caller decide whether to retry, and when.
    disableRetryOnRateLimit: true,
  });
}

export function makeReadConnection(): Connection {
  return new Connection(READ_RPC_URL, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
}

type WsHandler = (msg: unknown) => void;

export interface WsSubscription {
  id: number;
  method: string;
  params: unknown[];
  onNotification: WsHandler;
}

/**
 * Persistent Helius WS client with auto-reconnect and subscription replay.
 */
export class HeliusWs {
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pendingReqs = new Map<number, (result: unknown) => void>();
  private subs = new Map<number, WsSubscription>();
  private subIdByReqId = new Map<number, number>();
  private reconnectDelay = 1000;
  private closed = false;
  private url: string;
  private onConnectListeners = new Set<() => void>();
  private onDisconnectListeners = new Set<() => void>();
  /** Keeps the Helius WS from going idle-only and dropping (~few min) without traffic. */
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onConnect(fn: () => void): () => void {
    this.onConnectListeners.add(fn);
    return () => this.onConnectListeners.delete(fn);
  }

  onDisconnect(fn: () => void): () => void {
    this.onDisconnectListeners.add(fn);
    return () => this.onDisconnectListeners.delete(fn);
  }

  /**
   * Subscribe via raw JSON-RPC. Returns subscription id (Solana sub id).
   * The subscription is automatically replayed on reconnect.
   */
  async subscribe(method: string, params: unknown[], onNotification: WsHandler): Promise<number> {
    const reqId = this.nextReqId++;
    const sub: WsSubscription = { id: reqId, method, params, onNotification };
    const subId = (await this.sendRequest(reqId, method, params)) as number;
    sub.id = subId;
    this.subs.set(subId, sub);
    return subId;
  }

  /**
   * Best-effort unsubscribe. Maps the subscribe method to its unsubscribe counterpart.
   */
  async unsubscribe(subId: number): Promise<void> {
    const sub = this.subs.get(subId);
    this.subs.delete(subId);
    if (!sub) return;
    const unsubMethod = sub.method.replace(/Subscribe$/, "Unsubscribe");
    if (unsubMethod === sub.method) return; // unknown shape, just drop locally
    if (!this.isConnected()) return;
    try {
      const reqId = this.nextReqId++;
      await this.sendRequest(reqId, unsubMethod, [subId]);
    } catch (err) {
      log.warn(`${unsubMethod} failed`, { err: (err as Error).message });
    }
  }

  private connect(): void {
    if (this.closed) return;
    log.info(`connecting to ${redactUrl(this.url)}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      log.info("connected");
      this.reconnectDelay = 1000;
      for (const fn of this.onConnectListeners) fn();
      this.replaySubscriptions();
      this.startHeartbeat(ws);
    });

    ws.on("message", (data) => {
      const raw = data.toString().trim();
      if (!raw) return;
      const first = raw[0];
      // Proxies / infra sometimes send plain-text lines (e.g. "Connection …") — not JSON-RPC.
      if (first !== "{" && first !== "[") {
        log.debug("skip non-json ws text", { preview: raw.slice(0, 80) });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        log.debug("json parse failed", { err: (err as Error).message, preview: raw.slice(0, 80) });
        return;
      }
      if (parsed.id !== undefined && this.pendingReqs.has(parsed.id)) {
        const resolver = this.pendingReqs.get(parsed.id)!;
        this.pendingReqs.delete(parsed.id);
        resolver(parsed.result);
        return;
      }
      if (parsed.method && parsed.params?.subscription !== undefined) {
        const subId = parsed.params.subscription as number;
        const sub = this.subs.get(subId);
        sub?.onNotification(parsed.params);
      }
    });

    ws.on("close", () => {
      this.clearHeartbeat();
      log.warn("disconnected");
      this.ws = null;
      for (const fn of this.onDisconnectListeners) fn();
      if (!this.closed) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error("ws error", { err: err.message });
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    const intervalMs = 55_000;
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const id = this.nextReqId++;
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "getSlot", params: [] }));
      } catch {
        /* ignore */
      }
    }, intervalMs);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.reconnectDelay, 30000);
    log.info(`reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private async replaySubscriptions(): Promise<void> {
    const old = Array.from(this.subs.values());
    this.subs.clear();
    for (const sub of old) {
      try {
        const reqId = this.nextReqId++;
        const newSubId = (await this.sendRequest(reqId, sub.method, sub.params)) as number;
        sub.id = newSubId;
        this.subs.set(newSubId, sub);
        log.info(`replayed subscription ${sub.method} → ${newSubId}`);
      } catch (err) {
        log.error("failed to replay subscription", { method: sub.method, err: (err as Error).message });
      }
    }
  }

  private sendRequest(id: number, method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.pendingReqs.set(id, resolve);
      this.ws.send(payload, (err) => {
        if (err) {
          this.pendingReqs.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pendingReqs.has(id)) {
          this.pendingReqs.delete(id);
          reject(new Error(`request ${method} timed out`));
        }
      }, 15000);
    });
  }
}

function redactUrl(url: string): string {
  return url.replace(/api-key=[^&]+/, "api-key=***");
}
