// Importa los productos del sitio original a Supabase (idempotente: se puede ejecutar varias veces).
// Uso (en tu máquina, nunca en el navegador):
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<clave> node scripts/import-legacy-products.mjs
// Crea productos PUBLICADOS. Si prefieres revisarlos antes, cambia STATUS a "draft".
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = "published";
const LICENSE_MULTIPLIER = { basic_mp3: 1, premium_wav: 2.5, unlimited: 4 };

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const seed = JSON.parse(await readFile(join(ROOT, "supabase/seed/legacy-products.json"), "utf8"));

const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function typeFor(cat) {
  if (cat === "drum-kits") return "drum_kit";
  if (cat === "plugins") return "plugin";
  return "sample_pack";
}

function check(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

// 1) Categorías (padres primero)
const catIds = {};
for (const c of seed.categories.filter((c) => !c.parent)) {
  catIds[c.slug] = check(await sb.from("categories").upsert(
    { slug: c.slug, name: c.name, description: c.description, parent_id: null }, { onConflict: "slug" }).select("id").single(), `categoría ${c.slug}`).id;
}
for (const c of seed.categories.filter((c) => c.parent)) {
  catIds[c.slug] = check(await sb.from("categories").upsert(
    { slug: c.slug, name: c.name, description: c.description, parent_id: catIds[c.parent] }, { onConflict: "slug" }).select("id").single(), `categoría ${c.slug}`).id;
}

// 2) Licencias y géneros
const licenseIds = Object.fromEntries(
  check(await sb.from("license_types").select("id, code"), "licencias").map((l) => [l.code, l.id]));

const genreIds = {};
for (const g of [...new Set(seed.products.map((p) => p.genre).filter(Boolean))]) {
  genreIds[g] = check(await sb.from("genres").upsert({ slug: slugify(g), name: g }, { onConflict: "slug" }).select("id").single(), `género ${g}`).id;
}

// 3) Productos, precios y portadas
const report = { creados_o_actualizados: 0, sin_portada: [] };
for (const p of seed.products) {
  const slug = slugify(p.title);
  const type = typeFor(p.cat);
  const attributes = { formats: p.format, legacy_category: p.cat, ...(type === "sample_pack" ? { subtype: p.cat } : {}) };
  const row = {
    slug, type, title: p.title, producer: "", description: p.summary,
    genre_id: p.genre ? genreIds[p.genre] : null,
    category_id: catIds[p.cat],
    bpm: p.bpm, musical_key: p.key, is_featured: p.featured,
    price_cents: Math.round(p.base * 100),
    status: STATUS, published_at: new Date().toISOString(), attributes,
  };
  const product = check(await sb.from("products").upsert(row, { onConflict: "slug" }).select("id").single(), `producto ${slug}`);
  report.creados_o_actualizados++;

  // Precios por licencia (la exclusiva no se importa)
  for (const [code, mult] of Object.entries(LICENSE_MULTIPLIER)) {
    check(await sb.from("product_licenses").upsert({
      product_id: product.id, license_type_id: licenseIds[code],
      price_cents: Math.round(p.base * mult * 100), is_available: true, max_sales: null,
    }, { onConflict: "product_id,license_type_id" }), `licencia ${code} de ${slug}`);
  }

  // Portada: se sube una vez; si ya existe la fila, no se duplica
  const coverFile = join(ROOT, "covers", `cover-${String(p.n).padStart(2, "0")}.jpg`);
  let bytes;
  try { bytes = await readFile(coverFile); } catch { report.sin_portada.push(slug); continue; }
  const path = `products/${slug}/cover.jpg`;
  check(await sb.storage.from("product-public").upload(path, bytes, { contentType: "image/jpeg", upsert: true }), `portada ${slug}`);
  const { data: existing } = await sb.from("product_files").select("id").eq("product_id", product.id).eq("kind", "cover").maybeSingle();
  if (!existing) {
    check(await sb.from("product_files").insert({
      product_id: product.id, kind: "cover", bucket: "product-public", storage_path: path,
      mime_type: "image/jpeg", size_bytes: bytes.length,
    }), `registro de portada ${slug}`);
  }
}

console.log(JSON.stringify({ ok: true, ...report }, null, 2));
