# Chrome browser host

Routes Paseo's `browser_*` agent tools to your Chrome instead of the Paseo browser. Agents keep the
same tools and `@eN` refs; only the browser behind them changes. It runs the Paseo desktop app's
automation service (vendored in `server/vendor/browser-automation`), so snapshots, refs and input
behave like the Paseo browser.

While Chrome is reachable the plugin registers as a browser automation host. When Chrome closes
it releases the registration and the Paseo browser takes over again.

## Connect Chrome

Pick one. The plugin tries them in this order.

1. `PASEO_CHROME_CDP_URL` in the daemon's environment: an `http://host:port` debugging endpoint or a
   `ws://` browser URL.
2. Your everyday Chrome profile (Chrome 144+): open `chrome://inspect/#remote-debugging` and turn on
   remote debugging. Chrome asks you to allow the connection.
3. A Chrome started with `--remote-debugging-port=9222`. Since Chrome 136 that flag ignores the
   default profile, so give it a copy of your profile:

```bash
# Quit Chrome first.
cp -R "$HOME/Library/Application Support/Google/Chrome" "$HOME/.paseo-chrome"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.paseo-chrome" \
  --disable-backgrounding-occluded-windows
```

Logins and cookies come along with the copy. Passwords you save later reach it only through
Chrome sync.

## Install

Requires Paseo 0.15.0 or later.

```bash
git clone https://github.com/nickmaglowsch/paseo-chrome-browser-host.git
cd paseo-chrome-browser-host
npm install
paseo plugin install "$PWD"
```

Plugins run only when `pluginsEnabled` is `true` in the daemon config. After pulling changes, run
`paseo plugin reload chrome-browser-host`.

## Watch and drive the tab in Paseo

Open the command center in a workspace and pick **Show the agent's Chrome tab**. The Chrome panel
shows the newest Chrome window an agent opened for that workspace; chips switch between several.

- Click on the picture to click the page. On desktop and web the mouse wheel scrolls it; on mobile
  use the arrow buttons.
- To type, click a field in the picture, then use the text box: **Type** inserts the text, Enter
  inserts it and presses Enter. The key buttons press Enter, Tab, Backspace or Escape.
- Back, forward and reload work like the browser buttons.
- The picture refreshes about six times a second while the panel is open, and only changed frames
  are sent. On a phone it refreshes twice a second with a smaller, lower-quality picture (480 pixels
  wide), which keeps it usable over the relay or cellular. Your input changes the page under the agent, so its next command takes a new snapshot.

## Behavior

- Each `browser_new_tab` opens its own Chrome window in the background. A background tab stops
  painting, which stalls snapshots and screenshots.
- Agents see only the windows they opened. Your own tabs are never listed.
- `browser_new_tab` goes to the most recently registered host. If the Paseo desktop app reconnects
  after the plugin, new tabs go back to the Paseo browser until the plugin registers again.
- JavaScript dialogs in agent windows are answered automatically, like in the Paseo browser.
- Console output needs `Runtime.enable`, which sites can detect. It is off by default. Set
  `PASEO_CHROME_CONSOLE_LOGS=1` in the daemon's environment to include console messages in
  `browser_logs`.
- Touch ID, passkey and Keychain prompts appear on your screen; agents cannot answer them.
