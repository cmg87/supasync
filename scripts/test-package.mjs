import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Extract outside the monorepo: workspace dependencies must not hide packaging errors.
const temporary = await mkdtemp(join(tmpdir(), "supasync-package-test-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--workspace",
        "supasync",
        "--pack-destination",
        resolve("dist"),
        "--json",
      ],
      { encoding: "utf8" },
    ),
  )[0];
  const paths = packed.files.map((f) => f.path);
  for (const required of [
    "dist/cli.js",
    "dist/assets/schema.sql",
    "dist/assets/obsidian/main.js",
    "dist/assets/functions/supasync-binary/index.ts",
  ])
    assert.ok(paths.includes(required), required);
  assert.ok(
    !paths.some((p) =>
      /daemon|crypto\/|\.env$|hermes\.json|data\.json|V2-IMPLEMENTATION|RECOVERY/.test(
        p,
      ),
    ),
  );
  const archive = resolve("dist", packed.filename);
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const cli = join(temporary, "package", "dist", "cli.js");
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], {
      cwd: temporary,
      encoding: "utf8",
    }).trim(),
    "0.3.0",
  );
  const help = execFileSync(process.execPath, [cli, "--help"], {
    cwd: temporary,
    encoding: "utf8",
  });
  assert.ok(help.includes("PostgreSQL"));
  const plugin = await readFile(
    join(temporary, "package", "dist", "assets", "obsidian", "main.js"),
    "utf8",
  );
  assert.ok(
    !/require\(["'](?:node:|fs["']|path["']|crypto["']|child_process["'])/.test(
      plugin,
    ),
    "plugin contains a Node runtime import",
  );
  const manifest = JSON.parse(
    await readFile(
      join(temporary, "package", "dist", "assets", "obsidian", "manifest.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.isDesktopOnly, false);
  console.log(
    `Standalone CLI and mobile-compatible plugin package verified: ${archive}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
