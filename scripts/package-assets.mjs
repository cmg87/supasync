import { cp, mkdir, copyFile, chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const assets = new URL("apps/cli/dist/assets/", root);
await mkdir(assets, { recursive: true });
await cp(new URL("dist/obsidian/", root), new URL("obsidian/", assets), {
  recursive: true,
});
await cp(new URL("supabase/functions/", root), new URL("functions/", assets), {
  recursive: true,
});
await copyFile(
  new URL("supabase/migrations/20260920234554_plaintext_vault.sql", root),
  new URL("schema.sql", assets),
);
await copyFile(
  new URL("THIRD_PARTY_NOTICES.md", root),
  new URL("apps/cli/THIRD_PARTY_NOTICES.md", root),
);
await copyFile(new URL("LICENSE", root), new URL("apps/cli/LICENSE", root));
// This directory contains generated package docs only; clear obsolete versions.
await rm(new URL("apps/cli/docs/", root), { recursive: true, force: true });
await cp(new URL("docs/", root), new URL("apps/cli/docs/", root), {
  recursive: true,
});
await copyFile(new URL("README.md", root), new URL("apps/cli/README.md", root));
await chmod(new URL("apps/cli/dist/cli.js", root), 0o755);
await mkdir(new URL("development/", assets), { recursive: true });
await copyFile(
  new URL("supabase/dev-config.toml", root),
  new URL("development/config.toml", assets),
);
await cp(
  new URL("supabase/migrations/", root),
  new URL("development/migrations/", assets),
  { recursive: true },
);
await cp(
  new URL("supabase/functions/", root),
  new URL("development/functions/", assets),
  { recursive: true },
);
await copyFile(
  new URL("supabase/seed.sql", root),
  new URL("development/seed.sql", assets),
);
console.log("npm package assets:", fileURLToPath(assets));
