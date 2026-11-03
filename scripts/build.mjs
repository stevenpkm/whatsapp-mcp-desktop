// Builds the one file a person installs: dist/whatsapp-mcp-desktop.mcpb.
// Everything is bundled into two plain JS files with no native parts, so the
// same file works on Windows and Mac and nobody runs npm install.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stage = "dist/stage";
rmSync("dist", { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

const result = await build({
  entryPoints: { index: "src/index.ts", helper: "src/helper.ts" },
  loader: { ".woff2": "base64" },
  outdir: join(stage, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none",
  metafile: true,
  // Baileys only uses these when it SENDS pictures or link previews. We never send.
  external: ["sharp", "jimp", "link-preview-js", "qrcode-terminal", "pino-pretty", "audio-decode"],
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  logLevel: "warning",
});

// The bundle carries other people's code, so it carries their licenses too:
// one section per package that ended up inside, plus the font and the icons.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.replace(/\\/g, "/").match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (m && !packages.has(m[2])) packages.set(m[2], m[1]);
}
const licenseText = (dir) => {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
};
const sections = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return `## ${name} ${pkg.version}\nLicense: ${pkg.license || "see below"}\n\n${licenseText(dir) || `(no license file in the package; see ${pkg.homepage || pkg.repository?.url || "its npm page"})`}`;
});
sections.push(`## Manrope font\n\n${readFileSync("assets/manrope-OFL.txt", "utf8").trim()}`);
sections.push(`## Lucide icons (some paths, inline)\n\n${readFileSync("assets/lucide-LICENSE.txt", "utf8").trim()}`);
writeFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), `Third-party software inside this package\n\n${sections.join("\n\n---\n\n")}\n`);

copyFileSync("manifest.json", join(stage, "manifest.json"));
copyFileSync("LICENSE", join(stage, "LICENSE"));
if (!existsSync(join(stage, "THIRD_PARTY_NOTICES.txt"))) process.exit(1);

const r = spawnSync(process.execPath, ["node_modules/@anthropic-ai/mcpb/dist/cli/cli.js", "pack", stage, "dist/whatsapp-mcp-desktop.mcpb"], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
