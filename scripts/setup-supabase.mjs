// Configuración única de Supabase para U3M.
// Despliega las Edge Functions, carga los 22 productos y crea las cuentas de prueba.
// Las claves se leen SOLO de variables de entorno de tu terminal. No se guardan ni se imprimen.
//
// Variables (las defines tú en PowerShell, ver README.md):
//   SUPABASE_SERVICE_ROLE_KEY  (obligatoria) clave service_role del proyecto
//   SUPABASE_ACCESS_TOKEN      (para desplegar funciones) token de acceso del CLI de Supabase
//   U3M_TEST_ADMIN_EMAIL, U3M_TEST_CUSTOMER_EMAIL  (opcionales; por defecto, correos de prueba)
//
// Uso:  node scripts/setup-supabase.mjs [--skip-functions] [--skip-products] [--skip-accounts]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = "ncitkqnhgvemawstrhub";
const SUPABASE_URL = process.env.SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const args = new Set(process.argv.slice(2));

const FUNCTIONS = [
  { name: "admin-sign-upload" },
  { name: "admin-delete" },
  { name: "download-url" },
  { name: "paypal-create-order" },
  { name: "paypal-capture-order" },
  { name: "paypal-webhook", noVerifyJwt: true },
];

const ADMIN_EMAIL = process.env.U3M_TEST_ADMIN_EMAIL || "u3m.admin.test@example.com";
const CUSTOMER_EMAIL = process.env.U3M_TEST_CUSTOMER_EMAIL || "u3m.customer.test@example.com";

const log = (msg) => console.log(msg);
const fail = (msg) => { console.error("\nERROR: " + msg); process.exit(1); };

function headers() {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// 1) Edge Functions (CLI oficial de Supabase, vía npx)
// ---------------------------------------------------------------------------
function deployFunctions() {
  log("\n== 1/3 Edge Functions");
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    fail("Falta SUPABASE_ACCESS_TOKEN en tu terminal (token de acceso del CLI de Supabase).");
  }
  for (const f of FUNCTIONS) {
    const cliArgs = ["supabase", "functions", "deploy", f.name, "--project-ref", PROJECT_REF];
    if (f.noVerifyJwt) cliArgs.push("--no-verify-jwt");
    const r = spawnSync("npx", cliArgs, { cwd: ROOT, stdio: "inherit", shell: true, env: process.env });
    if (r.status !== 0) fail(`No se pudo desplegar ${f.name}.`);
    log(`   ok  ${f.name}${f.noVerifyJwt ? " (--no-verify-jwt, firma de PayPal en la función)" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 2) Productos originales (reutiliza el script de importación existente)
// ---------------------------------------------------------------------------
async function loadProducts() {
  log("\n== 2/3 Productos originales");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/import-legacy-products.mjs")], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, SUPABASE_URL },
  });
  if (r.status !== 0) fail("La carga de productos falló; revisa el mensaje anterior.");
  const count = await rest("products?status=eq.published&select=id", { headers: { Prefer: "count=exact" } });
  if (count.length !== 22) fail(`Se esperaban 22 productos publicados y hay ${count.length}.`);
  log(`   ok  ${count.length} productos publicados`);
}

// ---------------------------------------------------------------------------
// 3) Cuentas de prueba confirmadas y rol de administrador
// ---------------------------------------------------------------------------
async function findUserByEmail(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: headers() });
  if (!res.ok) throw new Error(`Listar usuarios: ${res.status}`);
  const body = await res.json();
  return (body.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase()) ?? null;
}

async function ensureUser(email, role) {
  const existing = await findUserByEmail(email);
  if (existing) {
    log(`   ya existe ${role}: ${email} (no se cambia su contraseña)`);
    return { id: existing.id, password: null };
  }
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: role } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Crear ${role}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  log(`   creada y confirmada: ${role} ${email}`);
  return { id: body.id, password };
}

async function grantAdmin(userId) {
  const [role] = await rest("roles?code=eq.admin&select=id");
  const existingAdmins = await rest("user_roles?role_id=eq." + role.id + "&select=user_id");
  if (existingAdmins.some((r) => r.user_id === userId)) return;
  if (existingAdmins.length > 0) {
    log("   ya hay un administrador; se mantiene. La cuenta de prueba no recibe el rol.");
    return;
  }
  // Equivalente a bootstrap_first_admin (solo válido si no hay administradores). Lo hace el servicio.
  await rest("user_roles", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, role_id: role.id }) });
  log("   rol admin asignado");
}

async function accounts() {
  log("\n== 3/3 Cuentas de prueba");
  const admin = await ensureUser(ADMIN_EMAIL, "administrador de prueba");
  const customer = await ensureUser(CUSTOMER_EMAIL, "cliente de prueba");
  await grantAdmin(admin.id);
  log("\nCREDENCIALES TEMPORALES (cópialas ahora; no se guardan):");
  log(`   Administrador: ${ADMIN_EMAIL}  contraseña: ${admin.password ?? "(ya existía; no se muestra)"}`);
  log(`   Cliente:       ${CUSTOMER_EMAIL}  contraseña: ${customer.password ?? "(ya existía; no se muestra)"}`);
}

// ---------------------------------------------------------------------------
async function main() {
  if (!KEY) fail("Falta SUPABASE_SERVICE_ROLE_KEY en tu terminal (ver README.md).");
  log(`Proyecto: ${PROJECT_REF}`);
  if (!args.has("--skip-functions")) deployFunctions();
  if (!args.has("--skip-products")) await loadProducts();
  if (!args.has("--skip-accounts")) await accounts();
  log("\nListo. Siguiente paso: scripts/publish-gh-pages.mjs (solo publica si hay 22 productos).");
}

main().catch((e) => fail(e.message ?? String(e)));
