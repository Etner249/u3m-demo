// Pruebas de las migraciones de U3M sobre PostgreSQL real (PGlite, en memoria).
// NO se conecta a Supabase. Aplica 0001 → 0002 → 0003 sobre stubs mínimos de auth y storage
// que replican lo que Supabase provee, y ejecuta los escenarios de seguridad y negocio.
// Uso: npm --prefix scripts install && node scripts/test-migrations.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = join(ROOT, "supabase/migrations");

// Stubs de Supabase (roles, auth, storage). No forman parte de la migración.
const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, last_sign_in_at timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets(id text primary key, name text, public boolean default false, file_size_limit bigint);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/') $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// Ejecuta una acción esperando error; devuelve el mensaje o null si no hubo error.
async function errorOf(fn) {
  try { await fn(); return null; } catch (e) { return String(e.message ?? e); }
}

const db = new PGlite();
await db.exec(STUBS);

// 0001 se aplica tal cual; quitamos solo la extensión pgcrypto (no necesaria en PG16: gen_random_uuid es nativo).
const sql0001 = (await readFile(join(MIG, "20261127000000_init.sql"), "utf8"))
  .replace("create extension if not exists pgcrypto;", "");
await db.exec(sql0001);
await db.exec(await readFile(join(MIG, "20261127010000_admin_checkout.sql"), "utf8"));
await db.exec(await readFile(join(MIG, "20261127020000_cms.sql"), "utf8"));
check("Migraciones 0001, 0002 y 0003 aplicadas en orden", true);

// Identidad de sesión: cambia el rol y el JWT simulado.
async function as(uid, role) {
  const claim = uid ? `'${uid}'` : "''";
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', ${claim}, false);` +
    (role === "postgres" ? "" : ` set role ${role};`));
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0];

// ---------------------------------------------------------------------------
// Datos de prueba (solo en esta base en memoria)
// ---------------------------------------------------------------------------
const ADMIN = "00000000-0000-0000-0000-00000000000a";
const BUYER = "00000000-0000-0000-0000-00000000000b";
const OTHER = "00000000-0000-0000-0000-00000000000c";
const LATE = "00000000-0000-0000-0000-00000000000d";
await db.exec(`
  insert into auth.users (id, email) values
    ('${ADMIN}', 'admin-prueba@test.local'), ('${BUYER}', 'comprador@test.local'),
    ('${OTHER}', 'otro@test.local'), ('${LATE}', 'tardio@test.local');
  select public.bootstrap_first_admin('admin-prueba@test.local');
  insert into public.categories (slug, name, is_active) values ('drum-kits', 'Drum Kits', true), ('oculta', 'Oculta', false);
  insert into public.products (id, type, slug, title, price_cents, status, published_at) values
    ('00000000-0000-0000-0000-0000000000f1', 'drum_kit', 'kit-prueba', 'Kit de prueba', 2500, 'published', now()),
    ('00000000-0000-0000-0000-0000000000f2', 'sample_pack', 'exclusivo', 'Exclusivo', 9900, 'published', now()),
    ('00000000-0000-0000-0000-0000000000f3', 'beat', 'beat-prueba', 'Beat prueba', 1500, 'published', now());
`);
const PID = (n) => `00000000-0000-0000-0000-0000000000f${n}`;
const basic = await scalar("select id from public.license_types where code = 'basic_mp3'");
const exclusive = await scalar("select id from public.license_types where code = 'exclusive'");
await db.exec(`
  insert into public.product_licenses (product_id, license_type_id, price_cents, is_available, max_sales) values
    ('${PID(1)}', '${basic}', 2500, true, null),
    ('${PID(3)}', '${basic}', 1500, true, null),
    ('${PID(2)}', '${exclusive}', 9900, true, 1);
  insert into public.product_files (product_id, kind, bucket, storage_path, mime_type, size_bytes) values
    ('${PID(1)}', 'user_manual', 'product-private', 'p1/manual.pdf', 'application/pdf', 1000),
    ('${PID(1)}', 'kit_archive', 'product-private', 'p1/kit.zip', 'application/zip', 1000),
    ('${PID(1)}', 'original_mp3', 'product-private', 'p1/original.mp3', 'audio/mpeg', 1000);
`);
const fileOf = async (kind) => scalar("select id from public.product_files where kind = $1", [kind]);
const MANUAL = await fileOf("user_manual");
const KIT = await fileOf("kit_archive");
const MP3 = await fileOf("original_mp3");

// Pedido pagado de BUYER sobre PID(1) con licencia básica, mediante el flujo PayPal real.
async function buyAndPay({ user, product, paypalId, cents, currency = "USD", amount }) {
  await as(user, "authenticated");
  await db.exec(`delete from public.cart_items where user_id = '${user}'`);
  await db.exec(`insert into public.cart_items (user_id, product_id, license_type_id) values ('${user}', '${product}', '${basic}')`);
  const order = await scalar("select public.create_order_from_cart(null)");
  await as(null, "postgres");
  await db.exec(`select public.register_paypal_attempt('${order}', '${user}', '${paypalId}')`);
  const res = await scalar(`select public.fulfill_paypal_order('${paypalId}', 'CAP-${paypalId}', $1, $2, '{}'::jsonb)`,
    [amount ?? cents, currency]);
  return { order, res };
}

