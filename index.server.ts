import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startChromeBrowserHost } from "./server/host";

export default function contribute(_server: PluginServerContext) {
  return startChromeBrowserHost();
}
