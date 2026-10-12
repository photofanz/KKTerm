import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultVncSettings } from "../src/app-defaults";
import { ensureI18nReady, switchLanguage } from "../src/i18n/config";
import type { Connection } from "../src/types";
const hook = registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
} });
const { VncConnectionOptions } = await import("../src/modules/workspace/connections/connection-dialog/VncConnectionFields");
const { RemoteFullscreenBar } = await import("../src/modules/workspace/connections/remote-desktop/RemoteFullscreenBar");
hook.deregister();
await ensureI18nReady();

test("VNC editor serializes the displayed inherited/explicit/legacy value", async () => {
  await switchLanguage("en");
  for (const [inherited, options, expected] of [
    [true, { inheritDefaults: true, openInFullscreen: false }, true],
    [false, { inheritDefaults: false }, false],
    [false, { inheritDefaults: false, openInFullscreen: true }, true],
    [false, { inheritDefaults: false, openInFullscreen: false }, false],
  ] as const) {
    const connection: Connection = { id: "vnc", name: "VNC", host: "example.test", user: "", type: "vnc", status: "idle", vncOptions: options };
    const html = renderToStaticMarkup(createElement(VncConnectionOptions, {
      initialConnection: connection, vncInheritsSettingsDefaults: inherited,
      onInheritsSettingsDefaultsChange: () => {}, vncSettings: { ...defaultVncSettings, openInFullscreen: true },
    }));
    const field = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes('name="vncOpenInFullscreen"'));
    assert.ok(field?.includes(`value="${expected ? "on" : ""}"`));
    assert.equal((html.match(/<option value="(?:fit|stretch|actualSize|fitWidth|fitHeight)"/g) ?? []).length, 5);
  }
});

test("fullscreen toolbar exposes distinct localized restore and disconnect buttons", async () => {
  for (const [locale, restore, disconnect] of [
    ["en", "Return to KKTerm tab", "Disconnect and close session"],
    ["zh-TW", "返回 KKTerm 分頁", "中斷連線並關閉工作階段"],
  ]) {
    await switchLanguage(locale);
    const html = renderToStaticMarkup(createElement(RemoteFullscreenBar, {
      sessionId: "synthetic", kind: "vnc", title: "VNC", onRequestRestore: () => {}, onRequestClose: () => {},
    }));
    assert.ok(html.includes(`aria-label="${restore}"`));
    assert.ok(html.includes(`aria-label="${disconnect}"`));
  }
});
