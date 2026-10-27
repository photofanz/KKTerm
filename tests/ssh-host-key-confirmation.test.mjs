import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/modules/workspace/connections/utils.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.slice(source.indexOf("async function confirmTrustedSshHostKey(")), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function setup(autoTrust = false) {
  let listener, finishDialog, disposed = false;
  const replies = [], dialogs = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    listen: async (_, callback) => { listener = callback; return () => {}; },
    invokeCommand: async (name, args) => { replies.push({ name, ...args }); },
    confirmNativeDialog: (message, options) => {
      dialogs.push({ message, options });
      return new Promise((resolve) => { finishDialog = resolve; });
    },
    i18next: { t: (key) => key },
  });
  const handler = await exports.listenForSshHostKey("session", { autoTrustNewHostKeys: autoTrust }, () => disposed);
  return {
    handler, replies, dialogs,
    dispose: () => { disposed = true; handler.cancel(); },
    answer: (value) => finishDialog(value),
    emit: (status, requestId = "request", sessionId = "session") => listener({ payload: {
      requestId, sessionId, preview: { status, host: "host", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:test" },
    } }),
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("unknown key waits for confirmation; auto-trust applies only to unknown keys", async () => {
  const manual = await setup();
  manual.emit("unknown");
  assert.equal(manual.replies.length, 0);
  assert.equal(manual.dialogs.length, 1);
  manual.answer(true);
  await flush();
  assert.equal(manual.replies[0].accept, true);
  assert.equal(manual.replies[0].replace, false);
  const automatic = await setup(true);
  automatic.emit("unknown");
  await flush();
  assert.equal(automatic.dialogs.length, 0);
  assert.equal(automatic.replies[0].accept, true);
  automatic.emit("changed", "changed");
  assert.equal(automatic.dialogs.length, 1);
  assert.equal(automatic.replies.length, 1);
  automatic.answer(true);
  await flush();
  assert.equal(automatic.replies[1].replace, true);
});

test("reject, cancel, disposed late events and unrelated sessions cannot authorize trust", async () => {
  const h = await setup();
  h.emit("unknown", "other", "other-session");
  assert.equal(h.dialogs.length, 0);
  h.emit("changed", "reject");
  h.answer(false);
  await flush();
  assert.equal(h.replies[0].accept, false);
  h.emit("unknown", "cancel");
  h.dispose();
  h.answer(true);
  await flush();
  assert.equal(h.replies.length, 2, "late approval must not send a second response");
  assert.equal(h.replies[1].accept, false);
  h.emit("unknown", "late");
  await flush();
  assert.equal(h.replies[2].accept, false);
  assert.ok(h.replies.every((r) => r.name === "respond_ssh_host_key"), "frontend cannot independently persist a key");
});

test("all interactive SSH entry points subscribe before startup without a probe", async () => {
  for (const file of ["terminal/TerminalWorkspace.tsx", "sftp/SftpWorkspace.tsx", "ConnectionSidebar.tsx"]) {
    const text = await readFile(new URL(`../src/modules/workspace/connections/${file}`, import.meta.url), "utf8");
    assert.ok(text.includes("await listenForSshHostKey("));
    assert.ok(!text.includes("inspect_ssh_host_key"));
  }
  const sftp = await readFile(new URL("../src/modules/workspace/connections/sftp/SftpWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(sftp.includes("!/^failed to (resolve|list) SFTP directory:/.test(message)"), "path fallback must not retry failed trust/auth");
});
