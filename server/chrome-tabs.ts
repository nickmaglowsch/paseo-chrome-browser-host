import { randomUUID } from "node:crypto";
import type {
  BrowserAutomationConsoleLogEntry,
  BrowserAutomationDialogEvent,
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteRequest,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
// The desktop host's automation service, vendored (see server/vendor/browser-automation/NOTICE),
// so snapshots, refs and trusted input behave exactly like the Paseo browser.
import {
  executeAutomationCommand,
  type AutomationCommandPayload,
  type BrowserRegistry,
  type TabContents,
  type TabImage,
} from "./vendor/browser-automation/service";
import { BrowserSnapshotEngine } from "./vendor/browser-automation/snapshot-engine";
import { CdpSessionQueue } from "./vendor/browser-automation/cdp-session-queue";
import {
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
} from "./vendor/browser-automation/dialog-handling";
import type { IsolatedKeyboardInputEvent } from "./vendor/browser-automation/trusted-input";
import type { CdpConnection } from "./cdp";

// Under the broker's 15s deadline, so new_tab and navigate answer before the broker gives up.
const LOAD_TIMEOUT_MS = 10_000;
// Runtime.enable is the usual way to read console output, and also how sites detect automation.
// Off by default; browser_logs then shows browser-level entries and network only.
const CAPTURE_CONSOLE = process.env.PASEO_CHROME_CONSOLE_LOGS === "1";
const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const KEY_ALIASES: Record<string, string> = {
  Down: "ArrowDown",
  Up: "ArrowUp",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Space: " ",
};
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

type Payload = AutomationCommandPayload;
type HistoryAction = "back" | "forward" | "reload";

function fail(requestId: string, code: BrowserAutomationErrorCode, message: string): Payload {
  return { requestId, ok: false, error: { code, message, retryable: false } };
}

// Agent tabs are windows this host opened. Your own tabs are never listed to agents.
export class ChromeTabs implements BrowserRegistry {
  private readonly tabs = new Map<string, ChromeTab>();
  private readonly activeByWorkspace = new Map<string, string>();
  private readonly snapshotEngine = new BrowserSnapshotEngine();
  private nextContentsId = 1;

  public constructor(private readonly cdp: CdpConnection) {
    cdp.on((method, params, sessionId) => {
      if (sessionId) {
        for (const tab of this.tabs.values())
          if (tab.sessionId === sessionId) tab.onEvent(method, params);
        return;
      }
      if (method === "Target.targetInfoChanged") {
        const info = params.targetInfo as { targetId: string; url: string; title: string };
        const tab = this.findByTarget(info.targetId);
        if (tab) {
          tab.url = info.url;
          tab.title = info.title;
        }
      } else if (method === "Target.targetDestroyed") {
        const tab = this.findByTarget(params.targetId as string);
        if (tab) this.drop(tab);
      } else if (method === "Target.detachedFromTarget") {
        for (const tab of this.tabs.values())
          if (tab.sessionId === params.sessionId) this.drop(tab);
      }
    });
  }

  public start(): Promise<unknown> {
    return this.cdp.send("Target.setDiscoverTargets", { discover: true });
  }

  public execute(request: BrowserAutomationExecuteRequest): Payload | Promise<Payload> {
    const { command, requestId } = request;
    if (command.command === "new_tab") return this.newTab(request, command.args.url);
    if (command.command === "close_tab") {
      const tab = this.tabFor(request, command.args.browserId);
      if (!tab) return fail(requestId, "browser_tab_not_found", "No browser tab found");
      return this.cdp.send("Target.closeTarget", { targetId: tab.targetId }).then(() => ({
        requestId,
        ok: true as const,
        result: { command: "close_tab" as const, browserId: tab.browserId },
      }));
    }
    // Handled here instead of by the shared service, whose TabContents.goBack() is fire-and-forget:
    // these wait for the navigation to land, so the next snapshot reads the new page.
    if (command.command === "back" || command.command === "forward" || command.command === "reload")
      return this.navigateHistory(request, command.command, command.args.browserId);
    if (command.command === "resize") {
      const tab = this.tabFor(request, command.args.browserId);
      if (!tab) return fail(requestId, "browser_tab_not_found", "No browser tab found");
      const { width, height } = command.args;
      return tab
        .queued("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 0,
          mobile: false,
        })
        .then(() => ({
          requestId,
          ok: true as const,
          result: { command: "resize" as const, browserId: tab.browserId, width, height },
        }));
    }
    return executeAutomationCommand(request, this, { snapshotEngine: this.snapshotEngine });
  }

  public listRegisteredBrowserIds(): string[] {
    return [...this.tabs.keys()];
  }

  public listRegisteredBrowserIdsForWorkspace(workspaceId: string): string[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.workspaceId === workspaceId)
      .map((tab) => tab.browserId);
  }

  public getTabContents(browserId: string): TabContents | null {
    return this.tabs.get(browserId)?.contents ?? null;
  }

  public getBrowserWorkspaceId(browserId: string): string | null {
    return this.tabs.get(browserId)?.workspaceId ?? null;
  }

  public getWorkspaceActiveBrowserId(workspaceId: string): string | null {
    return this.activeByWorkspace.get(workspaceId) ?? null;
  }

  private async newTab(request: BrowserAutomationExecuteRequest, url?: string): Promise<Payload> {
    const workspaceId = request.workspaceId;
    if (!workspaceId) {
      return fail(request.requestId, "browser_unsupported", "browser_new_tab needs a workspace.");
    }
    // ponytail: one window per tab. A background tab stops painting, which stalls snapshots and
    // screenshots; group tabs into one window per workspace if window clutter gets annoying.
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: true,
    });
    const browserId = randomUUID();
    let tab: ChromeTab | null = null;
    try {
      const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      tab = new ChromeTab(
        this.cdp,
        this.nextContentsId++,
        browserId,
        targetId,
        sessionId,
        workspaceId,
      );
      this.tabs.set(browserId, tab);
      this.activeByWorkspace.set(workspaceId, browserId);
      await Promise.all([
        tab.send("Page.enable"),
        tab.send("Log.enable"),
        tab.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
        ...(CAPTURE_CONSOLE ? [tab.send("Runtime.enable")] : []),
      ]);
    } catch (error) {
      // The agent never got this browserId, so nothing else could close the window.
      if (tab) this.drop(tab);
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
    if (url) await tab.loadURL(url).catch(() => {}); // A failed load still leaves a usable tab.
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "new_tab", browserId, workspaceId, url: url ?? "about:blank" },
    };
  }

  private tabFor(request: BrowserAutomationExecuteRequest, browserId: string): ChromeTab | null {
    const tab = this.tabs.get(browserId);
    if (!tab || tab.destroyed) return null;
    if (request.workspaceId && tab.workspaceId !== request.workspaceId) return null;
    return tab;
  }

  private async navigateHistory(
    request: BrowserAutomationExecuteRequest,
    action: HistoryAction,
    browserId: string,
  ): Promise<Payload> {
    const { requestId } = request;
    const tab = this.tabFor(request, browserId);
    if (!tab)
      return fail(requestId, "browser_tab_not_found", `No browser tab found for ID: ${browserId}`);
    const { result: moved, dialogs } = await tab.captureDialogs(() => tab.navigateHistory(action));
    if (!moved) return fail(requestId, "browser_denied", `There is nothing to go ${action} to.`);
    this.snapshotEngine.clearBrowser(browserId);
    return {
      requestId,
      ok: true,
      result: { command: action, browserId },
      ...(dialogs.length > 0 ? { dialogs } : {}),
    } as Payload;
  }

  private drop(tab: ChromeTab): void {
    tab.destroy();
    this.tabs.delete(tab.browserId);
    this.snapshotEngine.clearBrowser(tab.browserId);
    if (this.activeByWorkspace.get(tab.workspaceId) === tab.browserId)
      this.activeByWorkspace.delete(tab.workspaceId);
  }

  private findByTarget(targetId: string): ChromeTab | undefined {
    for (const tab of this.tabs.values()) if (tab.targetId === targetId) return tab;
    return undefined;
  }
}

