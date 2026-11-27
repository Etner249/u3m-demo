// Publica la versión de producción en gh-pages con comprobaciones automáticas.
// - No publica si no hay 22 productos publicados ni si PayPal está activado.
// - Nunca fuerza el push: un avance normal sobre gh-pages. El respaldo no se toca.
// Uso: node scripts/publish-gh-pages.mjs [--dry-run]
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = "ncitkqnhgvemawstrhub";
const BASE = `https://${PROJECT_REF}.supabase.co/rest/v1`;
const PUBLIC_KEY = "sb_publishable_5TCys0ypAs6wNiNHtqZnQg__j5PJeLo"; // clave publicable, pública por diseño
const BACKUP = "backup/gh-pages-2026-11-27";
const PUBLIC_URL = "https://etner249.github.io/u3m-demo/";
const dryRun = process.argv.includes("--dry-run");

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", ...opts }).trim();
const fail = (m) => { console.error("\nNO PUBLICADO: " + m); process.exit(1); };

// 1) Compuertas
const pm = await fetch(`${BASE}/settings?key=eq.payment_methods&select=value`, { headers: { apikey: PUBLIC_KEY } }).then((r) => r.json());
if (pm?.[0]?.value?.paypal !== false) fail("PayPal está activado. Debe permanecer desactivado hasta tener credenciales.");
const prods = await fetch(`${BASE}/products?status=eq.published&select=id`, { headers: { apikey: PUBLIC_KEY, Prefer: "count=exact", Range: "0-99" } });
const total = Number((prods.headers.get("content-range") ?? "*/0").split("/")[1]);
if (total !== 22) fail(`Hay ${total} productos publicados; se requieren 22.`);
sh(`git rev-parse --verify --quiet origin/${BACKUP} || git rev-parse --verify --quiet ${BACKUP}`, { quiet: true });
console.log(`ok  PayPal desactivado · Yape en modo manual · ${total} productos publicados`);

// 2) Versión de producción a partir de la rama de trabajo (HEAD) + team/ del respaldo
sh("git fetch -q origin gh-pages");
const tmp = mkdtempSync(join(tmpdir(), "u3m-gh-pages-"));
try {
  sh(`git worktree add --detach "${tmp}" origin/gh-pages`);
  sh(`git -C "${tmp}" rm -r -q --ignore-unmatch .`);
  sh(`git archive HEAD index.html assets admin covers logo.png .nojekyll | tar -x -C "${tmp}"`);
  sh(`git archive origin/gh-pages team | tar -x -C "${tmp}"`);
  sh(`git -C "${tmp}" add -A`);
  const changed = sh(`git -C "${tmp}" status --porcelain`, { quiet: true });
  if (!changed) { console.log("Nada que publicar: gh-pages ya tiene esta versión."); process.exit(0); }
  sh(`git -C "${tmp}" -c user.name="U3M Developer" -c user.email="dev@u3m.example" commit -q -m "deploy: production build of U3M store and admin"`);
  const sha = sh(`git -C "${tmp}" rev-parse --short HEAD`, { quiet: true });
  if (dryRun) {
    console.log(`DRY RUN: se publicaría ${sha} en gh-pages (sin push).`);
  } else {
    sh(`git -C "${tmp}" push origin HEAD:refs/heads/gh-pages`); // avance normal, sin --force
    console.log(`Publicado ${sha} en gh-pages.`);
  }
} finally {
  try { sh(`git worktree remove --force "${tmp}"`, { quiet: true }); } catch { /* ignorar */ }
  rmSync(tmp, { recursive: true, force: true });
}

// 3) Verificación en Internet
if (!dryRun) {
  for (const path of ["", "admin/"]) {
    const res = await fetch(PUBLIC_URL + path, { cache: "no-store" });
    console.log(`${res.status === 200 ? "ok " : "ERR"} ${PUBLIC_URL + path} → ${res.status}`);
  }
}
