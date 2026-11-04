import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => void;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const CONNECT_TIMEOUT_MS = 5_000;
// Above the broker's 15s deadline, so a hung command only ever fails after the broker gave up.
const COMMAND_TIMEOUT_MS = 30_000;

// One browser-level socket; tabs talk through flattened sessions on it.
export class CdpConnection {
  public readonly closed: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<CdpEventListener>();

  private constructor(private readonly socket: InstanceType<typeof WebSocket>) {
    socket.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data))));
    socket.addEventListener("close", () => this.failPending());
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => resolve());
    });
  }

  private failPending(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Chrome disconnected"));
    }
    this.pending.clear();
  }

  public static async connect(): Promise<CdpConnection> {
    const url = await resolveBrowserWebSocketUrl();
    const socket = new WebSocket(url);
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Cannot reach Chrome at ${url}`)), {
        once: true,
      });
    });
    try {
      await withTimeout(opened, `Timed out connecting to Chrome at ${url}`);
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpConnection(socket);
  }

  public send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  public on(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    this.socket.close();
  }

  private receive(message: CdpMessage): void {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiter) clearTimeout(waiter.timer);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners)
      listener(message.method, message.params ?? {}, message.sessionId);
  }
}

// Order: PASEO_CHROME_CDP_URL, then the DevToolsActivePort file that Chrome writes in your
// default profile when remote debugging is enabled at chrome://inspect/#remote-debugging,
// then a Chrome started with --remote-debugging-port=9222.
async function resolveBrowserWebSocketUrl(): Promise<string> {
  const configured = process.env.PASEO_CHROME_CDP_URL;
  if (configured?.startsWith("ws")) return configured;
  if (!configured) {
    const activePort = readDevToolsActivePort();
    if (activePort) return activePort;
  }
  const endpoint = new URL("/json/version", configured ?? DEFAULT_CDP_URL);
  const version = fetch(endpoint).then((response) => response.json());
  const { webSocketDebuggerUrl } = (await withTimeout(
    version,
    `Timed out reaching Chrome at ${endpoint}`,
  )) as { webSocketDebuggerUrl: string };
  return webSocketDebuggerUrl;
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), CONNECT_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readDevToolsActivePort(): string | null {
  try {
    const [port, socketPath] = readFileSync(
      path.join(defaultChromeUserDataDir(), "DevToolsActivePort"),
      "utf8",
    ).split("\n");
    return port && socketPath ? `ws://127.0.0.1:${port.trim()}${socketPath.trim()}` : null;
  } catch {
    return null;
  }
}

function defaultChromeUserDataDir(): string {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data");
  return path.join(os.homedir(), ".config/google-chrome");
}