class ChromeTab {
  public url = "about:blank";
  public title = "";
  public destroyed = false;
  public readonly contents: TabContents;
  private loading = false;
  private canGoBack = false;
  private canGoForward = false;
  private readonly consoleMessages: BrowserAutomationConsoleLogEntry[] = [];
  private readonly dialogCollectors: BrowserAutomationDialogEvent[][] = [];
  private readonly loadWaiters = new Set<() => void>();
  private readonly queue = new CdpSessionQueue();

  public constructor(
    private readonly cdp: CdpConnection,
    id: number,
    public readonly browserId: string,
    public readonly targetId: string,
    public readonly sessionId: string,
    public readonly workspaceId: string,
  ) {
    this.contents = {
      id,
      getURL: () => this.url,
      getTitle: () => this.title,
      canGoBack: () => this.canGoBack,
      canGoForward: () => this.canGoForward,
      isLoading: () => this.loading,
      isDestroyed: () => this.destroyed,
      executeJavaScript: (code) => this.evaluate(code),
      loadURL: (url) => this.loadURL(url),
      goBack: () => void this.navigateHistory("back").catch(() => {}),
      goForward: () => void this.navigateHistory("forward").catch(() => {}),
      reload: () => void this.navigateHistory("reload").catch(() => {}),
      captureFrame: () => this.screenshot(),
      invalidate: () => {},
      withFrameProduction: (capture) => capture(),
      sendInputEvent: (event) =>
        void this.queued("Input.dispatchKeyEvent", keyEventParams(event)).catch(() => {}),
      insertText: async (text) => {
        await this.queued("Input.insertText", { text });
      },
      getConsoleMessages: () => this.consoleMessages,
      captureDialogs: (task) => this.captureDialogs(task),
      sendDebugCommand: (command, params) => this.queued(command, params),
    };
  }