// ---------------------------------------------------------------------------
// 1) Descargas: sin compra, con compra, admin y anónimo
// ---------------------------------------------------------------------------
await as(OTHER, "authenticated");
check("Descarga DOC sin compra: denegada (usuario autenticado sin licencia)",
  (await scalar("select public.user_can_download($1)", [MANUAL])) === false);
check("Descarga de original sin compra: denegada",
  (await scalar("select public.user_can_download($1)", [MP3])) === false);

const buy1 = await buyAndPay({ user: BUYER, product: PID(1), paypalId: "PPAYOK1", cents: 2500 });
check("Pago PayPal con monto correcto: estado 'paid'", buy1.res?.status === "paid", JSON.stringify(buy1.res));

await as(BUYER, "authenticated");
check("Descarga DOC con compra: permitida", (await scalar("select public.user_can_download($1)", [MANUAL])) === true);
check("Descarga MP3 con licencia básica: permitida", (await scalar("select public.user_can_download($1)", [MP3])) === true);
check("Descarga KIT con licencia básica (formato no incluido): denegada",
  (await scalar("select public.user_can_download($1)", [KIT])) === false);

await as(ADMIN, "authenticated");
check("Admin: descarga de cualquier archivo privado permitida", (await scalar("select public.user_can_download($1)", [KIT])) === true);

await as(null, "anon");
check("Anónimo: no puede ejecutar user_can_download",
  (await errorOf(() => db.query("select public.user_can_download($1)", [MANUAL]))) !== null);

// ---------------------------------------------------------------------------
// 2) PayPal: correcto, duplicado, monto incorrecto (revisión persistente)
// ---------------------------------------------------------------------------
await as(null, "postgres");
const dup = await scalar("select public.fulfill_paypal_order('PPAYOK1', 'CAP-PPAYOK1', 2500, 'USD', '{}'::jsonb)");
check("PayPal duplicado: no emite de nuevo (status paid, duplicate)", dup?.duplicate === true, JSON.stringify(dup));

const buyBad = await buyAndPay({ user: BUYER, product: PID(3), paypalId: "PPBAD1", cents: 1500, amount: 1499 });
check("PayPal con monto incorrecto: NO lanza error y devuelve manual_review",
  buyBad.res?.status === "manual_review" && buyBad.res?.reason === "amount_mismatch", JSON.stringify(buyBad.res));
const badPay = await q("select status, raw_event->>'reason' as reason from public.payments where provider_ref = 'PPBAD1'");
check("Pago con monto incorrecto persistido en revisión (no revertido)",
  badPay[0]?.status === "manual_review" && badPay[0]?.reason === "amount_mismatch", JSON.stringify(badPay));
const badOrder = await q("select status from public.orders where id = $1", [buyBad.order]);
check("Pedido con monto incorrecto sigue pendiente (sin licencia emitida)", badOrder[0]?.status === "pending");

// ---------------------------------------------------------------------------
// 3) Licencias exclusivas: reserva y agotamiento
// ---------------------------------------------------------------------------
await as(BUYER, "authenticated");
await db.exec(`insert into public.cart_items (user_id, product_id, license_type_id) values ('${BUYER}', '${PID(2)}', '${exclusive}')`);
const exA = await scalar("select public.create_order_from_cart(null)");
check("Comprador A reserva la exclusiva (pedido pendiente creado)", !!exA);

await as(OTHER, "authenticated");
await db.exec(`insert into public.cart_items (user_id, product_id, license_type_id) values ('${OTHER}', '${PID(2)}', '${exclusive}')`);
const errB = await errorOf(() => db.query("select public.create_order_from_cart(null)"));
check("Comprador B NO puede reservar la misma exclusiva mientras A reserva",
  errB !== null && errB.includes("agotada"), errB ?? "sin error");

// Reserva caducada (30 min): C puede comprar. Simulamos el paso del tiempo cambiando la fecha del pedido de A.
await as(null, "postgres");
await db.exec(`update public.orders set created_at = now() - interval '2 hours' where id = '${exA}'`);
await as(LATE, "authenticated");
await db.exec(`insert into public.cart_items (user_id, product_id, license_type_id) values ('${LATE}', '${PID(2)}', '${exclusive}')`);
const exC = await scalar("select public.create_order_from_cart(null)");
check("Con la reserva de A caducada, C sí puede crear pedido", !!exC);

await as(null, "postgres");
// Pagamos el pedido de C: primero se registra el intento y luego se confirma.
await db.exec(`select public.register_paypal_attempt('${exC}', '${LATE}', 'PPEXC-C')`);
const totalC = await scalar("select total_cents from public.orders where id = $1", [exC]);
const resC = await scalar("select public.fulfill_paypal_order('PPEXC-C', 'CAP-C', $1, 'USD', '{}'::jsonb)", [totalC]);
check("Primer comprador confirmado de la exclusiva: 'paid'", resC?.status === "paid", JSON.stringify(resC));

