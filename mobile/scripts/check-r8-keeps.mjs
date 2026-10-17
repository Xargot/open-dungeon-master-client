// What R8 must leave alone in a release APK, checked in the APK's own dex
// with the SDK's dexdump. Capacitor reaches the plugins by reflection: each
// plugin class by name, each @PluginMethod, @ActivityCallback and
// @PermissionCallback method by name, and the plugin's @CapacitorPlugin
// through the field PluginHandle keeps it in. Debug builds and unit tests
// never minify, so only a release APK shows R8 dropping one of them; it did
// once (proguard-rules.pro: the permission calls compiled to "throw null").
//
//   node mobile/scripts/check-r8-keeps.mjs [release apk]
//
// The plugins are the ones MainActivity registers and the ones `cap sync`
// listed in assets/capacitor.plugins.json, whose sources are read from
// node_modules for their annotated methods.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(mobile, "android", "app");
const ownSources = path.join(appDir, "src", "main", "java");

function fail(message) {
  console.error(`[check-r8-keeps] ${message}`);
  process.exit(1);
}

function releaseApk() {
  const given = process.argv[2];
  if (given) return path.resolve(given);
  const dir = path.join(appDir, "build", "outputs", "apk", "release");
  const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".apk")).sort() : [];
  if (!found.length) fail(`no release APK in ${dir}; run ./gradlew assembleRelease first`);
  return path.join(dir, found[0]);
}

function dexdumpBinary() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "Android", "Sdk");
  const tools = path.join(sdk, "build-tools");
  const versions = fs.existsSync(tools) ? fs.readdirSync(tools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  for (const version of versions) {
    const binary = path.join(tools, version, process.platform === "win32" ? "dexdump.exe" : "dexdump");
    if (fs.existsSync(binary)) return binary;
  }
  fail(`no dexdump under ${tools}`);
}

// Class name -> { methods, fieldTypes } for every class in the APK's dex.
function dexClasses(apk) {
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "odm-dex-"));
  try {
    execFileSync("unzip", ["-q", "-o", apk, "classes*.dex", "-d", unpacked]);
    const dexes = fs.readdirSync(unpacked).filter((name) => /^classes\d*\.dex$/.test(name));
    if (!dexes.length) fail(`${apk} holds no dex`);
    const classes = new Map();
    for (const dex of dexes) {
      const text = execFileSync(dexdumpBinary(), [path.join(unpacked, dex)], { maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" });
      let current = null;
      let section = "";
      let lastName = "";
      for (const line of text.split("\n")) {
        const descriptor = /^\s*Class descriptor\s*:\s*'L(.+);'/.exec(line);
        if (descriptor) {
          current = { methods: new Set(), fieldTypes: new Set() };
          classes.set(descriptor[1].replaceAll("/", "."), current);
          continue;
        }
        if (!current) continue;
        const heading = /^\s*(Static fields|Instance fields|Direct methods|Virtual methods)\s*-/.exec(line);
        if (heading) {
          section = heading[1];
          continue;
        }
        const name = /^\s*name\s*:\s*'(.+)'/.exec(line);
        if (name) {
          lastName = name[1];
          if (section.endsWith("methods")) current.methods.add(lastName);
          continue;
        }
        const type = /^\s*type\s*:\s*'(.+)'/.exec(line);
        if (type && section.endsWith("fields")) current.fieldTypes.add(type[1]);
      }
    }
    return classes;
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
}

function sourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(java|kt)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// The methods the bridge calls by name, from a plugin's own source.
const ANNOTATED = /@(PluginMethod|ActivityCallback|PermissionCallback)\b(?:\([^)]*\))?\s+(?:(?:public|private|protected|internal|override|open|suspend|final)\s+)*(?:void\s+|fun\s+)(\w+)/g;

function annotatedMethods(file) {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(ANNOTATED)].map((match) => match[2]);
}

function pluginSources() {
  const plugins = new Map();
  const main = fs.readFileSync(path.join(ownSources, "com", "opendungeonmaster", "app", "MainActivity.java"), "utf8");
  for (const [, simple] of main.matchAll(/registerPlugin\((\w+)\.class\)/g)) {
    plugins.set(`com.opendungeonmaster.app.${simple}`, path.join(ownSources, "com", "opendungeonmaster", "app", `${simple}.java`));
  }
  const listed = path.join(appDir, "src", "main", "assets", "capacitor.plugins.json");
  if (!fs.existsSync(listed)) fail(`${listed} is missing; run npm run sync in mobile/ first`);
  for (const { pkg, classpath } of JSON.parse(fs.readFileSync(listed, "utf8"))) {
    const simple = classpath.slice(classpath.lastIndexOf(".") + 1);
    // By the class it declares: a Kotlin file need not be named after it.
    const declares = new RegExp(`\\bclass\\s+${simple}\\b`);
    const file = sourceFiles(path.join(mobile, "node_modules", pkg, "android", "src", "main")).find((candidate) =>
      declares.test(fs.readFileSync(candidate, "utf8")),
    );
    if (!file) fail(`no source for ${classpath} in node_modules/${pkg}`);
    plugins.set(classpath, file);
  }
  return plugins;
}

const apk = releaseApk();
const classes = dexClasses(apk);
const problems = [];
let methods = 0;
for (const [classpath, file] of pluginSources()) {
  const kept = classes.get(classpath);
  if (!kept) {
    problems.push(`${classpath} is not in the dex by that name`);
    continue;
  }
  for (const method of annotatedMethods(file)) {
    methods += 1;
    if (!kept.methods.has(method)) problems.push(`${classpath}.${method} is not in the dex by that name`);
  }
}
const handle = classes.get("com.getcapacitor.PluginHandle");
if (!handle) problems.push("com.getcapacitor.PluginHandle is not in the dex");
else if (!handle.fieldTypes.has("Lcom/getcapacitor/annotation/CapacitorPlugin;")) {
  problems.push("com.getcapacitor.PluginHandle lost its @CapacitorPlugin field: every permission call would throw");
}
if (problems.length) fail(`${path.basename(apk)}:\n  ${problems.join("\n  ")}`);
console.log(`${path.basename(apk)}: every plugin class and its ${methods} bridge methods kept by name, PluginHandle whole`);
