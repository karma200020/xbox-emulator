import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const outdir = new URL("./dist/", import.meta.url);
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    "service-worker": "src/service-worker.ts",
    content: "src/content.ts",
    "main-gamepad": "src/main-gamepad.ts",
    popup: "src/popup.ts",
    options: "src/options.ts",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: true,
  legalComments: "none",
});

for (const file of ["manifest.json", "popup.html", "popup.css", "options.html", "options.css"]) {
  await cp(new URL(file, import.meta.url), new URL(file, outdir));
}