const availAfter = await scalar("select is_available from public.product_licenses where product_id = $1 and license_type_id = $2", [PID(2), exclusive]);
check("Tras venderla, la exclusiva queda no disponible", availAfter === false);

// A paga después (reserva caducada): debe quedar en revisión, sin error ni pérdida del pago.
await db.exec(`select public.register_paypal_attempt('${exA}', '${BUYER}', 'PPEXC-A')`);
const totalA = await scalar("select total_cents from public.orders where id = $1", [exA]);
const resA = await scalar("select public.fulfill_paypal_order('PPEXC-A', 'CAP-A', $1, 'USD', '{}'::jsonb)", [totalA]);
check("Segundo comprador de la exclusiva agotada: manual_review sin error",
  resA?.status === "manual_review" && resA?.reason === "sold_out", JSON.stringify(resA));
const payA = await q("select status from public.payments where provider_ref = 'PPEXC-A'");
check("Pago agotado persistido en revisión", payA[0]?.status === "manual_review");

// ---------------------------------------------------------------------------
// 4) PayPal deshabilitado por defecto
// ---------------------------------------------------------------------------
const pm = await scalar("select value->>'paypal' from public.settings where key = 'payment_methods'");
check("payment_methods.paypal = false por defecto", pm === "false", `valor: ${pm}`);

// ---------------------------------------------------------------------------
// 5) Validación de URLs del CMS
// ---------------------------------------------------------------------------
const bad = ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "//evil.com", " javascript:x"];
const good = ["#/catalogo", "#/producto/kit-prueba", "/catalogo", "https://etner249.github.io/u3m-demo/", "http://ejemplo.com"];
await as(null, "postgres");
for (const u of bad) {
  const e = await errorOf(() => db.query("insert into public.nav_items (label, url) values ('x', $1)", [u]));
  check(`URL rechazada en nav_items: ${u}`, e !== null);
}
for (const u of good) {
  const e = await errorOf(() => db.query("insert into public.nav_items (label, url) values ('ok', $1)", [u]));
  check(`URL aceptada en nav_items: ${u}`, e === null, e ?? "");
}
const eBanner = await errorOf(() => db.query("insert into public.site_banners (title, button_url) values ('b', 'javascript:x')"));
check("URL rechazada en site_banners.button_url", eBanner !== null);
const eSection = await errorOf(() => db.query("insert into public.site_sections (internal_name, section_type, button_url) values ('s', 'editorial', 'data:x')"));
check("URL rechazada en site_sections.button_url", eSection !== null);
const eHero = await errorOf(() => db.query("update public.settings set value = jsonb_set(value, '{button_url}', '\"javascript:x\"') where key = 'hero'"));
check("URL rechazada en ajustes hero (trigger)", eHero !== null);
const eFooter = await errorOf(() => db.query(`update public.settings set value = jsonb_set(value, '{links}', '[{"label":"x","url":"javascript:alert(1)"}]') where key = 'footer'`));
check("URL rechazada en enlaces del pie (trigger)", eFooter !== null);

// ---------------------------------------------------------------------------
// 6) CMS: visitantes, usuarios normales, admin y protección de enlaces esenciales
// ---------------------------------------------------------------------------
await as(null, "postgres");
await db.exec(`insert into public.site_sections (internal_name, section_type, is_active) values ('visible', 'editorial', true), ('oculta-s', 'editorial', false)`);
await as(null, "anon");
check("Anónimo ve solo secciones activas", (await scalar("select count(*) from public.site_sections where internal_name in ('visible','oculta-s')")) === 1);
check("Anónimo no ve categorías inactivas", (await scalar("select count(*) from public.categories where slug = 'oculta'")) === 0);
const anonWrite = await errorOf(() => db.query("insert into public.site_banners (title) values ('hack')"));
check("Anónimo no puede escribir banners", anonWrite !== null);

await as(OTHER, "authenticated");
const userWrite = await errorOf(() => db.query("insert into public.site_banners (title) values ('hack')"));
check("Usuario normal no puede escribir banners", userWrite !== null);
const userSettings = await errorOf(() => db.query("update public.settings set value = '\"x\"' where key = 'site_name'"));
const siteName = await scalar("select value #>> '{}' from public.settings where key = 'site_name'");
check("Usuario normal no cambia ajustes (sin efecto)", siteName !== "x", `valor: ${siteName}`);
check("Usuario normal no puede ejecutar admin_list_users",
  (await errorOf(() => db.query("select * from public.admin_list_users()"))) !== null);

await as(ADMIN, "authenticated");
const adminWrite = await errorOf(() => db.query("insert into public.site_banners (title, is_published) values ('ok', true)"));
check("Admin sí puede crear banners", adminWrite === null, adminWrite ?? "");

await as(null, "postgres");
const protectedDel = await errorOf(() => db.query("delete from public.nav_items where label = 'Inicio'"));
check("Enlace esencial 'Inicio' no se puede eliminar", protectedDel !== null && protectedDel.includes("esencial"), protectedDel ?? "");

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length) {
  console.log("Fallidas:", failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
