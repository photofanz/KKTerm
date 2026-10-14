import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { SavedPasswordPromptDetector } from "../src/modules/workspace/connections/terminal/savedPasswordPrompt";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
const workspace = readFileSync("src/modules/workspace/connections/terminal/TerminalWorkspace.tsx", "utf8");
const renderer = readFileSync("src/modules/workspace/connections/terminal/renderer.ts", "utf8");
const source = ts.createSourceFile("TerminalWorkspace.tsx", workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function callbackFor(name: string) {
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)
      && (node.expression.getText(source) === name || node.arguments[0]?.getText(source) === JSON.stringify(name))) {
      const fn = node.arguments.find(ts.isArrowFunction);
      if (fn) callback = fn.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `Missing production callback ${name}`);
  return stripTypeScriptTypes(`(${callback})`);
}

// Execute the real Pane input/output/ended handlers and xterm parser. Only
// native IPC, React setters and screen geometry are doubles; this is not a
// Tauri/keychain integration test and never reads or transmits real secrets.
function harness(t: { after: (fn: () => void) => void }) {
  const detector = new SavedPasswordPromptDetector();
  let generation = 0;
  let current: ReturnType<typeof start>;
  const pickers: unknown[] = [];
  const writes: { sessionId: string; input: string }[] = [];
  const sessionIdRef = { current: "" };
  const passwordOfferPendingRef = { current: false };
  const passwordOfferSequenceRef = { current: 0 };
  function start() {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    t.after(() => terminal.dispose());
    const cursorLine = renderer.match(/  getCursorLine\(\) \{[^]*?\n  \}/)?.[0];
    assert.ok(cursorLine, "Missing renderer cursor-line reader");
    const getCursorLine = vm.runInNewContext(stripTypeScriptTypes(`({${cursorLine}})`)).getCursorLine;
    const pendingWrites: Promise<void>[] = [];
    sessionIdRef.current = `session-${++generation}`;
    const context = vm.createContext({
      disposed: false, sessionEnded: false, sessionStarted: true, acceptBells: true,
      trackConnectionSession: false,
      connection: { id: "connection", type: "ssh" }, pane: { id: "pane" },
      sessionIdRef,
      terminalConnectionStateRef: { current: "connected" },
      savedPasswordPrompt: detector, savedPasswordPromptRef: { current: detector },
      passwordOfferPendingRef, passwordOfferSequenceRef,
      isActiveRef: { current: true },
      terminalElementRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } },
      terminal: {
        getCursorLine: () => getCursorLine.call({ terminal }),
        getCursorPosition: () => ({ column: terminal.buffer.active.cursorX, row: terminal.buffer.active.cursorY }),
        getScreenGeometry: () => ({ left: 0, top: 0, cellWidth: 8, cellHeight: 16 }),
        write: (data: string, callback?: () => void) => pendingWrites.push(new Promise((resolve) => {
          terminal.write(data, () => { callback?.(); resolve(); });
        })),
      },
      useWorkspaceStore: { getState: () => ({ terminalSettings: { offerSavedPasswords: true }, syncInputEnabled: false }) },
      useTerminalAttentionStore: { getState: () => ({ clear() {} }) },
      startupState: { end() {} },
      updateTerminalConnectionState() {}, setReconnectGeneration() {},
      isTerminalPointerSequence: (input: string) => /^\x1b\[[IO]$/.test(input),
      writeWithPasteConfirmation: (input: string, write: (data: string) => void) => write(input),
      writeInputToSession: (input: string) => writes.push({ sessionId: sessionIdRef.current, input }),
      invokeCommand: async () => [],
      terminalPasswordChoices: () => [{ id: "connection", name: "Test" }],
      setPasswordPicker: (picker: unknown) => { if (picker) pickers.push(picker); },
    });
    const onInput = vm.runInContext(callbackFor("terminal.onData"), context);
    const onOutput = vm.runInContext(callbackFor("terminal-output"), context);
    const onEnded = vm.runInContext(callbackFor("terminal-session-ended"), context);
    return {
      context, terminal,
      input: (data: string) => onInput(data),
      async output(data: string, sessionId = sessionIdRef.current) {
        onOutput({ payload: { sessionId, data } });
        await Promise.all(pendingWrites.splice(0));
        await new Promise(setImmediate);
      },
      end: () => onEnded({ payload: { sessionId: sessionIdRef.current } }),
      getCursorLine: () => getCursorLine.call({ terminal }),
    };
  }
  current = start();
  return {
    pickers, writes,
    get session() { return current; },
    reconnect() { current.end(); current.context.disposed = true; current = start(); },
  };
}

