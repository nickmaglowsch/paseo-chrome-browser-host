import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { BROWSER_AUTOMATION_COMMAND_NAMES } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { CdpConnection } from "./cdp";
import { ChromeTabs } from "./chrome-tabs";

const RETRY_MS = 5_000;

let currentTabs: ChromeTabs | null = null;

/** The agent tabs of the connected Chrome, or null while Chrome is unreachable. */
export function currentChromeTabs(): ChromeTabs | null {
  return currentTabs;
}

// Registers Chrome as a browser automation host while Chrome is reachable. When Chrome goes
// away the registration is released, so the desktop app's browser takes over again.
export function startChromeBrowserHost(): () => Promise<void> {
  let stopped = false;
  let client: DaemonClient | null = null;
  let cdp: CdpConnection | null = null;

  const isStopped = () => stopped;
  const run = async () => {
    const daemon = await retry(connectDaemon, isStopped);
    client = daemon;
    if (!daemon || isStopped()) return void (await daemon?.close());
    while (!isStopped()) {
      const chrome = await retry(() => CdpConnection.connect(), isStopped);
      cdp = chrome;
      if (!chrome || isStopped()) return chrome?.close();
      await serveChrome(daemon, chrome).catch((error) => {
        console.error("[chrome-browser-host]", error);
        chrome.close();
      });
    }
  };
  void run().catch((error) => console.error("[chrome-browser-host]", error));

  return async () => {
    stopped = true;
    cdp?.close();
    await client?.close();
  };
}

async function serveChrome(client: DaemonClient, cdp: CdpConnection): Promise<void> {
  const tabs = new ChromeTabs(cdp);
  await tabs.start();
  currentTabs = tabs;
  const registration = client.registerBrowserHost({
    hostKind: "chrome",
    supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
  });
  const unsubscribe = registration.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type !== "browser.automation.execute.request") return;
      void Promise.resolve()
        .then(() => tabs.execute(message))
        .catch((error: unknown) => ({
          requestId: message.requestId,
          ok: false as const,
          error: {
            code: "browser_unknown_error" as const,
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        }))
        .then((payload) =>
          client.sendBrowserAutomationExecuteResponse({
            type: "browser.automation.execute.response",
            payload,
          }),
        )
        // The daemon can drop mid-command; the broker already failed that request.
        .catch((error: unknown) => console.warn("[chrome-browser-host] response not sent", error));
    },
  });
  console.info("[chrome-browser-host] Chrome registered as the browser automation host");
  await cdp.closed;
  if (currentTabs === tabs) currentTabs = null;
  unsubscribe();
  await registration.release().catch(() => {});
  console.info("[chrome-browser-host] Chrome disconnected; released the browser host");
}

// ponytail: reads the daemon's pid lock and local credential directly (same files the CLI
// uses) instead of pulling @getpaseo/server/daemon-control into the bundle.
async function connectDaemon(): Promise<DaemonClient> {
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  const { listen } = JSON.parse(readFileSync(path.join(home, "paseo.pid"), "utf8")) as {
    listen: string;
  };
  const client = createHostClient(listen, {
    clientId: "chrome-browser-host",
    clientType: "cli",
    localCredential: () => readFileSync(path.join(home, "local-credential"), "utf8").trim(),
    reconnect: { enabled: true },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function retry<T>(attempt: () => Promise<T>, isStopped: () => boolean): Promise<T | null> {
  while (!isStopped()) {
    try {
      return await attempt();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  return null;
}
