import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
  Image,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import {
  getMirrorFrame,
  listMirrorTabs,
  type MirrorFrame,
  type MirrorInput,
  type MirrorTab,
  sendMirrorInput,
} from "../shared/mirror";

type Styles = ReturnType<typeof useStyles>;
type Send = (input: MirrorInput) => void;

const KEYS = ["Enter", "Tab", "Backspace", "Escape"] as const;
const WHEEL_FLUSH_MS = 80;
const NATIVE_SCROLL_STEP = 400;
const FRAME_POLL_MS = 160;

export function MirrorPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme);
  const listTabs = useRpc(listMirrorTabs);
  const tabs = useQuery({
    queryKey: ["chrome-mirror-tabs", workspaceId],
    queryFn: () => listTabs({ workspaceId }),
    refetchInterval: 2_000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const list = tabs.data?.tabs ?? [];
  // Default to the newest agent tab.
  const active = list.find((tab) => tab.browserId === selected) ?? list.at(-1) ?? null;

  let body: ReactNode;
  if (tabs.isPending) body = <Text style={styles.muted}>Loading…</Text>;
  else if (tabs.isError) body = <Text style={styles.muted}>{tabs.error.message}</Text>;
  else if (!tabs.data.connected)
    body = (
      <Text style={styles.muted}>
        Chrome isn't connected. Turn on remote debugging at chrome://inspect/#remote-debugging.
      </Text>
    );
  else if (!active)
    body = <Text style={styles.muted}>No agent tabs yet. Ask an agent to open a page.</Text>;
  else
    body = (
      <Mirror key={active.browserId} tab={active} styles={styles} web={layout.platform === "web"} />
    );

  return (
    <View style={styles.screen}>
      {list.length > 1 ? (
        <View style={styles.chips}>
          {list.map((tab) => (
            <Pressable
              key={tab.browserId}
              accessibilityRole="button"
              onPress={() => setSelected(tab.browserId)}
              style={[styles.chip, tab.browserId === active?.browserId && styles.chipActive]}
            >
              <Text numberOfLines={1} style={styles.chipText}>
                {tab.title || tab.url}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {body}
    </View>
  );
}

function Mirror({ tab, styles, web }: { tab: MirrorTab; styles: Styles; web: boolean }) {
  const frame = useMirrorFrame(tab.browserId);
  const sendInput = useRpc(sendMirrorInput);
  const send = useCallback<Send>((input) => void sendInput(input).catch(() => {}), [sendInput]);
  const { browserId } = tab;

  return (
    <View style={styles.mirror}>
      <View style={styles.toolbar}>
        <ToolButton
          icon="ArrowLeft"
          label="Back"
          styles={styles}
          onPress={() => send({ type: "back", browserId })}
        />
        <ToolButton
          icon="ArrowRight"
          label="Forward"
          styles={styles}
          onPress={() => send({ type: "forward", browserId })}
        />
        <ToolButton
          icon="RotateCw"
          label="Reload"
          styles={styles}
          onPress={() => send({ type: "reload", browserId })}
        />
        <Text numberOfLines={1} style={[styles.muted, styles.url]}>
          {tab.url}
        </Text>
      </View>
      {frame ? (
        <Screen frame={frame} browserId={browserId} send={send} styles={styles} web={web} />
      ) : (
        <Text style={styles.muted}>Waiting for the first frame…</Text>
      )}
      <Keyboard browserId={browserId} send={send} styles={styles} />
    </View>
  );
}

/** Polls the tab's picture, keeping the last frame while the page is unchanged. */
function useMirrorFrame(browserId: string): MirrorFrame | null {
  const getFrame = useRpc(getMirrorFrame);
  const last = useRef<MirrorFrame | null>(null);
  const query = useQuery({
    queryKey: ["chrome-mirror-frame", browserId],
    queryFn: async () => {
      const result = await getFrame({ browserId, since: last.current?.hash });
      if (result.status === "frame") last.current = result.frame;
      return last.current;
    },
    refetchInterval: FRAME_POLL_MS,
    gcTime: 0,
  });
  return query.data ?? null;
}

/** The page picture. Clicks and the wheel map from picture pixels to the page's CSS pixels. */
function Screen({
  frame,
  browserId,
  send,
  styles,
  web,
}: {
  frame: MirrorFrame;
  browserId: string;
  send: Send;
  styles: Styles;
  web: boolean;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const scale = width > 0 ? frame.width / width : 1;
  const uri = `data:image/jpeg;base64,${frame.jpeg}`;
  const pending = useRef({
    deltaY: 0,
    x: 0,
    y: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  });

  // The wheel fires many small events; send them as one scroll per WHEEL_FLUSH_MS.
  const onWheel = (event: {
    deltaY: number;
    nativeEvent: { offsetX: number; offsetY: number };
  }) => {
    const state = pending.current;
    state.deltaY += event.deltaY;
    state.x = event.nativeEvent.offsetX * scale;
    state.y = event.nativeEvent.offsetY * scale;
    state.timer ??= setTimeout(() => {
      send({ type: "scroll", browserId, x: state.x, y: state.y, deltaY: state.deltaY });
      state.deltaY = 0;
      state.timer = null;
    }, WHEEL_FLUSH_MS);
  };

  if (web) {
    return (
      <View onLayout={onLayout}>
        <img
          alt="Agent's Chrome tab"
          src={uri}
          draggable={false}
          style={{ width: "100%", display: "block", cursor: "pointer", userSelect: "none" }}
          onClick={(event) =>
            send({
              type: "click",
              browserId,
              x: event.nativeEvent.offsetX * scale,
              y: event.nativeEvent.offsetY * scale,
            })
          }
          onWheel={onWheel}
        />
      </View>
    );
  }

  const onPress = (event: GestureResponderEvent) =>
    send({
      type: "click",
      browserId,
      x: event.nativeEvent.locationX * scale,
      y: event.nativeEvent.locationY * scale,
    });
  const center = { browserId, x: frame.width / 2, y: frame.height / 2 };
  return (
    <View style={styles.mirror}>
      <Pressable onLayout={onLayout} onPress={onPress} accessibilityLabel="Agent's Chrome tab">
        <Image
          source={{ uri }}
          fadeDuration={0}
          style={{ width: "100%", aspectRatio: frame.width / frame.height }}
        />
      </Pressable>
      <View style={styles.toolbar}>
        <ToolButton
          icon="ChevronUp"
          label="Scroll up"
          styles={styles}
          onPress={() => send({ type: "scroll", ...center, deltaY: -NATIVE_SCROLL_STEP })}
        />
        <ToolButton
          icon="ChevronDown"
          label="Scroll down"
          styles={styles}
          onPress={() => send({ type: "scroll", ...center, deltaY: NATIVE_SCROLL_STEP })}
        />
      </View>
    </View>
  );
}

/** Text goes into whatever field has focus in the tab; click the field first. */
function Keyboard({ browserId, send, styles }: { browserId: string; send: Send; styles: Styles }) {
  const [text, setText] = useState("");
  const sendText = (pressEnter: boolean) => {
    if (text) send({ type: "text", browserId, text });
    if (pressEnter) send({ type: "key", browserId, key: "Enter" });
    setText("");
  };
  return (
    <View style={styles.toolbar}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => sendText(true)}
        placeholder="Type into the page (Enter sends text + Enter)"
        style={styles.input}
      />
      <Pressable accessibilityRole="button" onPress={() => sendText(false)} style={styles.button}>
        <Text style={styles.buttonText}>Type</Text>
      </Pressable>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          onPress={() => send({ type: "key", browserId, key })}
          style={styles.chip}
        >
          <Text style={styles.chipText}>{key}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ToolButton({
  icon,
  label,
  styles,
  onPress,
}: {
  icon: string;
  label: string;
  styles: Styles;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.chip}
    >
      <Icon name={icon} size={16} color={styles.chipText.color} />
    </Pressable>
  );
}

function useStyles(theme: PluginWorkspacePanelProps["theme"]) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, padding: 12, gap: 10, backgroundColor: theme.colors.surface0 },
        mirror: { gap: 8 },
        muted: { color: theme.colors.foregroundMuted },
        url: { flex: 1 },
        toolbar: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
        chips: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
        chip: {
          paddingVertical: 6,
          paddingHorizontal: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          maxWidth: 220,
        },
        chipActive: { borderColor: theme.colors.accent },
        chipText: { color: theme.colors.foreground },
        input: {
          flex: 1,
          minWidth: 180,
          paddingVertical: 6,
          paddingHorizontal: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          color: theme.colors.foreground,
        },
        button: {
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: 6,
          backgroundColor: theme.colors.accent,
        },
        buttonText: { color: theme.colors.accentForeground },
      }),
    [theme],
  );
}
