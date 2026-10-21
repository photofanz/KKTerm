import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { checkLocaleFiles, checkLocaleQuality } from "../scripts/check-locale-quality.mjs";

const check = checkLocaleQuality;

test("flags English sentences, single-word controls and array items", () => {
  const en = { reset: "Reset panel widths.", save: "Save", examples: ["Create a widget"] };
  const problems = check(en, structuredClone(en));
  assert.equal(problems.length, 3);
  assert.match(problems[2], /examples\[0\]: possibly untranslated/);
  assert.equal(check({ save: "Save" }, { save: " Save " }).length, 1);
});

test("retains reviewed commands, brands, URLs and native names without broad exemptions", () => {
  const entries = { command: "kubectl apply", brand: "Claude Code", url: "https://example.com", language: "Tiếng Việt" };
  const policy = [{ reason: "Reviewed literal identifiers", entries }];
  assert.deepEqual(check(entries, entries, policy), []);
  assert.match(check({ ...entries, instruction: "Run kubectl apply" }, { ...entries, instruction: "Run kubectl apply" }, policy)[0], /instruction: possibly untranslated/);
});

test("exceptions are bound to both key and exact source value and cannot silently go stale", () => {
  const policy = [{ reason: "Protocol", entries: { ssh: "SSH" } }];
  assert.match(check({ ssh: "SSH settings" }, { ssh: "SSH settings" }, policy).join("\n"), /stale exception/);
  assert.match(check({ ssh: "SSH" }, { ssh: "Cài đặt SSH" }, policy)[0], /stale exception/);
  assert.match(check({}, {}, policy)[0], /does not exist/);
  assert.match(check({ ssh: "SSH" }, { ssh: "SSH" }, [{ reason: "", entries: { ssh: "SSH" } }])[0], /reason/);
  assert.match(check({ ssh: "SSH" }, { ssh: "SSH" }, [...policy, ...policy])[0], /duplicate exception/);
});

test("preserves placeholder names, counts, formatting and escaping while allowing reordering", () => {
  const en = { text: "{{- name}} has {{count, number}} items for {{name}}: {{name}}" };
  assert.deepEqual(check(en, { text: "{{name}}: {{name}} có {{count, number}} mục cho {{- name}}" }), []);
  for (const text of [
    "{{- ten}} có {{count, number}} mục cho {{name}}: {{name}}",
    "{{- name}} có {{count, number}} mục cho {{name}}",
    "{{name}} có {{count, number}} mục cho {{name}}: {{name}}",
    "{{- name}} có {{count}} mục cho {{name}}: {{name}}",
  ]) assert.match(check(en, { text }).join("\n"), /interpolation tokens differ/);
});

test("validates missing values, types, empty translations and array lengths", () => {
  assert.match(check({ a: "Hello" }, {})[0], /expected a string/);
  assert.match(check({ a: "Hello" }, { a: " " })[0], /empty translation/);
  assert.match(check({ a: { b: "Hello" } }, { a: [] })[0], /expected an object/);
  assert.match(check({ a: ["Hello"] }, { a: [] })[0], /array shape differs/);
  assert.match(check({ a: ["Hello"] }, { a: "Xin chào" })[0], /array shape differs/);
  assert.match(check({}, { extra: "Xin chào" })[0], /redundant key/);
});

test("creative-label arrays require an exact reviewed set, and new labels trigger review", () => {
  const en = { labels: ["Orion", "Comet"] };
  const policy = [{ reason: "Shared creative identifiers", entries: { labels: en.labels } }];
  assert.deepEqual(check(en, en, policy), []);
  const changed = { labels: ["Orion", "Comet", "New label"] };
  assert.match(check(changed, changed, policy).join("\n"), /stale exception/);
});

test("Vietnamese bundle passes value, interpolation and array compatibility checks", async () => {
  assert.deepEqual(await checkLocaleFiles("vi"), []);
  const en = JSON.parse(await readFile(new URL("../src/i18n/locales/en.json", import.meta.url), "utf8"));
  const vi = JSON.parse(await readFile(new URL("../src/i18n/locales/vi.json", import.meta.url), "utf8"));
  assert.notEqual(vi.settings.resetLayoutDescription, en.settings.resetLayoutDescription);
  assert.notEqual(vi.settings.defaultSshPortRange, en.settings.defaultSshPortRange);
  assert.notEqual(vi.common.save, en.common.save);
  assert.equal(vi.ai.waitingPhrases.length, en.ai.waitingPhrases.length);
  assert.deepEqual(vi.ai.tmuxSessionLabels, en.ai.tmuxSessionLabels);
  // These intentionally executable examples must remain byte-for-byte intact.
  assert.equal(vi.connections.sshStartupScriptPlaceholder, en.connections.sshStartupScriptPlaceholder);
  assert.equal(vi.settings.mcpPastePlaceholder, en.settings.mcpPastePlaceholder);
  assert.equal(vi.settings.customShellCommandLinePlaceholder, en.settings.customShellCommandLinePlaceholder);
  const regressed = structuredClone(vi);
  regressed.settings.resetLayoutDescription = en.settings.resetLayoutDescription;
  assert.match(check(en, regressed).join("\n"), /settings.resetLayoutDescription: possibly untranslated/);
});

test("all locale keys and their order remain compatible with English", () => {
  const result = spawnSync(process.execPath, [new URL("../scripts/check-locale-keys.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("i18next renders Vietnamese interpolation and array resources without falling back", async () => {
  const { createInstance } = await import("i18next");
  const en = JSON.parse(await readFile(new URL("../src/i18n/locales/en.json", import.meta.url), "utf8"));
  const vi = JSON.parse(await readFile(new URL("../src/i18n/locales/vi.json", import.meta.url), "utf8"));
  const i18n = createInstance();
  await i18n.init({ lng: "vi", fallbackLng: "en", resources: { en: { translation: en }, vi: { translation: vi } }, interpolation: { escapeValue: false } });
  assert.equal(i18n.t("settings.sshKeyGenerated", { privateKeyPath: "C:\\keys\\id", publicKeyPath: "C:\\keys\\id.pub" }), "Đã tạo khóa SSH. Khóa riêng: C:\\keys\\id Khóa công khai: C:\\keys\\id.pub");
  assert.equal(i18n.t("connections.import.previewHeading", { selected: 2, count: 5 }), "Đã chọn 2 trong tổng số 5");
  assert.equal(i18n.t("settings.urlPasswordDetails", { username: "admin", updatedAt: "2026-10-22" }), "Tên người dùng: admin · Cập nhật: 2026-10-22");
  assert.equal(i18n.t("terminal.pasteMultilineConfirm"), vi.terminal.pasteMultilineConfirm);
  assert.deepEqual(i18n.t("ai.waitingPhrases", { returnObjects: true }), vi.ai.waitingPhrases);
  await i18n.changeLanguage("en");
  assert.equal(i18n.t("common.save"), "Save");
  await i18n.changeLanguage("vi");
  assert.equal(i18n.t("common.save"), "Lưu");
});
