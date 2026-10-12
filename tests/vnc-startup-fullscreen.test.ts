import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { defaultVncSettings } from "../src/app-defaults";
import { DEFAULT_WORKSPACE_ID, useWorkspaceStore } from "../src/store";
import { serializeLayout } from "../src/modules/workspace/layout";
import type { Connection } from "../src/types";

const connection: Connection = { id: "vnc-startup", name: "VNC", host: "example.test", user: "", type: "vnc", status: "idle" };
beforeEach(() => useWorkspaceStore.setState({
  tabs: [], activeTabId: "", activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  activeSessionCounts: {}, vncSettings: { ...defaultVncSettings },
}));
const store = () => useWorkspaceStore.getState();
const activePane = () => store().tabs.find((tab) => tab.id === store().activeTabId)!.focusedPaneId!;
const consume = () => store().consumeRdpStartupFullscreen(activePane());

test("VNC defaults off, inherited on, legacy custom off, explicit overrides both ways", () => {
  assert.equal(defaultVncSettings.openInFullscreen, false);
  store().openConnection(connection);
  assert.equal(consume(), false);
  store().setVncSettings({ ...defaultVncSettings, openInFullscreen: true });
  for (const [options, expected] of [
    [undefined, true], [{ inheritDefaults: true, openInFullscreen: false }, true],
    [{ inheritDefaults: false }, false], [{ inheritDefaults: false, openInFullscreen: true }, true],
    [{ inheritDefaults: false, openInFullscreen: false }, false],
  ] as const) {
    store().openConnectionInNewTab({ ...connection, vncOptions: options });
    assert.equal(consume(), expected);
    assert.equal(consume(), false);
  }
});

test("settings edits and reactivation cannot re-arm a running VNC Session", () => {
  store().openConnection(connection);
  const paneId = activePane();
  store().setVncSettings({ ...defaultVncSettings, openInFullscreen: true });
  store().refreshOpenConnectionMetadata({ ...connection, vncOptions: { inheritDefaults: false, openInFullscreen: true } });
  assert.equal(store().hasRdpStartupFullscreen(paneId), false);
  store().openConnection(connection);
  assert.equal(consume(), false);
  store().closeTab(store().activeTabId);
  store().openConnection(connection);
  assert.equal(consume(), true);
});

test("VNC bulk opens, Panorama and restored layouts do not acquire launch intent", () => {
  store().setVncSettings({ ...defaultVncSettings, openInFullscreen: true });
  store().openConnection(connection, { allowRdpStartupFullscreen: false });
  assert.equal(consume(), false);
  store().openConnectionsInPanorama([{ ...connection, id: "a" }, { ...connection, id: "b" }]);
  for (const pane of store().tabs.at(-1)!.panes) assert.equal(store().hasRdpStartupFullscreen(pane.id), false);
  store().openConnectionInNewTab(connection);
  const tab = store().tabs.at(-1)!;
  assert.equal(store().hasRdpStartupFullscreen(activePane()), true);
  assert.equal(JSON.stringify(serializeLayout(tab.layout!, tab.panes)).includes("rdpStartupFullscreen"), false);
});

test("leaving and returning cancels a VNC launch before the lazy surface mounts", () => {
  store().setVncSettings({ ...defaultVncSettings, openInFullscreen: true });
  store().openConnection(connection);
  const tabId = store().activeTabId;
  store().openConnection({ ...connection, id: "other" });
  store().activateTab(tabId);
  assert.equal(consume(), false);
});
