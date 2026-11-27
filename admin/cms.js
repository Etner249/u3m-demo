// Contenido de la tienda (CMS): hero, secciones, banners, menú y categorías.
// Todo se guarda en Supabase con RLS de administrador. Las imágenes van a product-public/site/.
import { sb, errMsg, esc, publicUrl, validateImage, optimizeImage, uploadWithProgress } from "../assets/js/supabase.js";

// Solo rutas internas (#/..., /...) y HTTP/HTTPS. Espeja la validación de la base de datos.
export function urlError(u) {
  const v = String(u ?? "").trim();
  if (!v) return null;
  if (/^(#\/|https?:\/\/)/i.test(v) || (/^\//.test(v) && !/^\/\//.test(v))) return null;
  return "Enlace no permitido: usa una ruta interna (#/...) o una dirección http(s)://";
}

const TYPES = {
  featured_products: "Productos destacados",
  new_releases: "Nuevos lanzamientos",
  best_sellers: "Más vendidos",
  featured_categories: "Categorías destacadas",
  promo_banner: "Banner promocional",
  editorial: "Contenido editorial",
  collection: "Colección",
  image_text: "Imagen y texto",
};
const PRODUCT_TYPES = ["featured_products", "new_releases", "best_sellers", "collection"];

let ctx = null; // { shell, toast, fail, confirmBox, modal, closeModal, render, callFn, userId }
const isoLocal = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
const toIso = (v) => (v ? new Date(v).toISOString() : null);
const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Barra de progreso flotante para cualquier subida del CMS.
function progressBar(label) {
  let el = document.getElementById("uploadBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "uploadBar";
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:90;background:#fff;color:#0b0b0c;border-radius:12px;padding:12px 16px;min-width:260px;box-shadow:0 14px 40px rgba(0,0,0,.4);font-weight:700;font-size:13px";
    document.body.appendChild(el);
  }
  return {
    set(pct) { el.innerHTML = `${esc(label)} · ${pct}%<div style="height:6px;background:#e5e5e5;border-radius:99px;margin-top:8px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:#e10600;transition:width .2s"></span></div>`; },
    done() { el.remove(); },
  };
}

// Valida, optimiza y sube una imagen del CMS con progreso. Devuelve la ruta o null si no hay archivo.
async function uploadSite(file, prefix, maxMb = 8) {
  if (!file || !file.size) return null;
  validateImage(file, { maxMb });
  const bar = progressBar("Optimizando y subiendo imagen");
  try {
    bar.set(0);
    const blob = await optimizeImage(file, { maxSide: prefix.startsWith("favicon") ? 512 : 2000 });
    const ext = blob.type === "image/webp" ? "webp" : (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `site/${prefix}-${crypto.randomUUID()}.${ext}`;
    await uploadWithProgress("product-public", path, blob, blob.type || file.type, (pct) => bar.set(pct));
    return path;
  } finally {
    bar.done();
  }
}

// Vista previa instantánea al elegir un archivo (sin subirlo todavía).
export function cmsChange(input) {
  if (input.type !== "file" || !input.dataset.preview) return false;
  const img = document.getElementById(input.dataset.preview);
  const file = input.files?.[0];
  if (!img) return true;
  try { validateImage(file, { maxMb: 8 }); }
  catch (e) { input.value = ""; img.hidden = true; ctx?.toast?.(e.message); return true; }
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  return true;
}

async function getSetting(key) {
  const { data } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? {};
}
async function saveSetting(key, value) {
  const { error } = await sb.from("settings").upsert({ key, value, updated_by: ctx.userId, updated_at: new Date().toISOString() });
  if (error) throw error;
}

const badgeOn = (on, yes = "Activo", no = "Oculto") =>
  `<span class="st-${on ? "published" : "draft"}">${on ? yes : no}</span>`;
const preview = (path) => (path ? `<img src="${esc(publicUrl("product-public", path))}" alt="" style="width:120px;height:68px;object-fit:cover;border-radius:10px">` : `<span class="mono">Sin imagen</span>`);

// ---------------------------------------------------------------------------
// Inicio: hero + lista de secciones
// ---------------------------------------------------------------------------
async function viewHome() {
  const [hero, { data: sections }] = await Promise.all([
    getSetting("hero"),
    sb.from("site_sections").select("id, internal_name, section_type, is_active, sort_order, image_path").order("sort_order"),
  ]);
  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda / Página de inicio</p><h1>Página de inicio</h1></div>
      <div class="row"><a class="btn" href="../#/" target="_blank" rel="noopener">Ver en la tienda</a>
      <a class="btn red" href="#/contenido/inicio/nueva">Nueva sección</a></div></div>

    <form class="card" data-submit="cms-hero" style="margin-top:18px;display:grid;gap:14px">
      <div class="spread"><h2>Hero principal</h2>${badgeOn(hero.active !== false)}</div>
      <label class="chk"><input type="checkbox" name="active" ${hero.active !== false ? "checked" : ""}> Mostrar el hero en la tienda</label>
      <div class="grid2">
        <label>Etiqueta superior<input name="eyebrow" maxlength="80" value="${esc(hero.eyebrow ?? "")}"></label>
        <label>Título principal *<input name="title" required maxlength="120" value="${esc(hero.title ?? "")}"></label>
        <label style="grid-column:1/-1">Subtítulo<textarea name="subtitle" rows="2" maxlength="260">${esc(hero.subtitle ?? "")}</textarea></label>
        <label>Color de fondo<input name="bg_color" type="color" value="${esc(hero.bg_color ?? "#ffffff")}"></label>
        <label>Color del texto<input name="text_color" type="color" value="${esc(hero.text_color ?? "#0c0c0c")}"></label>
        <label>Texto del botón principal<input name="button_label" maxlength="40" value="${esc(hero.button_label ?? "")}"></label>
        <label>URL del botón principal<input name="button_url" maxlength="200" placeholder="#/catalogo" value="${esc(hero.button_url ?? "")}"></label>
        <label>Texto del botón secundario<input name="secondary_label" maxlength="40" value="${esc(hero.secondary_label ?? "")}"></label>
        <label>URL del botón secundario<input name="secondary_url" maxlength="200" placeholder="#/catalogo/drum-kits" value="${esc(hero.secondary_url ?? "")}"></label>
      </div>
      <div class="grid2">
        <div><span class="mono">Imagen (escritorio)</span><div style="margin:8px 0">${preview(hero.image_path)}</div>
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp"></div>
        <div><span class="mono">Imagen para móvil (opcional)</span><div style="margin:8px 0">${preview(hero.mobile_image_path)}</div>
          <input type="file" name="mobile_image" accept="image/jpeg,image/png,image/webp"></div>
      </div>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Guardar hero</button></div>
    </form>

    <div class="card" style="margin-top:18px;padding:0;overflow:auto">
      <div class="spread" style="padding:18px 18px 0"><h2>Secciones (en orden de aparición)</h2></div>
      <table style="margin-top:12px"><thead><tr><th style="width:70px">Orden</th><th>Nombre interno</th><th>Tipo</th><th>Estado</th><th></th></tr></thead>
      <tbody>${(sections ?? []).map((s, i, arr) => `<tr>
        <td class="row"><button class="btn sm ghost" data-act="cms-move" data-table="site_sections" data-id="${s.id}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Subir">↑</button>
          <button class="btn sm ghost" data-act="cms-move" data-table="site_sections" data-id="${s.id}" data-dir="1" ${i === arr.length - 1 ? "disabled" : ""} aria-label="Bajar">↓</button></td>
        <td><a href="#/contenido/inicio/${s.id}"><b>${esc(s.internal_name)}</b></a></td>
        <td>${esc(TYPES[s.section_type] ?? s.section_type)}</td>
        <td>${badgeOn(s.is_active)}</td>
        <td class="row" style="justify-content:flex-end">
          <a class="btn sm" href="#/contenido/inicio/${s.id}">Editar</a>
          <button class="btn sm ${s.is_active ? "" : "ok"}" data-act="cms-section-toggle" data-id="${s.id}" data-on="${s.is_active ? 0 : 1}">${s.is_active ? "Ocultar" : "Activar"}</button>
          <button class="btn sm" data-act="cms-duplicate" data-id="${s.id}">Duplicar</button>
          <button class="btn sm red" data-act="cms-section-del" data-id="${s.id}" data-name="${esc(s.internal_name)}">Eliminar</button></td></tr>`).join("")
        || `<tr><td colspan="5" class="mono">Aún no hay secciones. Crea la primera.</td></tr>`}</tbody></table></div>`);
}

async function viewSectionForm(id) {
  const isNew = id === "nueva";
  let sec = { section_type: "featured_products", is_active: true, product_limit: 4, bg_color: "#ffffff", text_color: "#0c0c0c" };
  let items = [];
  if (!isNew) {
    const { data, error } = await sb.from("site_sections").select("*, site_section_items(product_id, category_id, position)").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return ctx.shell(`<h1>Sección no encontrada</h1>`);
    sec = data;
    items = data.site_section_items ?? [];
  }
  const [{ data: products }, { data: cats }] = await Promise.all([
    sb.from("products").select("id, title, type").eq("status", "published").order("title"),
    sb.from("categories").select("id, name").order("sort_order"),
  ]);
  const selProducts = new Set(items.filter((i) => i.product_id).sort((a, b) => a.position - b.position).map((i) => i.product_id));
  const selCats = new Set(items.filter((i) => i.category_id).sort((a, b) => a.position - b.position).map((i) => i.category_id));

  ctx.shell(`<p class="mono"><a href="#/contenido/inicio">Página de inicio</a> / ${isNew ? "Nueva sección" : esc(sec.internal_name)}</p>
    <h1>${isNew ? "Nueva sección" : "Editar sección"}</h1>
    <form class="card" data-submit="cms-section" data-id="${isNew ? "" : id}" style="margin-top:18px;display:grid;gap:14px">
      <h2>Identificación</h2>
      <div class="grid2">
        <label>Nombre interno * (no se muestra)<input name="internal_name" required maxlength="120" value="${esc(sec.internal_name ?? "")}"></label>
        <label>Tipo de sección<select name="section_type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${sec.section_type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="chk"><input type="checkbox" name="is_active" ${sec.is_active ? "checked" : ""}> Visible en la tienda</label>
        <label>Cuántos elementos mostrar<input name="product_limit" type="number" min="1" max="12" value="${sec.product_limit ?? 4}"></label>
      </div>
      <h2>Contenido</h2>
      <div class="grid2">
        <label>Título visible<input name="title" maxlength="160" value="${esc(sec.title ?? "")}"></label>
        <label>Subtítulo<input name="subtitle" maxlength="200" value="${esc(sec.subtitle ?? "")}"></label>
        <label style="grid-column:1/-1">Descripción<textarea name="description" rows="3" maxlength="2000">${esc(sec.description ?? "")}</textarea></label>
        <label>Texto del botón (opcional)<input name="button_label" maxlength="60" value="${esc(sec.button_label ?? "")}"></label>
        <label>Enlace del botón<input name="button_url" maxlength="300" placeholder="#/catalogo" value="${esc(sec.button_url ?? "")}"></label>
        <label>Color de fondo<input name="bg_color" type="color" value="${esc(sec.bg_color ?? "#ffffff")}"></label>
        <label>Color del texto<input name="text_color" type="color" value="${esc(sec.text_color ?? "#0c0c0c")}"></label>
      </div>
      <div><span class="mono">Imagen o portada</span><div style="margin:8px 0">${preview(sec.image_path)}</div>
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp"></div>

      <h2>Productos o categorías asociados</h2>
      <p class="note">Para tipos de producto, marca los que quieras mostrar (en el orden en que los marcas). Si no marcas ninguno, la tienda elige automáticamente según el tipo.</p>
      <div class="grid3" data-group="products" style="max-height:260px;overflow:auto;padding:4px">
        ${(products ?? []).map((p) => `<label class="chk"><input type="checkbox" name="product" value="${p.id}" ${selProducts.has(p.id) ? "checked" : ""}> ${esc(p.title)} <span class="mono">${esc(p.type)}</span></label>`).join("") || '<p class="mono">No hay productos publicados.</p>'}
      </div>
      <div class="grid3" data-group="categories" style="max-height:200px;overflow:auto;padding:4px">
        ${(cats ?? []).map((c) => `<label class="chk"><input type="checkbox" name="category" value="${c.id}" ${selCats.has(c.id) ? "checked" : ""}> ${esc(c.name)}</label>`).join("")}
      </div>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:space-between"><a class="btn ghost" href="#/contenido/inicio">Cancelar</a>
        <button class="btn red" type="submit">${isNew ? "Crear sección" : "Guardar sección"}</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------
function bannerStatus(b) {
  const now = Date.now();
  if (!b.is_published) return `<span class="st-draft">Borrador</span>`;
  if (b.starts_at && new Date(b.starts_at).getTime() > now) return `<span class="st-pending">Programado</span>`;
  if (b.ends_at && new Date(b.ends_at).getTime() < now) return `<span class="st-archived">Vencido</span>`;
  return `<span class="st-published">Publicado</span>`;
}

async function viewBanners() {
  const { data } = await sb.from("site_banners").select("*").order("sort_order");
  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda</p><h1>Banners promocionales</h1></div>
      <a class="btn red" href="#/contenido/banners/nuevo">Nuevo banner</a></div>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Vista</th><th>Título</th><th>Etiqueta</th><th>Vigencia</th><th>Estado</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((b, i, arr) => `<tr>
        <td>${preview(b.image_path)}</td>
        <td><a href="#/contenido/banners/${b.id}"><b>${esc(b.title)}</b></a></td>
        <td>${esc(b.eyebrow || "—")}</td>
        <td class="mono">${b.starts_at ? new Date(b.starts_at).toLocaleDateString("es-PE") : "Desde ya"} → ${b.ends_at ? new Date(b.ends_at).toLocaleDateString("es-PE") : "sin fin"}</td>
        <td>${bannerStatus(b)}</td>
        <td class="row" style="justify-content:flex-end">
          <button class="btn sm ghost" data-act="cms-move" data-table="site_banners" data-id="${b.id}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn sm ghost" data-act="cms-move" data-table="site_banners" data-id="${b.id}" data-dir="1" ${i === arr.length - 1 ? "disabled" : ""}>↓</button>
          <button class="btn sm" data-act="cms-banner-dup" data-id="${b.id}">Duplicar</button>
          <button class="btn sm ${b.is_published ? "" : "ok"}" data-act="cms-banner-publish" data-id="${b.id}" data-on="${b.is_published ? 0 : 1}">${b.is_published ? "Ocultar" : "Publicar"}</button>
          <button class="btn sm red" data-act="cms-banner-del" data-id="${b.id}" data-name="${esc(b.title)}">Eliminar</button></td></tr>`).join("")
        || `<tr><td colspan="6" class="mono">Sin banners todavía.</td></tr>`}</tbody></table></div>`);
}

async function viewBannerForm(id) {
  const isNew = id === "nuevo";
  let b = { is_published: true, bg_color: "#0c0c0c" };
  if (!isNew) {
    const { data } = await sb.from("site_banners").select("*").eq("id", id).maybeSingle();
    if (!data) return ctx.shell(`<h1>Banner no encontrado</h1>`);
    b = data;
  }
  ctx.shell(`<p class="mono"><a href="#/contenido/banners">Banners</a> / ${isNew ? "Nuevo" : esc(b.title)}</p>
    <h1>${isNew ? "Nuevo banner" : "Editar banner"}</h1>
    <form class="card" data-submit="cms-banner" data-id="${isNew ? "" : id}" style="margin-top:18px;display:grid;gap:14px">
      <div class="grid2">
        <label>Título *<input name="title" required maxlength="120" value="${esc(b.title ?? "")}"></label>
        <label>Etiqueta superior (p. ej. NUEVO)<input name="eyebrow" maxlength="30" value="${esc(b.eyebrow ?? "")}"></label>
        <label style="grid-column:1/-1">Descripción<textarea name="description" rows="2" maxlength="500">${esc(b.description ?? "")}</textarea></label>
        <label>Color de fondo<input name="bg_color" type="color" value="${esc(b.bg_color ?? "#0c0c0c")}"></label>
        <label>Texto del botón<input name="button_label" maxlength="60" value="${esc(b.button_label ?? "")}"></label>
        <label>Enlace de destino<input name="button_url" maxlength="300" placeholder="#/catalogo/soundbanks" value="${esc(b.button_url ?? "")}"></label>
        <label>Inicio (opcional)<input name="starts_at" type="datetime-local" value="${isoLocal(b.starts_at ? new Date(b.starts_at) : null)}"></label>
        <label>Fin (opcional)<input name="ends_at" type="datetime-local" value="${isoLocal(b.ends_at ? new Date(b.ends_at) : null)}"></label>
      </div>
      <div><span class="mono">Imagen o fondo</span><div style="margin:8px 0">${preview(b.image_path)}</div>
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp"></div>
      <label class="chk"><input type="checkbox" name="is_published" ${b.is_published ? "checked" : ""}> Publicado</label>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:space-between"><a class="btn ghost" href="#/contenido/banners">Cancelar</a>
        <button class="btn red" type="submit">Guardar banner</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Menú de navegación y tarjeta promocional
// ---------------------------------------------------------------------------
async function viewMenu() {
  const [{ data: items }, promo, { data: cats }] = await Promise.all([
    sb.from("nav_items").select("*").order("sort_order"),
    getSetting("menu_promo"),
    sb.from("categories").select("id, name").order("sort_order"),
  ]);
  const top = (items ?? []).filter((i) => !i.parent_id);
  const rowFor = (i, depth, siblings, idx) => `<tr>
    <td class="row" style="padding-left:${depth * 22 + 14}px">
      <button class="btn sm ghost" data-act="cms-move" data-table="nav_items" data-id="${i.id}" data-dir="-1" ${idx === 0 ? "disabled" : ""}>↑</button>
      <button class="btn sm ghost" data-act="cms-move" data-table="nav_items" data-id="${i.id}" data-dir="1" ${idx === siblings.length - 1 ? "disabled" : ""}>↓</button></td>
    <td><input value="${esc(i.label)}" data-nav-label="${i.id}" maxlength="60" style="width:180px"> ${i.is_protected ? '<span class="tag">esencial</span>' : ""}</td>
    <td class="mono">${esc(i.url)}</td>
    <td>${badgeOn(i.is_visible, "Visible", "Oculto")}</td>
    <td class="row" style="justify-content:flex-end">
      <button class="btn sm" data-act="cms-nav-save" data-id="${i.id}">Guardar</button>
      <button class="btn sm" data-act="cms-nav-toggle" data-id="${i.id}" data-on="${i.is_visible ? 0 : 1}">${i.is_visible ? "Ocultar" : "Mostrar"}</button>
      ${i.is_protected ? "" : `<button class="btn sm red" data-act="cms-nav-del" data-id="${i.id}" data-name="${esc(i.label)}">Eliminar</button>`}</td></tr>`;
  const rows = top.map((t, idx) => {
    const kids = (items ?? []).filter((c) => c.parent_id === t.id);
    return rowFor(t, 0, top, idx) + kids.map((k, j) => rowFor(k, 1, kids, j)).join("");
  }).join("");

  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda</p><h1>Menú de navegación</h1></div></div>
    <p class="note">Los enlaces esenciales (Inicio, Catálogo) se pueden ocultar pero no eliminar. Los submenús admiten un nivel.</p>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Orden</th><th>Texto</th><th>Destino</th><th>Estado</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="mono">Sin elementos.</td></tr>`}</tbody></table></div>

    <form class="card" data-submit="cms-nav" style="margin-top:18px;display:grid;gap:12px">
      <h2>Añadir elemento</h2>
      <div class="grid3">
        <label>Texto del enlace *<input name="label" required maxlength="60"></label>
        <label>Destino (URL interna o externa) *<input name="url" required maxlength="300" placeholder="#/catalogo/drum-kits"></label>
        <label>Asociar a categoría (opcional)<select name="category_id"><option value="">Ninguna</option>${(cats ?? []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
        <label>Dentro de (submenú)<select name="parent_id"><option value="">Nivel principal</option>${top.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}</select></label>
        <label class="chk"><input type="checkbox" name="is_visible" checked> Visible</label>
      </div>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Añadir</button></div>
    </form>

    <form class="card" data-submit="cms-menu-promo" style="margin-top:18px;display:grid;gap:12px">
      <div class="spread"><h2>Tarjeta promocional del menú de categorías</h2>${badgeOn(promo.active, "Activa", "Oculta")}</div>
      <label class="chk"><input type="checkbox" name="active" ${promo.active ? "checked" : ""}> Mostrar en el menú</label>
      <div class="grid2">
        <label>Etiqueta<input name="eyebrow" maxlength="30" value="${esc(promo.eyebrow ?? "")}"></label>
        <label>Título<input name="title" maxlength="80" value="${esc(promo.title ?? "")}"></label>
        <label style="grid-column:1/-1">Descripción<textarea name="description" rows="2" maxlength="200">${esc(promo.description ?? "")}</textarea></label>
        <label>Texto del botón<input name="button_label" maxlength="40" value="${esc(promo.button_label ?? "")}"></label>
        <label>Enlace<input name="button_url" maxlength="300" value="${esc(promo.button_url ?? "")}"></label>
      </div>
      <div><span class="mono">Imagen o fondo</span><div style="margin:8px 0">${preview(promo.image_path)}</div>
        <input type="file" name="image" accept="image/jpeg,image/png,image/webp"></div>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Guardar tarjeta</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------
async function viewCategories() {
  const { data } = await sb.from("categories").select("id, name, slug, parent_id, color, is_active, sort_order, image_path").order("sort_order");
  const counts = Object.fromEntries(await Promise.all((data ?? []).map(async (c) => {
    const { data: n } = await sb.rpc("category_product_count", { p_category: c.id });
    return [c.id, n ?? 0];
  })));
  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda</p><h1>Categorías</h1></div>
      <a class="btn red" href="#/contenido/categorias/nueva">Nueva categoría</a></div>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Orden</th><th>Categoría</th><th>Subcategoría de</th><th>Productos</th><th>Estado</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((c, i, arr) => `<tr>
        <td class="row"><button class="btn sm ghost" data-act="cms-move" data-table="categories" data-id="${c.id}" data-dir="-1" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn sm ghost" data-act="cms-move" data-table="categories" data-id="${c.id}" data-dir="1" ${i === arr.length - 1 ? "disabled" : ""}>↓</button></td>
        <td><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${esc(c.color ?? "#333")};margin-right:8px"></span><a href="#/contenido/categorias/${c.id}"><b>${esc(c.name)}</b></a><br><span class="mono">${esc(c.slug)}</span></td>
        <td>${esc(arr.find((x) => x.id === c.parent_id)?.name ?? "—")}</td>
        <td>${counts[c.id]}</td>
        <td>${badgeOn(c.is_active)}</td>
        <td class="row" style="justify-content:flex-end">
          <button class="btn sm" data-act="cms-cat-toggle" data-id="${c.id}" data-on="${c.is_active ? 0 : 1}">${c.is_active ? "Desactivar" : "Activar"}</button>
          <a class="btn sm" href="#/contenido/categorias/${c.id}">Editar</a>
          <button class="btn sm red" data-act="cms-cat-del" data-id="${c.id}" data-name="${esc(c.name)}" data-count="${counts[c.id]}">Eliminar</button></td></tr>`).join("")}</tbody></table></div>`);
}

async function viewCategoryForm(id) {
  const isNew = id === "nueva";
  let c = { is_active: true, color: "#e10600" };
  if (!isNew) {
    const { data } = await sb.from("categories").select("*").eq("id", id).maybeSingle();
    if (!data) return ctx.shell(`<h1>Categoría no encontrada</h1>`);
    c = data;
  }
  const { data: all } = await sb.from("categories").select("id, name").order("sort_order");
  ctx.shell(`<p class="mono"><a href="#/contenido/categorias">Categorías</a> / ${isNew ? "Nueva" : esc(c.name)}</p>
    <h1>${isNew ? "Nueva categoría" : "Editar categoría"}</h1>
    <form class="card" data-submit="cms-category" data-id="${isNew ? "" : id}" style="margin-top:18px;display:grid;gap:14px">
      <div class="grid2">
        <label>Nombre *<input name="name" required maxlength="80" value="${esc(c.name ?? "")}"></label>
        <label>Slug (dirección en la tienda)<input name="slug" maxlength="80" placeholder="se genera del nombre" value="${esc(c.slug ?? "")}"></label>
        <label>Subcategoría de (opcional)<select name="parent_id"><option value="">Categoría principal</option>
          ${(all ?? []).filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}" ${c.parent_id === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
        <label>Orden<input name="sort_order" type="number" value="${c.sort_order ?? 0}"></label>
        <label style="grid-column:1/-1">Descripción<textarea name="description" rows="3" maxlength="400">${esc(c.description ?? "")}</textarea></label>
        <label>Color representativo<input name="color" type="color" value="${esc(c.color ?? "#e10600")}"></label>
        <label class="chk"><input type="checkbox" name="is_active" ${c.is_active ? "checked" : ""}> Visible en la tienda</label>
      </div>
      <div class="grid2">
        <div><span class="mono">Portada</span><div style="margin:8px 0">${preview(c.image_path)}</div>
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp"></div>
        <div><span class="mono">Miniatura</span><div style="margin:8px 0">${preview(c.thumb_path)}</div>
          <input type="file" name="thumb" accept="image/jpeg,image/png,image/webp"></div>
      </div>
      <p class="note">Ocultar una categoría no borra sus productos; simplemente no se muestra en la tienda.</p>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:space-between"><a class="btn ghost" href="#/contenido/categorias">Cancelar</a>
        <button class="btn red" type="submit">Guardar categoría</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Identidad visual: colores, fondos, logotipo y favicon
// ---------------------------------------------------------------------------
const THEME_FIELDS = [
  ["primary", "Color principal (botones y acentos)"],
  ["secondary", "Color secundario (hover y detalles)"],
  ["background", "Fondo de la tienda"],
  ["surface", "Fondo de tarjetas y paneles"],
  ["text", "Color del texto"],
];

async function viewIdentity() {
  const [theme, logo, favicon] = await Promise.all([getSetting("theme"), getSetting("logo_path"), getSetting("favicon_path")]);
  const t = { primary: "#e10600", secondary: "#ff3b30", background: "#0c0c0c", surface: "#1a1a1a", text: "#f5f5f5", ...theme };
  ctx.shell(`<p class="mono">Contenido de la tienda</p><h1>Identidad visual</h1>
    <p class="note">Los colores se aplican a toda la tienda al recargarla. Los cambios no alteran la estructura del diseño.</p>
    <div class="grid2" style="margin-top:18px">
      <form class="card" data-submit="cms-theme" style="display:grid;gap:14px">
        <h2>Colores</h2>
        ${THEME_FIELDS.map(([k, label]) => `<label>${esc(label)}<input name="${k}" type="color" value="${esc(t[k])}"></label>`).join("")}
        <div class="card" style="padding:14px;background:${esc(t.background)};color:${esc(t.text)}">
          <span class="mono" style="color:${esc(t.text)}">Vista previa</span>
          <p style="margin:8px 0"><b>Título de ejemplo</b></p>
          <button type="button" style="background:${esc(t.primary)};color:#fff;border:0;border-radius:999px;padding:10px 18px;font-weight:800">Comprar</button>
          <div style="background:${esc(t.surface)};border-radius:12px;padding:10px;margin-top:10px;color:${esc(t.text)}">Tarjeta</div>
        </div>
        <p class="field-err" data-err="form"></p>
        <div class="row" style="justify-content:space-between"><button class="btn ghost" type="button" data-act="cms-theme-reset">Restaurar colores originales</button>
          <button class="btn red" type="submit">Guardar colores</button></div>
      </form>
      <div style="display:grid;gap:18px;align-content:start">
        <form class="card" data-submit="cms-logo" style="display:grid;gap:12px">
          <h2>Logotipo</h2>
          <div style="background:#0f0f0f;border-radius:14px;padding:16px;display:grid;place-items:center;min-height:90px">
            <img id="logoPrev" src="${logo ? esc(publicUrl("product-public", logo)) : "../logo.png"}" alt="" style="max-height:70px"></div>
          <input type="file" name="image" accept="image/png,image/jpeg,image/webp" data-preview="logoPrev">
          <p class="note">PNG con fondo transparente recomendado. Máximo 8 MB; se optimiza al subir.</p>
          <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Subir logotipo</button></div>
        </form>
        <form class="card" data-submit="cms-favicon" style="display:grid;gap:12px">
          <h2>Favicon</h2>
          <div style="display:flex;gap:14px;align-items:center">
            <img id="favPrev" src="${favicon ? esc(publicUrl("product-public", favicon)) : "../logo.png"}" alt="" width="48" height="48" style="border-radius:10px;background:#0f0f0f">
            <span class="note">Imagen cuadrada de 512×512 px o mayor (PNG recomendado).</span></div>
          <input type="file" name="image" accept="image/png,image/webp,image/jpeg" data-preview="favPrev">
          <p class="field-err" data-err="form"></p>
          <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Subir favicon</button></div>
        </form>
      </div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Pie de página: descripción, enlaces, redes, legal y copyright
// ---------------------------------------------------------------------------
const linesToPairs = (txt) => String(txt ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { const [label, ...rest] = l.split("|"); return { label: (label ?? "").trim(), url: rest.join("|").trim() }; })
  .filter((p) => p.label && p.url);
const pairsToLines = (arr) => (Array.isArray(arr) ? arr : []).map((p) => `${p.label} | ${p.url}`).join("\n");

async function viewFooter() {
  const f = await getSetting("footer");
  ctx.shell(`<p class="mono">Contenido de la tienda</p><h1>Pie de página</h1>
    <form class="card" data-submit="cms-footer" style="margin-top:18px;display:grid;gap:14px">
      <label>Descripción<textarea name="description" rows="2" maxlength="300">${esc(f.description ?? "")}</textarea></label>
      <div class="grid2">
        <label>Enlaces (uno por línea: Texto | URL)<textarea name="links" rows="7">${esc(pairsToLines(f.links))}</textarea></label>
        <label>Redes sociales (uno por línea: Red | URL)<textarea name="social" rows="7">${esc(pairsToLines(f.social))}</textarea></label>
      </div>
      <label>Información legal<textarea name="legal_text" rows="3" maxlength="600">${esc(f.legal_text ?? "")}</textarea></label>
      <label>Copyright<input name="copyright" maxlength="160" value="${esc(f.copyright ?? "")}"></label>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Guardar pie de página</button></div>
    </form>`);
}

async function submitTheme(form) {
  const fd = new FormData(form);
  const theme = Object.fromEntries(THEME_FIELDS.map(([k]) => [k, String(fd.get(k) ?? "#000000")]));
  await saveSetting("theme", theme);
  ctx.toast("Colores guardados. Recarga la tienda para verlos."); ctx.render();
}

async function submitLogo(form) {
  const path = await uploadSite(new FormData(form).get("image"), "logo", 8);
  if (!path) return form.querySelector('[data-err="form"]')?.remove();
  await saveSetting("logo_path", path);
  ctx.toast("Logotipo actualizado"); ctx.render();
}

async function submitFavicon(form) {
  const err = form.querySelector('[data-err="form"]');
  const file = new FormData(form).get("image");
  const path = await uploadSite(file, "favicon", 2);
  if (!path) return;
  await saveSetting("favicon_path", path);
  ctx.toast("Favicon actualizado"); ctx.render();
}

async function submitFooter(form) {
  const fd = new FormData(form);
  const bad = [...linesToPairs(fd.get("links")), ...linesToPairs(fd.get("social"))].find((p) => urlError(p.url));
  if (bad) return ctx.toast(urlError(bad.url));
  await saveSetting("footer", {
    description: String(fd.get("description") ?? "").trim(),
    links: linesToPairs(fd.get("links")),
    social: linesToPairs(fd.get("social")),
    legal_text: String(fd.get("legal_text") ?? "").trim(),
    copyright: String(fd.get("copyright") ?? "").trim(),
  });
  ctx.toast("Pie de página guardado"); ctx.render();
}

// ---------------------------------------------------------------------------
// Destacados (productos marcados como destacados en la portada)
// ---------------------------------------------------------------------------
async function viewFeatured() {
  const { data } = await sb.from("products").select("id, title, type, status, is_featured").order("title");
  const n = (data ?? []).filter((p) => p.is_featured).length;
  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda</p><h1>Productos destacados</h1></div>
      <span class="mono" data-featured-count>${n} de 8</span></div>
    <p class="note">Se usan en las secciones automáticas de productos destacados. Máximo 8.</p>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Destacado</th><th>Producto</th><th>Tipo</th><th>Estado</th></tr></thead>
      <tbody>${(data ?? []).map((p) => `<tr><td><input type="checkbox" data-act="feature-toggle" data-id="${p.id}" ${p.is_featured ? "checked" : ""}></td>
        <td>${esc(p.title)}</td><td>${esc(p.type)}</td><td>${p.status === "published" ? '<span class="st-published">Publicado</span>' : `<span class="st-draft">${esc(p.status)}</span>`}</td></tr>`).join("")
        || `<tr><td colspan="4" class="mono">Sin productos.</td></tr>`}</tbody></table></div>`);
}

// ---------------------------------------------------------------------------
// Ruteo y envío de formularios
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Nosotros y contacto: títulos, textos y equipo (ajustes: about_page, contact_page, about, team)
// ---------------------------------------------------------------------------
const textSetting = (v) => (typeof v === "string" ? v : "");
async function getTeam() {
  const { data } = await sb.from("settings").select("value").eq("key", "team").maybeSingle();
  return Array.isArray(data?.value) ? data.value : [];
}
const saveTeam = (list) => saveSetting("team", list);
const teamPhoto = (path) => (path ? `<img src="${esc(publicUrl("product-public", path))}" alt="" style="width:72px;height:90px;object-fit:cover;border-radius:10px">` : `<span class="mono">Sin foto</span>`);

async function viewPages() {
  const [aboutPage, contactPage, about, team] = await Promise.all([
    getSetting("about_page"), getSetting("contact_page"), getSetting("about"), getTeam(),
  ]);
  const ap = aboutPage && typeof aboutPage === "object" ? aboutPage : {};
  const cp = contactPage && typeof contactPage === "object" ? contactPage : {};
  ctx.shell(`<div class="spread"><div><p class="mono">Contenido de la tienda</p><h1>Nosotros y contacto</h1></div>
      <a class="btn" href="../#/nosotros" target="_blank" rel="noopener">Ver página Nosotros</a></div>
    <form class="card" data-submit="cms-pages" style="margin-top:18px;display:grid;gap:16px">
      <h2>Página Nosotros</h2>
      <label>Título<input name="about_title" maxlength="120" value="${esc(ap.title ?? "")}" placeholder="Nosotros"></label>
      <label>Descripción breve<textarea name="about_description" rows="2" maxlength="400">${esc(ap.description ?? "")}</textarea></label>
      <label>Historia (párrafos separados por línea en blanco)<textarea name="about" rows="6">${esc(textSetting(about))}</textarea></label>
      <h2>Página Contacto</h2>
      <label>Título<input name="contact_title" maxlength="120" value="${esc(cp.title ?? "")}" placeholder="Hablemos."></label>
      <label>Descripción breve<textarea name="contact_description" rows="2" maxlength="400">${esc(cp.description ?? "")}</textarea></label>
      <p class="mono">Correo, teléfono y horario se editan en Configuración general.</p>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Guardar páginas</button></div>
    </form>
    <div class="spread" style="margin-top:36px"><div><h2>Equipo</h2><p class="mono">Aparece en la página Nosotros, en el orden de esta lista.</p></div>
      <a class="btn red" href="#/contenido/paginas/equipo/nuevo">Agregar integrante</a></div>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Foto</th><th>Nombre</th><th>Rol</th><th></th></tr></thead>
      <tbody>${team.map((m, i, arr) => `<tr>
        <td>${teamPhoto(m.photo_path)}</td>
        <td><a href="#/contenido/paginas/equipo/${i}"><b>${esc(m.name)}</b></a></td>
        <td>${esc(m.role || "—")}</td>
        <td class="row" style="justify-content:flex-end">
          <button class="btn sm ghost" data-act="cms-team-move" data-idx="${i}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Subir">↑</button>
          <button class="btn sm ghost" data-act="cms-team-move" data-idx="${i}" data-dir="1" ${i === arr.length - 1 ? "disabled" : ""} aria-label="Bajar">↓</button>
          <a class="btn sm" href="#/contenido/paginas/equipo/${i}">Editar</a>
          <button class="btn sm red" data-act="cms-team-del" data-idx="${i}" data-name="${esc(m.name)}">Eliminar</button></td></tr>`).join("")
        || `<tr><td colspan="4" class="mono">Aún no hay integrantes. Agrega el primero.</td></tr>`}</tbody></table></div>`);
}

async function viewTeamForm(idx) {
  const team = await getTeam();
  const isNew = idx === "nuevo";
  const i = isNew ? -1 : Number(idx);
  const m = isNew ? { name: "", role: "" } : team[i];
  if (!isNew && !m) return ctx.shell(`<h1>No encontrado</h1>`);
  ctx.shell(`<div class="spread"><div><p class="mono"><a href="#/contenido/paginas">Nosotros y contacto</a> / Integrante</p><h1>${isNew ? "Nuevo integrante" : esc(m.name)}</h1></div></div>
    <form class="card" data-submit="cms-team" data-id="${isNew ? "" : i}" style="margin-top:18px;display:grid;gap:14px">
      <label>Nombre<input name="name" required maxlength="80" value="${esc(m.name ?? "")}"></label>
      <label>Rol<input name="role" maxlength="80" value="${esc(m.role ?? "")}" placeholder="Productor · Beatmaker"></label>
      <div>${m.photo_path ? `<img src="${esc(publicUrl("product-public", m.photo_path))}" alt="" style="width:160px;aspect-ratio:4/5;object-fit:cover;border-radius:12px">` : `<span class="mono">Sin foto</span>`}</div>
      <label>Nueva foto (JPG, PNG o WEBP; se optimiza al subir)<input type="file" name="photo" accept="image/*" data-preview="team-photo-prev"></label>
      <img id="team-photo-prev" alt="" hidden style="width:160px;aspect-ratio:4/5;object-fit:cover;border-radius:12px">
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:space-between">
        ${isNew ? "<span></span>" : `<button type="button" class="btn red" data-act="cms-team-del" data-idx="${i}" data-name="${esc(m.name)}">Eliminar</button>`}
        <button class="btn red" type="submit">Guardar integrante</button></div>
    </form>`);
}

async function submitPages(form) {
  const fd = new FormData(form);
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  if (String(fd.get("about_title") ?? "").length > 120 || String(fd.get("contact_title") ?? "").length > 120) return err("Los títulos no pueden superar 120 caracteres.");
  await saveSetting("about_page", { title: String(fd.get("about_title") ?? "").trim(), description: String(fd.get("about_description") ?? "").trim() });
  await saveSetting("contact_page", { title: String(fd.get("contact_title") ?? "").trim(), description: String(fd.get("contact_description") ?? "").trim() });
  await saveSetting("about", String(fd.get("about") ?? ""));
  ctx.toast("Páginas guardadas"); ctx.render();
}

async function submitTeam(form) {
  const fd = new FormData(form);
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return err("El nombre es obligatorio.");
  const team = await getTeam();
  const idx = form.dataset.id === "" ? -1 : Number(form.dataset.id);
  const current = idx >= 0 ? team[idx] : null;
  const photo = await uploadSite(fd.get("photo"), "team", 8);
  const item = { name, role: String(fd.get("role") ?? "").trim(), photo_path: photo ?? current?.photo_path ?? null };
  if (idx >= 0) team[idx] = item; else team.push(item);
  await saveTeam(team);
  ctx.toast("Integrante guardado");
  location.hash = "#/contenido/paginas";
}

export async function cmsRoute(parts, context) {
  ctx = { ...ctx, ...context };
  const [, sub, id] = parts; // parts[0] === "contenido"
  if (!sub || sub === "inicio" && !id) return viewHome();
  if (sub === "inicio") return viewSectionForm(id);
  if (sub === "banners" && !id) return viewBanners();
  if (sub === "banners") return viewBannerForm(id);
  if (sub === "menu") return viewMenu();
  if (sub === "paginas" && id === "equipo") return viewTeamForm(parts[3]);
  if (sub === "paginas") return viewPages();
  if (sub === "identidad") return viewIdentity();
  if (sub === "pie") return viewFooter();
  if (sub === "destacados") return viewFeatured();
  if (sub === "categorias" && !id) return viewCategories();
  if (sub === "categorias") return viewCategoryForm(id);
  return ctx.shell(`<h1>No encontrado</h1>`);
}

async function submitHero(form) {
  const fd = new FormData(form);
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  if (!String(fd.get("title") ?? "").trim()) return err("El título del hero es obligatorio.");
  const badUrl = urlError(fd.get("button_url")) || urlError(fd.get("secondary_url"));
  if (badUrl) return err(badUrl);
  const cur = await getSetting("hero");
  const image = (await uploadSite(fd.get("image"), "hero")) ?? cur.image_path ?? null;
  const mobile = (await uploadSite(fd.get("mobile_image"), "hero-mobile")) ?? cur.mobile_image_path ?? null;
  await saveSetting("hero", {
    active: fd.get("active") === "on", eyebrow: String(fd.get("eyebrow") ?? "").trim(),
    title: String(fd.get("title")).trim(), subtitle: String(fd.get("subtitle") ?? "").trim(),
    bg_color: fd.get("bg_color"), text_color: fd.get("text_color"),
    button_label: String(fd.get("button_label") ?? "").trim(), button_url: String(fd.get("button_url") ?? "").trim(),
    secondary_label: String(fd.get("secondary_label") ?? "").trim(), secondary_url: String(fd.get("secondary_url") ?? "").trim(),
    image_path: image, mobile_image_path: mobile,
  });
  ctx.toast("Hero guardado. Recarga la tienda para verlo."); ctx.render();
}

async function submitSection(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  const name = String(fd.get("internal_name") ?? "").trim();
  if (!name) return err("El nombre interno es obligatorio.");
  if (urlError(fd.get("button_url"))) return err(urlError(fd.get("button_url")));
  const limit = Number(fd.get("product_limit") ?? 4);
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) return err("Entre 1 y 12 elementos.");
  const type = fd.get("section_type");
  const image = await uploadSite(fd.get("image"), "section");
  const row = {
    internal_name: name, section_type: type,
    title: String(fd.get("title") ?? "").trim(), subtitle: String(fd.get("subtitle") ?? "").trim(),
    description: String(fd.get("description") ?? "").trim(),
    button_label: String(fd.get("button_label") ?? "").trim(), button_url: String(fd.get("button_url") ?? "").trim(),
    bg_color: fd.get("bg_color"), text_color: fd.get("text_color"), product_limit: limit,
    is_active: fd.get("is_active") === "on", updated_at: new Date().toISOString(),
  };
  if (image) row.image_path = image;

  let sectionId = id;
  if (!id) {
    const { data: max } = await sb.from("site_sections").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    row.sort_order = (max?.sort_order ?? 0) + 10;
    const { data, error } = await sb.from("site_sections").insert(row).select("id").single();
    if (error) return err(errMsg(error));
    sectionId = data.id;
  } else {
    const { error } = await sb.from("site_sections").update(row).eq("id", id);
    if (error) return err(errMsg(error));
  }

  // Elementos: se reemplazan por completo, en el orden marcado.
  const products = fd.getAll("product");
  const categories = fd.getAll("category");
  await sb.from("site_section_items").delete().eq("section_id", sectionId);
  const rows = [
    ...(PRODUCT_TYPES.includes(type) ? products : []).map((p, i) => ({ section_id: sectionId, product_id: p, position: i })),
    ...(type === "featured_categories" ? categories : []).map((c, i) => ({ section_id: sectionId, category_id: c, position: i })),
  ];
  if (rows.length) {
    const { error } = await sb.from("site_section_items").insert(rows);
    if (error) return err(errMsg(error));
  }
  ctx.toast("Sección guardada"); location.hash = "#/contenido/inicio";
}

async function submitBanner(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  const title = String(fd.get("title") ?? "").trim();
  if (!title) return err("El título es obligatorio.");
  if (urlError(fd.get("button_url"))) return err(urlError(fd.get("button_url")));
  const start = fd.get("starts_at") ? toIso(fd.get("starts_at")) : null;
  const end = fd.get("ends_at") ? toIso(fd.get("ends_at")) : null;
  if (start && end && new Date(end) <= new Date(start)) return err("La fecha de fin debe ser posterior al inicio.");
  const image = await uploadSite(fd.get("image"), "banner");
  const row = {
    title, eyebrow: String(fd.get("eyebrow") ?? "").trim(), description: String(fd.get("description") ?? "").trim(),
    bg_color: fd.get("bg_color"), button_label: String(fd.get("button_label") ?? "").trim(),
    button_url: String(fd.get("button_url") ?? "").trim(), starts_at: start, ends_at: end,
    is_published: fd.get("is_published") === "on",
  };
  if (image) row.image_path = image;
  if (id) {
    const { error } = await sb.from("site_banners").update(row).eq("id", id);
    if (error) return err(errMsg(error));
  } else {
    const { data: max } = await sb.from("site_banners").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { error } = await sb.from("site_banners").insert({ ...row, sort_order: (max?.sort_order ?? 0) + 10 });
    if (error) return err(errMsg(error));
  }
  ctx.toast("Banner guardado"); location.hash = "#/contenido/banners";
}

async function submitNav(form) {
  const fd = new FormData(form);
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  const label = String(fd.get("label") ?? "").trim();
  const url = String(fd.get("url") ?? "").trim();
  if (!label || !url) return err("Texto y destino son obligatorios.");
  if (urlError(url)) return err(urlError(url));
  const { data: max } = await sb.from("nav_items").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { error } = await sb.from("nav_items").insert({
    label, url, category_id: fd.get("category_id") || null, parent_id: fd.get("parent_id") || null,
    is_visible: fd.get("is_visible") === "on", sort_order: (max?.sort_order ?? 0) + 10,
  });
  if (error) return err(errMsg(error));
  ctx.toast("Elemento añadido"); ctx.render();
}

async function submitMenuPromo(form) {
  const fd = new FormData(form);
  if (urlError(fd.get("button_url"))) return form.querySelector('[data-err="form"]').textContent = urlError(fd.get("button_url"));
  const cur = await getSetting("menu_promo");
  const image = (await uploadSite(fd.get("image"), "menu-promo")) ?? cur.image_path ?? null;
  await saveSetting("menu_promo", {
    active: fd.get("active") === "on", eyebrow: String(fd.get("eyebrow") ?? "").trim(),
    title: String(fd.get("title") ?? "").trim(), description: String(fd.get("description") ?? "").trim(),
    button_label: String(fd.get("button_label") ?? "").trim(), button_url: String(fd.get("button_url") ?? "").trim(),
    image_path: image,
  });
  ctx.toast("Tarjeta guardada"); ctx.render();
}

async function submitCategory(form) {
  const fd = new FormData(form);
  const id = form.dataset.id;
  const err = (m) => { form.querySelector('[data-err="form"]').textContent = m; };
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return err("El nombre es obligatorio.");
  const slug = slugify(String(fd.get("slug") || name));
  if (!slug) return err("El slug no es válido.");
  const row = {
    name, slug, description: String(fd.get("description") ?? "").trim(),
    parent_id: fd.get("parent_id") || null, sort_order: Number(fd.get("sort_order") ?? 0),
    color: fd.get("color") || null, is_active: fd.get("is_active") === "on",
  };
  const image = await uploadSite(fd.get("image"), "cat");
  const thumb = await uploadSite(fd.get("thumb"), "cat-thumb");
  if (image) row.image_path = image;
  if (thumb) row.thumb_path = thumb;
  const q = id ? sb.from("categories").update(row).eq("id", id) : sb.from("categories").insert(row);
  const { error } = await q;
  if (error) return err(errMsg(error));
  ctx.toast("Categoría guardada"); location.hash = "#/contenido/categorias";
}

// Acciones del módulo (se registran en el manejador general del panel)
export const cmsActs = {
  "cms-team-move": async (el) => {
    const team = await getTeam();
    const i = Number(el.dataset.idx), j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= team.length) return;
    [team[i], team[j]] = [team[j], team[i]];
    await saveTeam(team);
    ctx.render();
  },
  "cms-team-del": async (el) => {
    const ok = await ctx.confirmBox(`¿Quitar a "${el.dataset.name}" del equipo?`, "Eliminar");
    if (!ok) return;
    const team = await getTeam();
    team.splice(Number(el.dataset.idx), 1);
    await saveTeam(team);
    ctx.toast("Integrante eliminado");
    location.hash = "#/contenido/paginas";
  },
  "cms-section-toggle": async (el) => {
    const { error } = await sb.from("site_sections").update({ is_active: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.render();
  },
  "cms-banner-dup": async (el) => {
    const { data: b } = await sb.from("site_banners").select("*").eq("id", el.dataset.id).maybeSingle();
    if (!b) return;
    const { data: max } = await sb.from("site_banners").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { id, created_at, updated_at, ...rest } = b;
    const { error } = await sb.from("site_banners").insert({ ...rest, title: `${b.title} (copia)`, is_published: false, sort_order: (max?.sort_order ?? 0) + 10 });
    if (error) return ctx.fail(error);
    ctx.toast("Banner duplicado (oculto hasta que lo revises)");
    ctx.render();
  },
  "cms-theme-reset": async () => {
    const ok = await ctx.confirmBox("¿Restaurar los colores originales de U3M?", "Restaurar");
    if (!ok) return;
    await saveSetting("theme", { primary: "#e10600", secondary: "#ff3b30", background: "#0c0c0c", surface: "#1a1a1a", text: "#f5f5f5" });
    ctx.toast("Colores restaurados"); ctx.render();
  },
  "cms-move": async (el) => {
    const table = el.dataset.table, id = el.dataset.id, dir = Number(el.dataset.dir);
    const orderCol = table === "nav_items" ? "sort_order" : "sort_order";
    let q = sb.from(table).select("id, sort_order").order(orderCol);
    if (table === "nav_items") {
      // Solo se reordenan hermanos: mismo nivel y mismo padre.
      const { data: cur } = await sb.from("nav_items").select("parent_id").eq("id", id).maybeSingle();
      q = cur?.parent_id ? q.eq("parent_id", cur.parent_id) : q.is("parent_id", null);
    }
    const { data: list } = await q;
    const idx = (list ?? []).findIndex((x) => x.id === id);
    const other = list?.[idx + dir];
    if (idx < 0 || !other) return;
    const a = list[idx], b = other;
    // Intercambio de posiciones; si empatan, se fuerzan valores distintos.
    const aPos = b.sort_order === a.sort_order ? a.sort_order + dir : b.sort_order;
    const bPos = a.sort_order;
    const [r1, r2] = await Promise.all([
      sb.from(table).update({ sort_order: aPos }).eq("id", a.id),
      sb.from(table).update({ sort_order: bPos }).eq("id", b.id),
    ]);
    if (r1.error || r2.error) return ctx.fail(r1.error || r2.error);
    ctx.render();
  },
  "cms-duplicate": async (el) => {
    const { data: s } = await sb.from("site_sections").select("*, site_section_items(product_id, category_id, position)").eq("id", el.dataset.id).maybeSingle();
    if (!s) return;
    const { data: max } = await sb.from("site_sections").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
    const { id, site_section_items, created_at, updated_at, ...rest } = s;
    const { data: copy, error } = await sb.from("site_sections").insert({
      ...rest, internal_name: `${s.internal_name} (copia)`, is_active: false, sort_order: (max?.sort_order ?? 0) + 10,
    }).select("id").single();
    if (error) return ctx.fail(error);
    const items = (site_section_items ?? []).map((i) => ({ section_id: copy.id, product_id: i.product_id, category_id: i.category_id, position: i.position }));
    if (items.length) await sb.from("site_section_items").insert(items);
    ctx.toast("Sección duplicada (oculta hasta que la revises)"); ctx.render();
  },
  "cms-section-del": async (el) => {
    const ok = await ctx.confirmBox(`¿Eliminar la sección "${el.dataset.name}"? Sus productos y categorías no se borran.`, "Eliminar");
    if (!ok) return;
    const { error } = await sb.from("site_sections").delete().eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.toast("Sección eliminada"); ctx.render();
  },
  "cms-banner-publish": async (el) => {
    const { error } = await sb.from("site_banners").update({ is_published: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.render();
  },
  "cms-banner-del": async (el) => {
    const ok = await ctx.confirmBox(`¿Eliminar el banner "${el.dataset.name}"?`, "Eliminar");
    if (!ok) return;
    const { error } = await sb.from("site_banners").delete().eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.toast("Banner eliminado"); ctx.render();
  },
  "cms-nav-save": async (el) => {
    const input = document.querySelector(`[data-nav-label="${el.dataset.id}"]`);
    const label = input?.value.trim();
    if (!label) return ctx.toast("El texto no puede quedar vacío");
    const { error } = await sb.from("nav_items").update({ label }).eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.toast("Texto guardado"); ctx.render();
  },
  "cms-nav-toggle": async (el) => {
    const { error } = await sb.from("nav_items").update({ is_visible: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.render();
  },
  "cms-nav-del": async (el) => {
    const ok = await ctx.confirmBox(`¿Eliminar "${el.dataset.name}" del menú? Si tiene submenús, también se eliminan.`, "Eliminar");
    if (!ok) return;
    const { error } = await sb.from("nav_items").delete().eq("id", el.dataset.id);
    if (error) return ctx.fail(error); // la base impide borrar enlaces esenciales
    ctx.toast("Elemento eliminado"); ctx.render();
  },
  "cms-cat-toggle": async (el) => {
    const { error } = await sb.from("categories").update({ is_active: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.toast(el.dataset.on === "1" ? "Categoría visible" : "Categoría oculta en la tienda"); ctx.render();
  },
  "cms-cat-del": async (el) => {
    const count = Number(el.dataset.count || 0);
    if (count > 0) {
      return ctx.toast(`No se puede eliminar: tiene ${count} producto(s). Muévelos o desactiva la categoría.`);
    }
    const ok = await ctx.confirmBox(`¿Eliminar la categoría "${el.dataset.name}"? Esta acción no se puede deshacer.`, "Eliminar");
    if (!ok) return;
    const { error } = await sb.from("categories").delete().eq("id", el.dataset.id);
    if (error) return ctx.fail(error);
    ctx.toast("Categoría eliminada"); ctx.render();
  },
};

// Envío de formularios del módulo. Devuelve true si el formulario era de este módulo.
export async function cmsSubmit(kind, form) {
  const handlers = {
    "cms-hero": submitHero, "cms-section": submitSection, "cms-banner": submitBanner,
    "cms-nav": submitNav, "cms-menu-promo": submitMenuPromo, "cms-category": submitCategory,
    "cms-theme": submitTheme, "cms-logo": submitLogo, "cms-favicon": submitFavicon, "cms-footer": submitFooter,
    "cms-pages": submitPages, "cms-team": submitTeam,
  };
  const fn = handlers[kind];
  if (!fn) return false;
  await fn(form); // los errores llegan al manejador del panel
  return true;
}