  public send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  public queued<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.queue.run(() => this.send<T>(method, params));
  }

  public onEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Page.frameStartedLoading" && params.frameId === this.targetId) {
      this.loading = true;
    } else if (method === "Page.frameStoppedLoading" && params.frameId === this.targetId) {
      this.loading = false;
    } else if (method === "Page.loadEventFired") {
      // Chrome does not push <title> changes, so read the target info once the page loads.
      void this.refreshInfo()
        .catch(() => {}) // The tab can close mid-refresh.
        .finally(() => this.resolveLoadWaiters());
    } else if (method === "Page.domContentEventFired") {
      void this.refreshInfo().catch(() => {});
    } else if (method === "Page.navigatedWithinDocument" || method === "Page.frameNavigated") {
      this.onNavigated(method, params);
    } else if (method === "Page.javascriptDialogOpening") {
      const event = handledDialogEvent(params);
      for (const dialogs of this.dialogCollectors)
        if (dialogs.length < MAX_DIALOGS_PER_COMMAND) dialogs.push(event);
      // Unqueued: the dialog blocks the queued command that opened it.
      void this.send("Page.handleJavaScriptDialog", {
        accept: dialogAcceptValue(event.type),
      }).catch(() => {});
    } else if (method === "Log.entryAdded") {
      const entry = params.entry as {
        level: string;
        text: string;
        url?: string;
        lineNumber?: number;
      };
      this.recordConsole(entry.level, entry.text, entry.url, entry.lineNumber);
    } else if (method === "Runtime.consoleAPICalled") {
      const args = params.args as Array<{ value?: unknown; description?: string }>;
      const text = args.map((arg) => arg.description ?? String(arg.value ?? "")).join(" ");
      this.recordConsole(params.type === "warning" ? "warn" : String(params.type), text);
    } else if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as {
        text: string;
        url?: string;
        lineNumber?: number;
        exception?: { description?: string };
      };
      const text = details.exception?.description ?? details.text;
      this.recordConsole("error", text, details.url, details.lineNumber);
    }
  }

  private onNavigated(method: string, params: Record<string, unknown>): void {
    if (method === "Page.navigatedWithinDocument") {
      if (params.frameId !== this.targetId) return;
      // Same-document history moves fire no load event.
      this.url = params.url as string;
      void this.refreshHistory()
        .catch(() => {})
        .finally(() => this.resolveLoadWaiters());
      return;
    }
    const frame = params.frame as { parentId?: string; url: string };
    if (frame.parentId) return;
    this.url = frame.url;
    // A back/forward-cache restore also skips the load event.
    const restored = params.type === "BackForwardCacheRestore";
    void Promise.all([this.refreshHistory(), restored ? this.refreshInfo() : null])
      .catch(() => {})
      .finally(() => restored && this.resolveLoadWaiters());
  }

  private recordConsole(level: string, message: string, source?: string, line?: number): void {
    this.consoleMessages.push({
      level,
      message,
      ...(source ? { source } : {}),
      ...(typeof line === "number" ? { line } : {}),
      timestamp: Date.now(),
    });
    if (this.consoleMessages.length > MAX_CONSOLE_MESSAGES_PER_TAB) this.consoleMessages.shift();
  }

  private async refreshInfo(): Promise<void> {
    const { targetInfo } = await this.cdp.send<{ targetInfo: { url: string; title: string } }>(
      "Target.getTargetInfo",
      { targetId: this.targetId },
    );
    this.url = targetInfo.url;
    this.title = targetInfo.title;
  }

  public destroy(): void {
    this.destroyed = true;
    this.resolveLoadWaiters();
  }

  public async loadURL(url: string): Promise<void> {
    const loaded = this.waitForLoad();
    const result = await this.queued<{ loaderId?: string; errorText?: string }>("Page.navigate", {
      url,
    });
    if (result.errorText) throw new Error(`${result.errorText} loading ${url}`);
    if (result.loaderId) await loaded; // No loaderId means a same-document navigation.
  }

  private async evaluate(expression: string): Promise<unknown> {
    const response = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text);
    }
    return response.result.value;
  }

  private async screenshot(): Promise<TabImage> {
    const { data } = await this.queued<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const png = Buffer.from(data, "base64");
    // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
    const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    return { toPNG: () => png, getSize: () => size };
  }

  public async captureDialogs<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    const dialogs: BrowserAutomationDialogEvent[] = [];
    this.dialogCollectors.push(dialogs);
    try {
      return { result: await task(), dialogs };
    } finally {
      this.dialogCollectors.splice(this.dialogCollectors.indexOf(dialogs), 1);
    }
  }

  /** Resolves once the page settles; false when there is no history entry to move to. */
  public async navigateHistory(action: HistoryAction): Promise<boolean> {
    if (action === "reload") {
      const loaded = this.waitForLoad();
      await this.queued("Page.reload");
      await loaded;
      return true;
    }
    const { currentIndex, entries } = await this.history();
    const entry = entries[currentIndex + (action === "back" ? -1 : 1)];
    if (!entry) return false;
    const loaded = this.waitForLoad();
    await this.queued("Page.navigateToHistoryEntry", { entryId: entry.id });
    await loaded;
    return true;
  }

  private async refreshHistory(): Promise<void> {
    const { currentIndex, entries } = await this.history();
    this.canGoBack = currentIndex > 0;
    this.canGoForward = currentIndex < entries.length - 1;
  }

  private history(): Promise<{ currentIndex: number; entries: Array<{ id: number }> }> {
    return this.send("Page.getNavigationHistory");
  }

  private waitForLoad(): Promise<void> {
    return new Promise((resolve) => {
      this.loadWaiters.add(resolve);
      // A slow page still resolves, as a usable but loading tab.
      setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
  }

  private resolveLoadWaiters(): void {
    for (const resolve of this.loadWaiters) resolve();
    this.loadWaiters.clear();
  }
}

// Electron keyboard events (what the shared service emits) mapped to CDP key events.
function keyEventParams(event: IsolatedKeyboardInputEvent): Record<string, unknown> {
  if (event.type === "char") return { type: "char", text: event.keyCode };
  const key = KEY_ALIASES[event.keyCode] ?? event.keyCode;
  const windowsVirtualKeyCode =
    VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (event.type === "keyUp") return { type: "keyUp", key, windowsVirtualKeyCode };
  // Enter needs text on keyDown so Chrome fires keypress and submits forms.
  return key === "Enter"
    ? { type: "keyDown", key, windowsVirtualKeyCode, text: "\r" }
    : { type: "rawKeyDown", key, windowsVirtualKeyCode };
}
