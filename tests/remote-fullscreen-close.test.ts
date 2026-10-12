import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRemoteFullscreenClose } from "../src/modules/workspace/connections/remote-desktop/remoteFullscreenClose";

for (const restore of [true, false]) {
  test(`${restore ? "restore preserves" : "X disconnects"} exactly once after ownership handoff`, async () => {
    const calls: string[] = [];
    let release!: () => void;
    const handoff = new Promise<void>((resolve) => { release = resolve; });
    const close = createRemoteFullscreenClose({
      announceInactive: async () => { calls.push("inactive"); await handoff; },
      restore: async () => { calls.push("restore"); },
      disconnect: async () => { calls.push("disconnect"); },
      onFailure: async () => { assert.fail("unexpected failure"); },
    });
    const first = close(restore);
    await close(!restore);
    assert.deepEqual(calls, ["inactive"]);
    release(); await first; await close(restore);
    assert.deepEqual(calls, ["inactive", restore ? "restore" : "disconnect"]);
  });
}

test("failed native close restores ownership and allows retry without an unhandled rejection", async () => {
  let attempts = 0; const calls: string[] = [];
  const close = createRemoteFullscreenClose({
    announceInactive: async () => { calls.push("inactive"); },
    restore: async () => { if (++attempts === 1) throw Error("native failure"); calls.push("restored"); },
    disconnect: async () => assert.fail("must not disconnect"),
    onFailure: async (error) => { assert.match(String(error), /native failure/); calls.push("active"); },
  });
  await close(true); await close(true);
  assert.deepEqual(calls, ["inactive", "active", "inactive", "restored"]);
});

test("native dismissal notifies the Session owner once; restore bypasses user close and releases frames", async () => {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const native = await read("src-tauri/src/remote_fullscreen.rs");
  assert.match(native, /WindowEvent::CloseRequested[\s\S]*?close_reported.swap\(true[\s\S]*?emit\("remote-fullscreen-closed"/);
  assert.doesNotMatch(native, /prevent_close/);
  assert.match(native, /WindowEvent::Destroyed if is_vnc[\s\S]*?"active": false/);
  assert.match(native, /fn close_remote_fullscreen_window[\s\S]*?"active": false[\s\S]*?\.destroy\(\)/);
  const workspace = await read("src/modules/workspace/connections/remote-desktop/RemoteDesktopWorkspace.tsx");
  assert.match(workspace, /sessionId !== sessionIdRef.current \|\| handledSession === sessionId/);
  assert.match(workspace, /handledSession = sessionId;[\s\S]*?resetVncSessionRefs\(\);[\s\S]*?"close_vnc_session"[\s\S]*?fullscreenCloseRef.current\?\.\(\)/);
  assert.match(workspace, /resetVncSessionRefs = \(\) => \{[\s\S]*?consumeRdpStartupFullscreen[\s\S]*?closeRemoteFullscreen/);
  assert.match(workspace, /sessionIdRef.current !== sessionId \|\| !sessionStartedRef.current[\s\S]*?closeRemoteFullscreen\(sessionId\)/);
  const permissions = (await read("src-tauri/permissions/main.toml")).split('identifier = "remote-fullscreen-commands"')[1];
  assert.match(permissions, /"close_remote_fullscreen_window"/);
});