for (const lifecycle of ["new Tab", "reconnect"] as const) {
  for (const command of ["sudo su -", "su -"]) {
    test(`${lifecycle}: ${command} recalled from shell history offers its saved password`, async (t) => {
      const h = harness(t);
      if (lifecycle === "reconnect") {
        h.session.input("sudo -v\r");
        await h.session.output("[sudo] password for ops: ");
        assert.equal(h.pickers.length, 1);
        h.pickers.length = 0;
        h.reconnect();
      }
      await h.session.output("ops@host:~$ ");
      h.session.input("\x1b[A");
      await h.session.output(command);
      h.session.input("\r");
      await h.session.output("\r\nPassword: ");
      assert.equal(h.pickers.length, 1);
      assert.deepEqual(h.writes.at(-1), { sessionId: lifecycle === "reconnect" ? "session-2" : "session-1", input: "\r" });
    });
  }
}

test("tmux cursor-addressed redraws detect the prompt at the cursor after rendering", async (t) => {
  const h = harness(t);
  h.reconnect();
  await h.session.output("ops@host:~$ ");
  h.session.input("sudo su -\r");
  await h.session.output("\x1b[2;1H[sudo] pass");
  assert.equal(h.pickers.length, 0);
  await h.session.output("word for ops: \x1b[24;1H[0] 0:bash*\x1b[2;26H");
  assert.equal(h.pickers.length, 1);
});

test("reconnect ignores old Session output and requires a fresh submitted command", async (t) => {
  const h = harness(t);
  h.session.input("sudo -v\r");
  h.reconnect();
  await h.session.output("Password: ", "session-1");
  await h.session.output("Password: ");
  assert.equal(h.pickers.length, 0);
  h.session.input("su -\r");
  await h.session.output("\r\nPassword: ");
  await h.session.output("\r\nPassword: ");
  assert.equal(h.pickers.length, 1);
});

test("another Tab has independent command detection and cannot use the first Tab's pending offer", async (t) => {
  const first = harness(t);
  const duplicate = harness(t);
  first.session.input("sudo -v\r");
  await duplicate.session.output("Password: ");
  assert.equal(duplicate.pickers.length, 0);
  await first.session.output("Password: ");
  assert.equal(first.pickers.length, 1);
  duplicate.session.input("sudo su -\r");
  await duplicate.session.output("\r\nPassword: ");
  assert.equal(duplicate.pickers.length, 1);
});

test("input before the render callback cancels the offer, including later redraws", async (t) => {
  const h = harness(t);
  h.session.input("sudo -v\r");
  const output = h.session.output("Password: ");
  h.session.input("manual-input");
  await output;
  await h.session.output("\x1b[1;1HPassword: ");
  assert.equal(h.pickers.length, 0);
});

test("an old credential lookup failure cannot cancel a new Session's offer", async (t) => {
  const h = harness(t);
  let rejectOld: (error: Error) => void;
  h.session.context.invokeCommand = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  h.session.input("sudo -v\r");
  await h.session.output("Password: ");
  h.reconnect();
  let resolveNew: () => void;
  const lookup = new Promise((resolve) => { resolveNew = () => resolve([]); });
  h.session.context.invokeCommand = () => lookup;
  h.session.input("sudo -v\r");
  await h.session.output("Password: ");
  rejectOld!(new Error("old lookup failed"));
  await new Promise(setImmediate);
  resolveNew!();
  await new Promise(setImmediate);
  assert.equal(h.pickers.length, 1);
});

test("history of a non-sudo command and cancelled sudo input do not offer passwords", async (t) => {
  const h = harness(t);
  await h.session.output("ops@host:~$ ");
  h.session.input("\x1b[A");
  await h.session.output("echo sudo su -");
  h.session.input("\r");
  await h.session.output("\r\nPassword: ");
  assert.equal(h.pickers.length, 0);
  h.session.input("sudo -v\r");
  h.session.input("\x03");
  await h.session.output("\r\nPassword: ");
  assert.equal(h.pickers.length, 0);
});

test("cursor line uses the live screen while scrolled back and joins wrapped prompts", async (t) => {
  const h = harness(t);
  await h.session.output("old line\r\n".repeat(30));
  const prompt = `[sudo] password for ${"operator".repeat(10)}: `;
  h.session.input("sudo -v\r");
  await h.session.output(prompt);
  h.session.terminal.scrollToTop();
  assert.equal(h.session.getCursorLine().trimEnd(), prompt.trimEnd());
  assert.equal(h.pickers.length, 1);
});
