import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MirrorPanel } from "./client/mirror-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "chrome-mirror",
    title: "Chrome",
    icon: "Globe",
    context: "workspace",
    Component: MirrorPanel,
  });
  client.addCommandCenterItem({
    id: "open-chrome-mirror",
    title: "Show the agent's Chrome tab",
    icon: "Globe",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("chrome-mirror");
    },
  });
  return () => {};
}
