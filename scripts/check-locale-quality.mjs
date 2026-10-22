#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keep the full interpolation expression and its multiplicity, including
// escaping/format modifiers. Translators may reorder, but not rewrite tokens.
export function placeholders(value) {
  return (value.match(/\{\{[\s\S]*?\}\}/g) ?? []).sort();
}

export function checkLocaleQuality(source, target, groups = []) {
  const problems = [];
  const exceptions = new Map();
  for (const { reason, entries } of groups) {
    if (typeof reason !== "string" || !reason.trim()) {
      problems.push("Exception group needs a review reason");
    }
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (exceptions.has(key)) problems.push(`${key}: duplicate exception`);
      exceptions.set(key, value);
    }
  }
  const used = new Set();
  function visit(en, translated, key, inheritedException = false) {
    let exempt = inheritedException;
    if (exceptions.has(key)) {
      used.add(key);
      if (!isDeepStrictEqual(en, exceptions.get(key)) || !isDeepStrictEqual(en, translated)) {
        problems.push(`${key}: stale exception; re-review or remove it`);
      } else {
        exempt = true;
      }
    }
    if (typeof en === "string") {
      if (typeof translated !== "string") {
        problems.push(`${key}: expected a string`);
        return;
      }
      if (!isDeepStrictEqual(placeholders(en), placeholders(translated))) {
        problems.push(`${key}: interpolation tokens differ`);
      }
      if (en.trim() && !translated.trim()) problems.push(`${key}: empty translation`);
      // Equality is a review signal, not proof. Only reviewed key + exact value
      // exceptions suppress it; no blanket exemptions for URLs/commands/brands.
      if (!exempt && en.trim() && en.trim() === translated.trim()) {
        problems.push(`${key}: possibly untranslated (same as English)`);
      }
      return;
    }
    if (Array.isArray(en)) {
      if (!Array.isArray(translated) || en.length !== translated.length) {
        problems.push(`${key}: array shape differs`);
        return;
      }
      en.forEach((value, index) => visit(value, translated[index], `${key}[${index}]`, exempt));
      return;
    }
    if (en !== null && typeof en === "object") {
      if (translated === null || typeof translated !== "object" || Array.isArray(translated)) {
        problems.push(`${key}: expected an object`);
        return;
      }
      for (const [child, value] of Object.entries(en)) {
        visit(value, translated[child], key ? `${key}.${child}` : child, exempt);
      }
      for (const child of Object.keys(translated)) {
        if (!Object.hasOwn(en, child)) problems.push(`${key}.${child}: redundant key`);
      }
      return;
    }
    if (!isDeepStrictEqual(en, translated)) problems.push(`${key}: non-string value differs`);
  }
  visit(source, target, "");
  for (const key of exceptions.keys()) {
    if (!used.has(key)) problems.push(`${key}: exception key does not exist`);
  }
  return problems;
}

export async function checkLocaleFiles(locale = "vi") {
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) || locale === "en") {
    throw new Error(`Invalid target locale: ${locale}`);
  }
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const [source, target, policy] = await Promise.all([
    readJson("src/i18n/locales/en.json"),
    readJson(`src/i18n/locales/${locale}.json`),
    readJson("scripts/locale-quality-exceptions.json"),
  ]);
  return checkLocaleQuality(source, target, policy[locale] ?? []);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const locale = process.argv[2] ?? "vi";
  const problems = await checkLocaleFiles(locale);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`${locale}: ${problems.length} locale quality issue(s) need review.`);
    process.exitCode = 1;
  } else {
    console.log(`${locale}: locale quality OK (values, array shapes, interpolation, reviewed English exceptions).`);
  }
}
