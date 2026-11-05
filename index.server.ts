import type { PluginServerContext } from "@getpaseo/plugin/server";
import { currentChromeTabs, startChromeBrowserHost } from "./server/host";
import { getMirrorFrame, listMirrorTabs, sendMirrorInput } from "./shared/mirror";

export default function contribute(server: PluginServerContext) {
  server.handle(listMirrorTabs, ({ workspaceId }) => {
    const tabs = currentChromeTabs();
    return { connected: tabs !== null, tabs: tabs?.listMirrorTabs(workspaceId) ?? [] };
  });
  server.handle(getMirrorFrame, async ({ browserId, since, small }) => {
    const frame = await currentChromeTabs()
      ?.mirrorFrame(browserId, small ?? false)
      ?.catch(() => null);
    if (!frame) return { status: "missing" as const };
    return frame.hash === since
      ? { status: "unchanged" as const }
      : { status: "frame" as const, frame };
  });
  server.handle(sendMirrorInput, async (input) => ({
    ok: (await currentChromeTabs()?.mirrorInput(input)) ?? false,
  }));
  return startChromeBrowserHost();
}
