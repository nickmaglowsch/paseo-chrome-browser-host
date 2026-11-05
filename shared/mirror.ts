import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const MirrorTabSchema = z.object({ browserId: z.string(), url: z.string(), title: z.string() });
export type MirrorTab = z.infer<typeof MirrorTabSchema>;

/** The Chrome windows agents opened for a workspace. */
export const listMirrorTabs = defineRpc({
  name: "chrome.mirror.tabs",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ connected: z.boolean(), tabs: z.array(MirrorTabSchema) }),
});

/** width and height are the viewport in CSS pixels, for mapping input. */
const MirrorFrameSchema = z.object({
  jpeg: z.string(),
  width: z.number(),
  height: z.number(),
  hash: z.string(),
});
export type MirrorFrame = z.infer<typeof MirrorFrameSchema>;

/**
 * One JPEG frame of a tab, polled by the panel. Passing the last frame's hash returns
 * `unchanged` instead of resending the same picture.
 * ponytail: polling, because plugin subscriptions need a newer daemon than 0.15.0. Move to
 * defineSubscription once your daemon has them.
 */
export const getMirrorFrame = defineRpc({
  name: "chrome.mirror.frame",
  input: z.object({
    browserId: z.string(),
    since: z.string().optional(),
    /** Phones: a smaller, lower-quality picture. */
    small: z.boolean().optional(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("frame"), frame: MirrorFrameSchema }),
    z.object({ status: z.literal("unchanged") }),
    z.object({ status: z.literal("missing") }),
  ]),
});

const Point = { browserId: z.string(), x: z.number(), y: z.number() };
const MirrorInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...Point }),
  z.object({ type: z.literal("scroll"), ...Point, deltaY: z.number() }),
  z.object({ type: z.literal("text"), browserId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal("key"), browserId: z.string(), key: z.string().min(1) }),
  z.object({ type: z.enum(["back", "forward", "reload"]), browserId: z.string() }),
]);
export type MirrorInput = z.infer<typeof MirrorInputSchema>;

/** Your input, sent to the tab as trusted browser input. Coordinates are CSS pixels. */
export const sendMirrorInput = defineRpc({
  name: "chrome.mirror.input",
  input: MirrorInputSchema,
  output: z.object({ ok: z.boolean() }),
});
