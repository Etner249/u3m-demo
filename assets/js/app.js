// Tienda U3M: catálogo, ficha, carrito, pedidos, pagos y cuenta del cliente.
// Todo el contenido sale de Supabase. No hay datos de demostración.
import { sb, configured, errMsg, publicUrl, esc, money, TYPE_LABEL, STATUS_LABEL, getSettings } from "./supabase.js";
import { loadCms, navTree } from "./cms.js";

const I = {
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  arrow: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};

const state = {
  session: null, uid: null, settings: {}, categories: [], products: [],
  cart: [], favorites: new Set(), audio: null, playingId: null,
  recovery: false, megaOpen: false, megaNav: null, renderId: 0,
  cms: { nav: [], sections: [], banners: [], bestIds: [] },
};

const app = document.getElementById("app");
const layer = document.getElementById("layer");

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.remove(), 2800);
}

async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* sin cuerpo JSON */ }
    throw new Error(msg);
  }
  return data;
}

function currentRoute() {
  const f = parseRoute().parts[0];
  if (!f) return "home";
  return f === "catalogo" ? "catalog" : f === "producto" ? "product" : f === "nosotros" ? "about" : f === "contacto" ? "contact" : f;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  return { parts, query: new URLSearchParams(qs) };
}

const currency = () => state.settings.currency ?? "USD";
const meta = (p) => [p.genre, p.bpm ? `${p.bpm} BPM` : null, p.musical_key].filter(Boolean).join(" / ");

function requireLogin() {
  if (state.session) return true;
  openAuth("login");
  toast("Inicia sesión para continuar");
  return false;
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
function toView(p) {
  const files = p.product_files ?? [];
  const cover = files.find((f) => f.kind === "cover");
  const preview = files.find((f) => f.kind === "preview_audio") ?? files.find((f) => f.kind === "demo_audio");
  const licenses = (p.product_licenses ?? [])
    .filter((l) => l.is_available && l.license_types)
    .sort((a, b) => a.price_cents - b.price_cents)
    .map((l) => ({
      id: l.license_types.id, code: l.license_types.code, name: l.license_types.name,
      formats: l.license_types.formats ?? [], terms: l.license_types.terms ?? {},
      exclusive: l.license_types.is_exclusive, price: l.price_cents,
    }));
  return {
    ...p,
    genre: p.genres?.name ?? "",
    coverUrl: cover ? publicUrl("product-public", cover.storage_path) : null,
    previewUrl: preview ? publicUrl("product-public", preview.storage_path) : null,
    licenses,
    fromPrice: licenses.length ? licenses[0].price : null,
    category: state.categories.find((c) => c.id === p.category_id) ?? null,
  };
}

async function loadCatalog() {
  const [cats, prods] = await Promise.all([
    sb.from("categories").select("id, slug, name, description, parent_id, sort_order").order("sort_order"),
    sb.from("products")
      .select(`id, type, slug, title, producer, description, bpm, musical_key, price_cents, is_featured,
               published_at, attributes, category_id,
               genres(name),
               product_files(id, kind, bucket, storage_path),
               product_licenses(price_cents, is_available, max_sales,
                 license_types(id, code, name, formats, terms, is_exclusive))`)
      .eq("status", "published")
      .order("published_at", { ascending: false }),
  ]);
  if (cats.error) throw cats.error;
  if (prods.error) throw prods.error;
  state.categories = cats.data ?? [];
  state.products = (prods.data ?? []).map(toView);
}

async function loadUserData() {
  state.favorites = new Set();
  state.cart = [];
  if (!state.session) return;
  const [favs, cart] = await Promise.all([
    sb.from("favorites").select("product_id"),
    sb.from("cart_items").select("product_id, license_type_id"),
  ]);
  state.favorites = new Set((favs.data ?? []).map((f) => f.product_id));
  state.cart = cart.data ?? [];
}

function cartLines() {
  return state.cart.map((c) => {
    const p = state.products.find((x) => x.id === c.product_id);
    if (!p) return null;
    const lic = p.licenses.find((l) => l.id === c.license_type_id);
    if (!lic) return null;
    return { p, lic };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------
function card(p) {
  const fav = state.favorites.has(p.id);
  return `<article class="card" data-href="#/producto/${esc(p.slug)}">
    <div class="cover">
      ${p.coverUrl ? `<img src="${esc(p.coverUrl)}" alt="${esc(p.title)}" loading="lazy" width="500" height="500">` : '<div class="cover-empty"></div>'}
      <span class="chip">${esc(TYPE_LABEL[p.type] ?? p.type)}</span>
      ${p.previewUrl ? `<button class="pbtn" data-action="preview" data-id="${p.id}" aria-label="Escuchar muestra de ${esc(p.title)}">${I.play}</button>` : ""}
    </div>
    <div class="cbody">
      <p class="mono meta" style="margin:0">${esc(meta(p))}</p>
      <h3>${esc(p.title)}</h3>
      <div class="cfoot">
        <div class="price"><small>Desde</small>${p.fromPrice != null ? money(p.fromPrice, currency()) : "—"}</div>
        <a class="btn btn-light" href="#/producto/${esc(p.slug)}">Elegir licencia</a>
      </div>
    </div>
  </article>`;
}

function grid(list, cls = "grid") {
  return list.length ? `<div class="${cls}">${list.map(card).join("")}</div>` : (state.products.length ? emptyBox("Nada por aquí", "Prueba con otra búsqueda o categoría.") : emptyBox("Catálogo en preparación", "Los productos se publicarán muy pronto. Mientras tanto, puedes visitar Nosotros o Contacto."));
}

function emptyBox(title, text) {
  return `<div class="empty"><h2 class="display" style="margin:0 0 10px;font-size:40px">${esc(title)}</h2><p class="note">${esc(text)}</p></div>`;
}

function setupView() {
  return `<div class="wrap ph"><h1 class="display">Tienda sin configurar</h1>
    <p class="note" style="max-width:640px">Falta la clave pública de Supabase en <code>assets/js/config.js</code>.
    Pega la clave anon/publishable del proyecto y recarga la página.</p></div>`;
}

function notFound() {
  return `<div class="wrap ph"><h1 class="display">No encontrado</h1><p><a class="btn btn-light" href="#/catalogo">Ir al catálogo</a></p></div>`;
}

// ---------------------------------------------------------------------------
// Vistas públicas
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Inicio dirigido por el CMS (hero, banners y secciones en el orden del panel)
// ---------------------------------------------------------------------------
const HERO_SVG = `<svg viewBox="0 0 400 400" width="100%" height="100%" aria-hidden="true"><circle cx="200" cy="200" r="190" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".2"/><circle cx="200" cy="200" r="150" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".35"/><circle cx="200" cy="200" r="110" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".55"/><circle cx="200" cy="200" r="70" fill="#0c0c0c"/><circle cx="200" cy="200" r="24" fill="#e10600"/><path d="M60 300 C 120 220, 150 330, 210 250 S 300 170, 350 120" fill="none" stroke="#e10600" stroke-width="6" stroke-linecap="round"/></svg>`;

function heroHtml(h) {
  const fg = h.text_color || "#0c0c0c";
  const img = h.image_path ? publicUrl("product-public", h.image_path) : null;
  const mob = h.mobile_image_path ? publicUrl("product-public", h.mobile_image_path) : null;
  const art = img || mob
    ? `<picture><source media="(max-width:760px)" srcset="${esc(mob ?? img)}"><img src="${esc(img ?? mob)}" alt="" style="width:100%;border-radius:24px;object-fit:cover"></picture>`
    : HERO_SVG;
  return `<section class="hero" style="background:${esc(h.bg_color || "#ffffff")};color:${esc(fg)}" aria-labelledby="ht"><div>
      ${h.eyebrow ? `<p class="mono" style="color:${esc(fg)};opacity:.7;margin:0 0 20px">${esc(h.eyebrow)}</p>` : ""}
      <h1 id="ht" class="display">${esc(h.title ?? "")}</h1>
      <span class="bar" style="margin:28px 0"></span>
      <p class="lead" style="color:${esc(fg)};opacity:.85">${esc(h.subtitle ?? "")}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${h.button_label ? `<a class="btn btn-dark" href="${esc(h.button_url || "#/catalogo")}">${esc(h.button_label)} ${I.arrow}</a>` : ""}
        ${h.secondary_label ? `<a class="btn btn-red" href="${esc(h.secondary_url || "#/catalogo")}">${esc(h.secondary_label)}</a>` : ""}
      </div></div>
    <div class="hero-art">${art}</div></section>`;
}

function bannerHtml(b) {
  const img = b.image_path ? publicUrl("product-public", b.image_path) : null;
  const style = `${b.bg_color ? `background:${esc(b.bg_color)};` : ""}${img ? `background-image:url('${esc(img)}');background-size:cover;background-position:center;` : ""}`;
  return `<section class="block"><a class="banner-cms" href="${esc(b.button_url || "#/catalogo")}" style="${style}">
    <div>${b.eyebrow ? `<span class="chip" style="background:#fff;color:#0c0c0c">${esc(b.eyebrow)}</span>` : ""}
      <h2 class="display">${esc(b.title)}</h2>
      ${b.description ? `<p class="note" style="color:#fff;font-size:16px;max-width:520px">${esc(b.description)}</p>` : ""}
      ${b.button_label ? `<span class="btn btn-red" style="margin-top:16px">${esc(b.button_label)} ${I.arrow}</span>` : ""}</div>
  </a></section>`;
}

// Productos de una sección: manual si hay elementos; si no, automático por tipo.
function productsFor(sec) {
  const items = (sec.site_section_items ?? []).filter((i) => i.product_id).sort((a, b) => a.position - b.position);
  let list;
  if (items.length) list = items.map((i) => state.products.find((p) => p.id === i.product_id)).filter(Boolean);
  else if (sec.section_type === "featured_products") list = state.products.filter((p) => p.is_featured);
  else if (sec.section_type === "new_releases") list = state.products;
  else if (sec.section_type === "best_sellers") list = state.cms.bestIds.map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
  else list = [];
  return list.slice(0, sec.product_limit ?? 4);
}

function sectionHtml(sec) {
  const fg = sec.text_color ? `color:${esc(sec.text_color)};` : "";
  const style = `${sec.bg_color ? `background:${esc(sec.bg_color)};` : ""}${fg}`;
  const head = sec.title || sec.subtitle || sec.button_label ? `<div class="sh"><div>
      ${sec.title ? `<h2 class="display" style="${fg}">${esc(sec.title)}</h2>` : ""}
      ${sec.subtitle ? `<p class="note" style="margin:12px 0 0">${esc(sec.subtitle)}</p>` : ""}
      <span class="bar"></span></div>
    ${sec.button_label ? `<a href="${esc(sec.button_url || "#/catalogo")}">${esc(sec.button_label)} →</a>` : ""}</div>` : "";
  const img = sec.image_path ? publicUrl("product-public", sec.image_path) : null;
  const body = sec.description ? `<p style="font-size:18px;line-height:1.6;color:var(--soft);${fg}">${esc(sec.description)}</p>` : "";

  switch (sec.section_type) {
    case "featured_products":
    case "new_releases":
    case "best_sellers":
    case "collection": {
      const list = productsFor(sec);
      return list.length ? `<section class="block" style="${style}">${head}${grid(list)}</section>` : "";
    }
    case "featured_categories": {
      const cats = (sec.site_section_items ?? []).filter((i) => i.category_id).sort((a, b) => a.position - b.position)
        .map((i) => state.categories.find((c) => c.id === i.category_id)).filter(Boolean).slice(0, sec.product_limit ?? 8);
      if (!cats.length) return "";
      return `<section class="block" style="${style}">${head}<div class="cat-cards">${cats.map((c) => {
        const thumb = c.thumb_path || c.image_path;
        return `<a class="cat-card" href="#/catalogo/${esc(c.slug)}" style="${c.color ? `background:${esc(c.color)}` : ""}">
          ${thumb ? `<img src="${esc(publicUrl("product-public", thumb))}" alt="">` : ""}
          <b class="display">${esc(c.name)}</b></a>`;
      }).join("")}</div></section>`;
    }
    case "promo_banner":
      return `<section class="block"><a class="promo-block" href="${esc(sec.button_url || "#/catalogo")}" style="${style}${img ? `background-image:url('${esc(img)}');background-size:cover;background-position:center;` : ""}">
        <div>${sec.subtitle ? `<span class="mono">${esc(sec.subtitle)}</span>` : ""}
          <h2 class="display">${esc(sec.title)}</h2>${body}
          ${sec.button_label ? `<span class="btn btn-light" style="margin-top:14px">${esc(sec.button_label)}</span>` : ""}</div></a></section>`;
    case "image_text":
      return `<section class="block image-text" style="${style}">
        ${img ? `<img src="${esc(img)}" alt="" style="width:100%;border-radius:var(--r-panel);object-fit:cover;aspect-ratio:4/3">` : ""}
        <div>${head}${body}</div></section>`;
    case "editorial":
    default:
      return `<section class="block process" style="${style}grid-template-columns:1fr">
        <div>${head}${body}</div></section>`;
  }
}

function viewHome() {
  if (!state.cms.nav.length && !state.cms.sections.length) return viewHomeLegacy();
  const h = state.settings.hero ?? {};
  return `${h.active === false ? "" : `<div class="wrap">${heroHtml(h)}</div>`}
    <div class="wrap">
    <ul class="features" style="padding:0" aria-label="Ventajas">
      <li><b>Descarga tras el pago</b><span>Enlaces temporales al confirmar la compra.</span></li>
      <li><b>Licencias por producto</b><span>Cada producto ofrece sus niveles.</span></li>
      <li><b>Formato por archivo</b><span>Según la ficha de cada producto.</span></li>
      <li><b>Pago verificado</b><span>Se valida en el servidor antes de habilitar la descarga.</span></li>
      <li class="hot"><b>Pago único</b><span>Sin suscripciones.</span></li>
    </ul>
    ${state.cms.banners.map(bannerHtml).join("")}
    ${state.cms.sections.map(sectionHtml).join("")}
    </div>`;
}

function viewHomeLegacy() {
  const featured = state.products.filter((p) => p.is_featured).slice(0, 8);
  const news = state.products.filter((p) => !p.is_featured).slice(0, 8);
  const topCats = state.categories.filter((c) => !c.parent_id);
  const hero = featured[0] ?? state.products[0];
  return `<div class="wrap">
    <section class="hero" aria-labelledby="ht"><div>
      <p class="mono" style="color:#555;margin:0 0 20px">Instrumentales con licencia por nivel</p>
      <h1 id="ht" class="display">Beats que<br><span style="color:var(--red)">rompen</span> calle.</h1>
      <span class="bar" style="margin:28px 0"></span>
      <p class="lead">Compra una vez, descarga al confirmar el pago y usa cada producto según la licencia que elegiste.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap"><a class="btn btn-dark" href="#/catalogo">Explorar catálogo ${I.arrow}</a>
        <a class="btn btn-red" href="#/catalogo/drum-kits">Ver Drum Kits</a></div></div>
      <div class="hero-art">
        <svg viewBox="0 0 400 400" width="100%" height="100%" aria-hidden="true"><circle cx="200" cy="200" r="190" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".2"/><circle cx="200" cy="200" r="150" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".35"/><circle cx="200" cy="200" r="110" fill="none" stroke="#0c0c0c" stroke-width="1.5" opacity=".55"/><circle cx="200" cy="200" r="70" fill="#0c0c0c"/><circle cx="200" cy="200" r="24" fill="#e10600"/><path d="M60 300 C 120 220, 150 330, 210 250 S 300 170, 350 120" fill="none" stroke="#e10600" stroke-width="6" stroke-linecap="round"/></svg>
        ${hero ? `<a class="np" href="#/producto/${esc(hero.slug)}"><span class="play">${I.play}</span><span style="min-width:0"><b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(hero.title)}</b><span class="mono" style="color:rgba(255,255,255,.7)">${esc(meta(hero))}</span></span></a>` : ""}
      </div>
    </section>
    <ul class="features" style="padding:0" aria-label="Ventajas">
      <li><b>Descarga tras el pago</b><span>Enlaces temporales al confirmar la compra.</span></li>
      <li><b>Licencias por producto</b><span>Cada producto ofrece sus niveles.</span></li>
      <li><b>Formato por archivo</b><span>Según la ficha de cada producto.</span></li>
      <li><b>Pago verificado</b><span>Se valida en el servidor antes de habilitar la descarga.</span></li>
      <li class="hot"><b>Pago único</b><span>Sin suscripciones.</span></li>
    </ul>
    ${bannersHtml()}
    ${promoHtml()}
    ${featured.length ? `<section class="block"><div class="sh"><div><h2 class="display">Destacados</h2><span class="bar"></span></div><a href="#/catalogo">Ver todo →</a></div>${grid(featured)}</section>` : ""}
    ${topCats.length ? `<section class="block"><div class="sh"><div><h2 class="display">Por <span style="color:var(--red)">categoría</span></h2><span class="bar"></span></div></div>
      <div class="pills">${topCats.map((c, i) => `<a href="#/catalogo/${esc(c.slug)}" class="${i ? "" : "first"}">${esc(c.name)}</a>`).join("")}</div></section>` : ""}
    <section class="block process"><h2 class="display" style="margin:0;font-size:clamp(36px,4.6vw,56px)">Compra hoy.<br>Tuyo <span style="color:var(--red)">para siempre.</span></h2>
      <ol>
        <li><span class="mono" style="color:var(--red2)">Paso 01</span><b class="display" style="font-size:30px">Escucha</b><span class="note">Reproduce la muestra antes de decidir.</span></li>
        <li><span class="mono" style="color:var(--red2)">Paso 02</span><b class="display" style="font-size:30px">Compra</b><span class="note">Pago único. Aplica tu cupón en el checkout.</span></li>
        <li><span class="mono" style="color:var(--red2)">Paso 03</span><b class="display" style="font-size:30px">Descarga</b><span class="note">Todo queda en tu biblioteca.</span></li>
      </ol></section>
    ${news.length ? `<section class="block"><div class="sh"><div><h2 class="display">Novedades</h2><span class="bar"></span></div><a href="#/catalogo">Catálogo →</a></div>${grid(news)}</section>` : ""}
  </div>`;
}

// Banners activos (gestionados desde Portada en el panel).
function bannersHtml() {
  const list = (Array.isArray(state.settings.banners) ? state.settings.banners : [])
    .filter((b) => b.active && b.image_path)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  if (!list.length) return "";
  return `<section class="block" aria-label="Banners">${list.map((b) => `
    <a href="${esc(b.link || "#/catalogo")}" class="card" style="display:block;padding:0;overflow:hidden;margin-bottom:16px;border-radius:var(--r-panel)">
      <img src="${esc(publicUrl("product-public", b.image_path))}" alt="${esc(b.title ?? "")}" style="width:100%;max-height:360px;object-fit:cover">
    </a>`).join("")}</section>`;
}

// Promoción destacada (gestionada desde Portada).
function promoHtml() {
  const p = state.settings.promo ?? {};
  if (!p.active) return "";
  const img = p.image_path ? publicUrl("product-public", p.image_path) : null;
  return `<section class="block"><a href="${esc(p.link || "#/catalogo")}" class="process" style="grid-template-columns:${img ? "1fr 1fr" : "1fr"};align-items:center">
    <div><span class="mono" style="color:var(--red2)">Promoción</span>
      <h2 class="display" style="margin:12px 0 0;font-size:clamp(36px,4.6vw,56px)">${esc(p.title ?? "")}</h2>
      <p class="note" style="font-size:17px;margin-top:14px">${esc(p.text ?? "")}</p></div>
    ${img ? `<img src="${esc(img)}" alt="" style="width:100%;border-radius:22px;object-fit:cover">` : ""}
  </a></section>`;
}

function viewCatalog(slug, query) {
  const q = (state.q ?? "").toLowerCase();
  const current = state.categories.find((c) => c.slug === slug) ?? null;
  const inCat = (p) => {
    if (!current) return true;
    if (p.category_id === current.id) return true;
    return !!p.category && p.category.parent_id === current.id;
  };
  const list = state.products.filter((p) => inCat(p) &&
    (!q || `${p.title} ${p.genre} ${TYPE_LABEL[p.type] ?? ""}`.toLowerCase().includes(q)));
  const top = state.categories.filter((c) => !c.parent_id);
  const side = `<a href="#/catalogo" class="${current ? "" : "on"}">Todo el catálogo</a>` + top.map((c) => {
    const subs = state.categories.filter((k) => k.parent_id === c.id);
    return `<a href="#/catalogo/${esc(c.slug)}" class="${current?.slug === c.slug ? "on" : ""}">${esc(c.name)}</a>` +
      subs.map((k) => `<a class="sub ${current?.slug === k.slug ? "on" : ""}" href="#/catalogo/${esc(k.slug)}">${esc(k.name)}</a>`).join("");
  }).join("");
  return `<div class="wrap"><div class="ph"><p class="mono" style="color:var(--mute)">Inicio / Catálogo${current ? " / " + esc(current.name) : ""}</p>
    <h1 class="display">${current ? esc(current.name) : "Catálogo"}</h1><span class="bar"></span></div>
    <div class="cat-layout"><aside class="side"><h4 class="mono" style="color:var(--mute)">Categoría</h4>${side}</aside>
    <div><label class="search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Buscar por título, estilo o formato" value="${esc(state.q ?? "")}" aria-label="Buscar"></label>
    <p class="mono" style="color:var(--mute);margin:0 0 20px">${list.length} resultado${list.length === 1 ? "" : "s"}</p>
    ${grid(list, "grid cat3")}</div></div></div>`;
}

function viewProduct(slug) {
  const p = state.products.find((x) => x.slug === slug);
  if (!p) return notFound();
  const related = state.products.filter((x) => x.id !== p.id && x.category_id === p.category_id).slice(0, 4);
  const fav = state.favorites.has(p.id);
  return `<div class="wrap"><p class="mono" style="color:var(--mute);margin-top:36px"><a href="#/">Inicio</a> / <a href="#/catalogo/${esc(p.category?.slug ?? "")}">${esc(p.category?.name ?? "Catálogo")}</a> / ${esc(p.title)}</p>
    <div class="pd"><div class="cover">${p.coverUrl ? `<img src="${esc(p.coverUrl)}" alt="${esc(p.title)}" width="1000" height="1000">` : '<div class="cover-empty"></div>'}</div>
    <div><span class="chip" style="background:var(--smoke)">${esc(TYPE_LABEL[p.type] ?? p.type)}</span>
      <h1 class="display">${esc(p.title)}</h1><span class="bar" style="width:96px;margin-top:18px"></span>
      ${p.producer ? `<p class="mono" style="color:var(--mute);margin:18px 0 0">Por ${esc(p.producer)}</p>` : ""}
      <p style="font-size:19px;line-height:1.55;color:var(--soft);margin:22px 0 0">${esc(p.description)}</p>
      <div class="specs">
        <div><span class="mono">Tipo</span><b>${esc(TYPE_LABEL[p.type] ?? p.type)}</b></div>
        <div><span class="mono">BPM</span><b>${p.bpm ?? "—"}</b></div>
        <div><span class="mono">Tono</span><b>${esc(p.musical_key ?? "—")}</b></div>
      </div>
      ${p.previewUrl ? `<button class="btn btn-light" data-action="preview" data-id="${p.id}" style="margin-bottom:22px">${I.play} Escuchar muestra</button>` : ""}
      <h2 class="mono" style="color:var(--mute);margin:12px 0 0">Elige tu licencia</h2>
      ${p.licenses.length ? `<div class="lic" role="radiogroup">${p.licenses.map((l, i) => `
        <div><input type="radio" name="lic" id="l${i}" value="${l.id}" ${i ? "" : "checked"}>
        <label for="l${i}"><span><b>${esc(l.name)}</b><small>${esc(l.formats.join(" · "))}${l.exclusive ? " · exclusiva" : ""}</small></span><span class="lp">${money(l.price, currency())}</span></label></div>`).join("")}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <button class="btn btn-red" data-action="add-to-cart" data-id="${p.id}">Añadir al carrito</button>
          <button class="btn btn-dark" data-action="fav" data-id="${p.id}">${fav ? "Quitar de favoritos" : "Guardar en favoritos"}</button>
        </div>`
        : `<p class="note">Este producto no tiene licencias disponibles por ahora.</p>`}
      <p class="note" style="margin-top:18px">${esc(p.licenses[0]?.terms?.uses ?? "")}</p>
    </div></div>
    ${related.length ? `<section class="block"><div class="sh"><div><h2 class="display">También te puede gustar</h2><span class="bar"></span></div></div>${grid(related)}</section>` : ""}
  </div>`;
}

function viewContact() {
  const c = state.settings.contact ?? {};
  const hasInfo = !!(c.email || c.phone || c.hours);
  const f = 'width:100%;height:52px;border-radius:16px;border:0;background:var(--paper);color:var(--ink);padding:0 16px;font:inherit;margin-top:8px';
  return `<div class="wrap"><div class="ph"><p class="mono" style="color:var(--mute)">Inicio / Contacto</p><h1 class="display">Hablemos.</h1><span class="bar"></span></div>
  <div style="display:grid;gap:32px;grid-template-columns:${hasInfo ? "minmax(0,1.3fr) minmax(0,1fr)" : "minmax(0,1fr)"};margin:48px 0 96px">
    <form data-form="contact" style="background:var(--smoke);border-radius:28px;padding:clamp(24px,4vw,44px);display:grid;gap:18px">
      <label class="mono" style="color:var(--mute)">Tu nombre<input name="name" required maxlength="120" style="${f}"></label>
      <label class="mono" style="color:var(--mute)">Tu correo<input name="email" type="email" required maxlength="200" style="${f}"></label>
      <label class="mono" style="color:var(--mute)">Motivo<select name="reason" style="${f}"><option>Encargo personalizado</option><option>Licencia o compra</option><option>Soporte técnico</option><option>Otro</option></select></label>
      <label class="mono" style="color:var(--mute)">Mensaje<textarea name="message" required rows="5" maxlength="5000" style="width:100%;border-radius:16px;border:0;background:var(--paper);color:var(--ink);padding:14px 16px;font:inherit;margin-top:8px"></textarea></label>
      <button class="btn btn-red" type="submit" style="justify-self:start">Enviar mensaje</button>
      <p class="msg mono" data-msg hidden style="color:var(--red)"></p>
    </form>
    ${hasInfo ? `<aside style="display:grid;gap:20px;align-content:start">
      ${c.email ? `<div style="border:1px solid var(--line2);border-radius:20px;padding:24px"><p class="mono" style="color:var(--mute)">Correo</p><p class="display" style="font-size:26px;margin:10px 0 0"><a href="mailto:${esc(c.email)}" style="color:inherit">${esc(c.email)}</a></p></div>` : ""}
      ${c.phone ? `<div style="border:1px solid var(--line2);border-radius:20px;padding:24px"><p class="mono" style="color:var(--mute)">Teléfono / WhatsApp</p><p class="display" style="font-size:26px;margin:10px 0 0">${esc(c.phone)}</p></div>` : ""}
      ${c.hours ? `<div style="border:1px solid var(--line2);border-radius:20px;padding:24px"><p class="mono" style="color:var(--mute)">Horario de atención</p><p style="font-size:18px;margin:10px 0 0">${esc(c.hours)}</p></div>` : ""}
    </aside>` : ""}</div></div>`;
}

function viewAbout() {
  const paras = String(state.settings.about ?? "").split(/\n\s*\n/).filter(Boolean);
  const team = Array.isArray(state.settings.team) ? state.settings.team : [];
  return `<div class="wrap"><div class="ph"><p class="mono" style="color:var(--mute)">Inicio / Nosotros</p><h1 class="display">Nosotros</h1><span class="bar"></span></div>
  ${team.length ? `<h2 class="mono" style="color:var(--mute);margin:48px 0 20px">El equipo</h2>
  <div style="display:grid;gap:24px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${team.map((m) => `
    <article class="card"><img src="${esc(publicUrl("product-public", m.photo_path) ?? "")}" alt="${esc(m.name)}" style="width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:16px">
    <div style="padding:20px 6px 8px"><p class="display" style="font-size:30px;margin:0">${esc(m.name)}</p><p class="mono" style="color:var(--mute);margin-top:8px">${esc(m.role ?? "")}</p></div></article>`).join("")}</div>` : ""}
  <section style="background:var(--smoke);border-radius:28px;padding:clamp(28px,5vw,64px);margin:64px 0 96px">
    ${paras.length ? paras.map((t) => `<p style="font-size:18px;color:var(--soft);line-height:1.6">${esc(t)}</p>`).join("") : emptyBox("Sin contenido", "El administrador aún no ha publicado esta página.")}
  </section></div>`;
}

function viewLegal(key) {
  const map = { terminos: ["Términos y condiciones", "terms"], privacidad: ["Política de privacidad", "privacy"] };
  const entry = map[key];
  if (!entry) return notFound();
  const paras = String(state.settings[entry[1]] ?? "").split(/\n\s*\n/).filter(Boolean);
  return `<div class="wrap"><div class="ph"><h1 class="display">${esc(entry[0])}</h1><span class="bar"></span></div>
  <section style="margin:40px 0 96px;max-width:760px">${paras.length ? paras.map((t) => `<p style="font-size:17px;color:var(--soft);line-height:1.6">${esc(t)}</p>`).join("") : emptyBox("Pendiente", "Este texto aún no ha sido publicado.")}</section></div>`;
}

function viewCheckout() {
  if (!state.session) return `<div class="wrap ph"><h1 class="display">Inicia sesión</h1><p><button class="btn btn-light" data-action="open-auth">Entrar</button></p></div>`;
  const lines = cartLines();
  const total = lines.reduce((s, x) => s + x.lic.price, 0);
  return `<div class="wrap ph"><h1 class="display">Checkout</h1><span class="bar"></span></div>
  <div class="cat-layout" style="grid-template-columns:1fr 360px;margin-bottom:96px">
    <div>${lines.length ? lines.map((x) => `<div class="ci" style="grid-template-columns:64px 1fr auto">
        ${x.p.coverUrl ? `<img src="${esc(x.p.coverUrl)}" alt="" width="64" height="64">` : '<div class="cover-empty" style="width:64px;height:64px"></div>'}
        <div><b>${esc(x.p.title)}</b><p class="mono" style="color:var(--mute);margin:4px 0 0">${esc(x.lic.name)}</p></div>
        <div style="text-align:right"><b>${money(x.lic.price, currency())}</b><br><button style="background:none;border:0;color:var(--red2);font-weight:700;padding:6px 0" data-action="remove-cart" data-id="${x.p.id}">Quitar</button></div></div>`).join("")
      : emptyBox("Tu carrito está vacío", "Añade productos desde el catálogo.")}</div>
    <aside style="background:var(--smoke);border-radius:28px;padding:28px;display:grid;gap:14px;align-content:start">
      <label class="mono" style="color:var(--mute)">Cupón<input id="coupon" maxlength="40" style="width:100%;height:48px;border-radius:14px;border:0;background:var(--paper);color:var(--ink);padding:0 14px;font:inherit;margin-top:8px"></label>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="mono" style="color:var(--mute)">Subtotal</span><b class="display" style="font-size:28px">${money(total, currency())}</b></div>
      <p class="note">El descuento y el total final se calculan en el servidor al crear el pedido.</p>
      <button class="btn btn-red" data-action="create-order" ${lines.length ? "" : "disabled"} style="justify-content:center">Crear pedido y pagar</button>
    </aside></div>`;
}

async function viewOrder(id, query) {
  const { data: order, error } = await sb.from("orders")
    .select(`id, status, subtotal_cents, discount_cents, total_cents, currency, created_at, paid_at,
             order_items(unit_price_cents, products(title, slug), license_types(name)),
             payments(id, provider, status, created_at)`)
    .eq("id", id).maybeSingle();
  if (error) throw error;
  if (!order) return notFound();

  // Retorno de PayPal: el servidor captura y verifica. Aquí solo se pide la verificación.
  const ppToken = query.get("token");
  if (ppToken && order.status === "pending") {
    try {
      const r = await callFn("paypal-capture-order", { order_id: order.id, paypal_order_id: ppToken });
      toast(r?.status === "manual_review" ? "Pago recibido: queda en revisión manual" : "Pago confirmado");
      return viewOrder(id, new URLSearchParams());
    } catch (e) {
      toast(e.message);
    }
  }

  const s = state.settings.payment_methods ?? {};
  const items = (order.order_items ?? []).map((i) =>
    `<li class="mono" style="display:flex;justify-content:space-between;gap:12px"><span>${esc(i.products?.title)} · ${esc(i.license_types?.name)}</span><span>${money(i.unit_price_cents, order.currency)}</span></li>`).join("");
  const pendingYape = (order.payments ?? []).find((p) => p.provider === "yape" && p.status === "manual_review");

  let actions = "";
  if (order.status === "pending") {
    actions = `
      ${s.paypal ? `<button class="btn btn-red" data-action="pay-paypal" data-id="${order.id}">Pagar con PayPal</button>` : ""}
      ${s.yape && !pendingYape ? `<div class="chip" style="background:var(--smoke);padding:14px 18px;border-radius:20px;display:grid;gap:8px;text-transform:none;letter-spacing:0;font-family:inherit;font-size:15px">
          <b>Pago con Yape</b><span>Número: ${esc(s.yape_number ?? "")}</span><span>Titular: ${esc(s.yape_holder ?? "")}</span>
          <span style="color:var(--mute)">Envía ${money(order.total_cents, order.currency)} y escribe el código de operación.</span>
          <form data-form="yape" data-order="${order.id}" style="display:flex;gap:10px;flex-wrap:wrap">
            <input name="code" required minlength="4" maxlength="40" placeholder="Código de operación" style="flex:1;min-width:180px;height:46px;border-radius:14px;border:0;background:var(--paper);color:var(--ink);padding:0 14px;font:inherit">
            <button class="btn btn-dark" type="submit">Enviar código</button></form></div>` : ""}
      ${pendingYape ? `<p class="note">Tu pago con Yape está en revisión. Te avisaremos cuando se confirme.</p>` : ""}`;
  } else if (order.status === "paid") {
    actions = `<p class="note">Pedido pagado. Tus descargas están en <a href="#/cuenta/biblioteca" style="color:var(--red2);font-weight:700">Mi biblioteca</a>.</p>`;
  }

  return `<div class="wrap"><div class="ph"><p class="mono" style="color:var(--mute)">Pedido ${esc(order.id.slice(0, 8))}</p>
    <h1 class="display">${esc(STATUS_LABEL[order.status] ?? order.status)}</h1><span class="bar"></span></div>
    <div class="cat-layout" style="grid-template-columns:1fr 360px;margin-bottom:96px">
      <section style="background:var(--smoke);border-radius:28px;padding:28px">
        <ul style="list-style:none;padding:0;margin:0;display:grid;gap:12px">${items}</ul>
        <div style="border-top:1px solid var(--line);margin-top:18px;padding-top:14px;display:grid;gap:6px">
          ${order.discount_cents ? `<span class="mono" style="color:var(--mute)">Descuento: −${money(order.discount_cents, order.currency)}</span>` : ""}
          <b class="display" style="font-size:28px">Total ${money(order.total_cents, order.currency)}</b></div>
      </section>
      <aside style="background:var(--smoke);border-radius:28px;padding:28px;display:grid;gap:14px;align-content:start">
        <span class="mono" style="color:var(--mute)">Creado ${new Date(order.created_at).toLocaleString("es-PE")}</span>
        ${actions}
      </aside></div></div>`;
}

// ---------------------------------------------------------------------------
// Cuenta del cliente
// ---------------------------------------------------------------------------
async function viewAccount(section = "perfil") {
  if (!state.session) return `<div class="wrap ph"><h1 class="display">Inicia sesión</h1><p><button class="btn btn-light" data-action="open-auth">Entrar</button></p></div>`;
  const tabs = [["perfil", "Perfil"], ["biblioteca", "Mi biblioteca"], ["compras", "Mis compras"],
    ["favoritos", "Mis favoritos"], ["descargas", "Descargas"], ["seguridad", "Contraseña"]];
  const nav = `<nav class="side" style="display:grid;gap:4px">${tabs.map(([k, l]) =>
    `<a href="#/cuenta/${k}" class="${section === k ? "on" : ""}">${l}</a>`).join("")}
    <button class="btn btn-dark" data-action="logout" style="margin-top:12px">Cerrar sesión</button></nav>`;
  let body = "";
  if (section === "perfil") body = await accountProfile();
  else if (section === "biblioteca") body = await accountLibrary();
  else if (section === "compras") body = await accountOrders();
  else if (section === "favoritos") body = await accountFavorites();
  else if (section === "descargas") body = await accountDownloads();
  else if (section === "seguridad") body = accountSecurity();
  else return notFound();
  return `<div class="wrap"><div class="ph"><p class="mono" style="color:var(--mute)">Inicio / Mi cuenta</p><h1 class="display">Mi cuenta</h1><span class="bar"></span></div>
    <div class="cat-layout" style="grid-template-columns:220px 1fr;margin-bottom:96px">${nav}<div>${body}</div></div></div>`;
}

async function accountProfile() {
  const { data: prof } = await sb.from("profiles").select("display_name, avatar_path, preferences").eq("id", state.uid).maybeSingle();
  const avatar = prof?.avatar_path ? publicUrl("avatars", prof.avatar_path) : null;
  const f = 'width:100%;height:50px;border-radius:14px;border:0;background:var(--paper);color:var(--ink);padding:0 14px;font:inherit;margin-top:8px';
  return `<form data-form="profile" style="background:var(--smoke);border-radius:28px;padding:28px;display:grid;gap:16px;max-width:560px">
    <div style="display:flex;gap:16px;align-items:center">${avatar ? `<img src="${esc(avatar)}" alt="" width="72" height="72" style="border-radius:50%;object-fit:cover">` : '<div class="cover-empty" style="width:72px;height:72px;border-radius:50%"></div>'}
      <label class="mono" style="color:var(--mute)">Imagen de perfil (JPG/PNG, máx. 5 MB)<input type="file" name="avatar" accept="image/jpeg,image/png,image/webp" style="display:block;margin-top:8px;color:var(--soft)"></label></div>
    <label class="mono" style="color:var(--mute)">Nombre<input name="display_name" maxlength="80" value="${esc(prof?.display_name ?? "")}" style="${f}"></label>
    <label style="display:flex;gap:10px;align-items:center;color:var(--soft)"><input type="checkbox" name="news" ${prof?.preferences?.news ? "checked" : ""}> Recibir avisos de nuevos productos</label>
    <button class="btn btn-red" type="submit" style="justify-self:start">Guardar cambios</button>
    <p class="msg mono" data-msg hidden style="color:var(--red)"></p></form>`;
}

async function accountLibrary() {
  const { data: lics, error } = await sb.from("issued_licenses")
    .select("id, license_code, issued_at, product_id, products(id, title, slug, type), license_types(name, formats)")
    .is("revoked_at", null).order("issued_at", { ascending: false });
  if (error) throw error;
  if (!lics?.length) return emptyBox("Tu biblioteca está vacía", "Cuando completes una compra, aparecerá aquí.");
  const ids = [...new Set(lics.map((l) => l.product_id))];
  const { data: files } = await sb.from("product_files").select("id, kind, product_id, size_bytes")
    .in("product_id", ids).eq("bucket", "product-private");
  return `<div style="display:grid;gap:16px">${lics.map((l) => {
    const pf = (files ?? []).filter((f) => f.product_id === l.product_id);
    return `<article style="background:var(--smoke);border-radius:22px;padding:22px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><b class="display" style="font-size:24px">${esc(l.products?.title)}</b>
        <p class="mono" style="color:var(--mute);margin:6px 0 0">${esc(l.license_types?.name)} · ${esc(l.license_code)}</p></div>
        <span class="chip" style="background:var(--paper)">${esc((l.license_types?.formats ?? []).join(" · "))}</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">${pf.map((f) =>
        `<button class="btn btn-light" style="height:42px;padding:0 16px;font-size:14px" data-action="download" data-file="${f.id}">Descargar ${esc(kindLabel(f.kind))}</button>`).join("") || '<span class="note">Sin archivos disponibles.</span>'}</div>
    </article>`;
  }).join("")}</div>`;
}

function kindLabel(k) {
  return ({ original_mp3: "MP3", wav: "WAV", stems: "stems", kit_archive: "kit", plugin_installer: "instalador",
    user_manual: "manual", license_document: "licencia" })[k] ?? k;
}

async function accountOrders() {
  const { data, error } = await sb.from("orders")
    .select("id, status, total_cents, currency, created_at, paid_at, order_items(products(title)), payments(provider, status)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!data?.length) return emptyBox("Sin compras", "Tu historial de pedidos aparecerá aquí.");
  return `<div style="display:grid;gap:12px">${data.map((o) => `
    <a href="#/pedido/${o.id}" style="background:var(--smoke);border-radius:22px;padding:20px;display:grid;gap:6px">
      <div style="display:flex;justify-content:space-between;gap:12px"><b>${(o.order_items ?? []).map((i) => esc(i.products?.title)).join(", ")}</b><b>${money(o.total_cents, o.currency)}</b></div>
      <span class="mono" style="color:var(--mute)">${new Date(o.created_at).toLocaleDateString("es-PE")} · ${esc(STATUS_LABEL[o.status] ?? o.status)}${o.payments?.[0] ? " · " + esc(o.payments[0].provider) : ""}</span>
    </a>`).join("")}</div>`;
}

async function accountFavorites() {
  const { data } = await sb.from("favorites").select("product_id").order("created_at", { ascending: false });
  const list = (data ?? []).map((f) => state.products.find((p) => p.id === f.product_id)).filter(Boolean);
  return list.length ? grid(list, "grid") : emptyBox("Sin favoritos", "Guarda productos desde su ficha.");
}

async function accountDownloads() {
  const { data, error } = await sb.from("downloads")
    .select("id, created_at, products(title), product_files(kind)").order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  if (!data?.length) return emptyBox("Sin descargas", "Tu historial de descargas aparecerá aquí.");
  return `<div style="display:grid;gap:8px">${data.map((d) => `<div style="background:var(--smoke);border-radius:18px;padding:16px 20px;display:flex;justify-content:space-between;gap:12px">
    <span>${esc(d.products?.title)} · ${esc(kindLabel(d.product_files?.kind))}</span><span class="mono" style="color:var(--mute)">${new Date(d.created_at).toLocaleString("es-PE")}</span></div>`).join("")}</div>`;
}

function accountSecurity() {
  const f = 'width:100%;height:50px;border-radius:14px;border:0;background:var(--paper);color:var(--ink);padding:0 14px;font:inherit;margin-top:8px';
  return `${state.recovery ? `<p class="note" style="margin-bottom:16px">Define tu nueva contraseña.</p>` : ""}
  <form data-form="password" style="background:var(--smoke);border-radius:28px;padding:28px;display:grid;gap:16px;max-width:560px">
    <label class="mono" style="color:var(--mute)">Nueva contraseña (mínimo 8 caracteres)<input name="password" type="password" minlength="8" required autocomplete="new-password" style="${f}"></label>
    <label class="mono" style="color:var(--mute)">Repite la contraseña<input name="confirm" type="password" minlength="8" required autocomplete="new-password" style="${f}"></label>
    <button class="btn btn-red" type="submit" style="justify-self:start">Cambiar contraseña</button>
    <p class="msg mono" data-msg hidden style="color:var(--red)"></p></form>`;
}

// ---------------------------------------------------------------------------
// Layout: cabecera, menú, carrito, login
// ---------------------------------------------------------------------------
// Menú: lo administra el CMS (nav_items). Si aún no existe, se usa el menú original.
function isActiveUrl(url) {
  const h = location.hash || "#/";
  return url === "#/" ? (h === "#/" || h === "#") : h.startsWith(url);
}

function renderNav(route) {
  const tree = navTree(state.cms.nav);
  const navEl = document.getElementById("nav");
  const open = state.megaOpen ? state.megaNav : null;
  if (tree.length) {
    navEl.innerHTML = tree.map((t) => t.children.length
      ? `<button aria-expanded="${open === t.id}" aria-controls="mega" class="${open === t.id ? "active" : ""}" data-action="toggle-mega" data-nav="${t.id}">${esc(t.label)} ${I.chev}</button>`
      : `<a href="${esc(t.url)}" class="${isActiveUrl(t.url) && !open ? "active" : ""}">${esc(t.label)}</a>`
    ).join("");
  } else {
    const links = [["#/", "Inicio"], ["#/catalogo", "Catálogo"]];
    navEl.innerHTML = links.map(([h, l]) => `<a href="${h}" class="${isActiveUrl(h) && !state.megaOpen ? "active" : ""}">${l}</a>`).join("") +
      `<button aria-expanded="${state.megaOpen}" aria-controls="mega" class="${state.megaOpen ? "active" : ""}" data-action="toggle-mega">Categorías ${I.chev}</button>` +
      `<a href="#/nosotros" class="${route === "about" ? "active" : ""}">Nosotros</a><a href="#/contacto" class="${route === "contact" ? "active" : ""}">Contacto</a>`;
  }

  const parent = tree.find((t) => t.id === open);
  const megaEl = document.getElementById("megaInner");
  if (parent) {
    megaEl.innerHTML = parent.children.map((c) => {
      const cat = c.category_id ? state.categories.find((x) => x.id === c.category_id) : null;
      const href = cat ? `#/catalogo/${esc(cat.slug)}` : esc(c.url);
      return `<a class="cat" href="${href}"><b>${esc(c.label)}</b><span>${esc(cat?.description ?? "")}</span></a>`;
    }).join("") + `<a class="cat all" href="#/catalogo"><span>Ver todo el catálogo</span><span style="color:var(--red2)">→</span></a>`;
  } else {
    const top = state.categories.filter((c) => !c.parent_id);
    megaEl.innerHTML = top.map((c) =>
      `<a class="cat" href="#/catalogo/${esc(c.slug)}"><b>${esc(c.name)}</b><span>${esc(c.description ?? "")}</span></a>`).join("") +
      `<a class="cat all" href="#/catalogo"><span>Ver todo el catálogo</span><span style="color:var(--red2)">→</span></a>`;
  }
  const promo = state.settings.menu_promo ?? {};
  if (promo.active && (parent || !tree.length)) {
    megaEl.innerHTML += `<a class="promo" href="${esc(promo.button_url || "#/catalogo")}"${promo.image_path ? ` style="background-image:url('${esc(publicUrl("product-public", promo.image_path))}');background-size:cover;background-position:center"` : ""}>
      <span class="mono">${esc(promo.eyebrow ?? "")}</span><span><b class="display" style="display:block;font-size:30px">${esc(promo.title ?? "")}</b>
      <span style="display:block;margin-top:8px;color:#fff">${esc(promo.description ?? "")}</span>
      <span class="btn" style="background:#fff;color:#0c0c0c;height:44px;margin-top:14px">${esc(promo.button_label || "Ver")} ${I.arrow}</span></span></a>`;
  }
  document.getElementById("mega").hidden = !(state.megaOpen && (parent || !tree.length));

  const acc = document.getElementById("accountBtn");
  acc.textContent = state.session ? "Mi cuenta" : "Entrar";
  acc.dataset.action = state.session ? "" : "open-auth";
  acc.href = state.session ? "#/cuenta/perfil" : "#";
  const count = cartLines().length;
  const badge = document.getElementById("badge");
  badge.hidden = !count;
  badge.textContent = count;
}

function layerOpen(html) {
  layer.innerHTML = html;
  document.body.style.overflow = "hidden";
}
function closeLayer() {
  layer.innerHTML = "";
  document.body.style.overflow = "";
}

function openCart() {
  if (!requireLogin()) return;
  const lines = cartLines();
  const total = lines.reduce((s, x) => s + x.lic.price, 0);
  layerOpen(`<div class="overlay" data-action="close-layer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Carrito">
      <header><h2 class="display" style="margin:0;font-size:34px">Carrito</h2><button class="icon-btn" aria-label="Cerrar" data-action="close-layer">${I.close}</button></header>
      <div class="items">${lines.length ? lines.map((x) => `<div class="ci">
          ${x.p.coverUrl ? `<img src="${esc(x.p.coverUrl)}" alt="" width="64" height="64">` : '<div class="cover-empty" style="width:64px;height:64px"></div>'}
          <div><b>${esc(x.p.title)}</b><p class="mono" style="color:var(--mute);margin:4px 0 0">${esc(x.lic.name)}</p></div>
          <div style="text-align:right"><b>${money(x.lic.price, currency())}</b><br><button style="background:none;border:0;color:var(--red2);font-weight:700;padding:6px 0" data-action="remove-cart" data-id="${x.p.id}">Quitar</button></div></div>`).join("")
        : '<p class="note" style="padding:20px 0">Tu carrito está vacío.</p>'}</div>
      <footer><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="mono" style="color:var(--mute)">Subtotal</span><b class="display" style="font-size:32px">${money(total, currency())}</b></div>
        <a class="btn btn-red" style="justify-content:center" href="#/checkout" data-action="close-layer">Ir al checkout</a></footer>
    </aside>`);
}

function openMenu() {
  const top = state.categories.filter((c) => !c.parent_id);
  layerOpen(`<nav class="mnav" aria-label="Menú">
    <button class="icon-btn" style="align-self:flex-end" aria-label="Cerrar menú" data-action="close-layer">${I.close}</button>
    <a href="#/" data-action="close-layer">Inicio</a>
    <a href="#/catalogo" data-action="close-layer">Catálogo</a>
    ${top.map((c) => `<a href="#/catalogo/${esc(c.slug)}" data-action="close-layer" style="font-size:22px">${esc(c.name)}</a>`).join("")}
    <a href="#/nosotros" data-action="close-layer" style="font-size:22px">Nosotros</a>
    <a href="#/contacto" data-action="close-layer" style="font-size:22px">Contacto</a>
  </nav>`);
}

function openAuth(mode = "login") {
  const f = 'width:100%;height:50px;border-radius:14px;border:0;background:var(--paper);color:var(--ink);padding:0 14px;font:inherit;margin-top:8px';
  const tab = (k, l) => `<button class="mono" data-action="auth-tab" data-mode="${k}" style="background:none;border:0;padding:8px 0;color:${mode === k ? "var(--ink)" : "var(--mute)"};border-bottom:2px solid ${mode === k ? "var(--red)" : "transparent"}">${l}</button>`;
  let form = "";
  if (mode === "login") form = `<form data-form="login" style="display:grid;gap:14px">
      <label class="mono" style="color:var(--mute)">Correo<input name="email" type="email" required autocomplete="email" style="${f}"></label>
      <label class="mono" style="color:var(--mute)">Contraseña<input name="password" type="password" required autocomplete="current-password" style="${f}"></label>
      <button class="btn btn-red" type="submit" style="justify-content:center">Entrar</button>
      <button type="button" class="mono" data-action="auth-tab" data-mode="forgot" style="background:none;border:0;color:var(--mute);text-align:left">¿Olvidaste tu contraseña?</button></form>`;
  if (mode === "register") form = `<form data-form="register" style="display:grid;gap:14px">
      <label class="mono" style="color:var(--mute)">Nombre<input name="display_name" maxlength="80" required style="${f}"></label>
      <label class="mono" style="color:var(--mute)">Correo<input name="email" type="email" required autocomplete="email" style="${f}"></label>
      <label class="mono" style="color:var(--mute)">Contraseña (mínimo 8)<input name="password" type="password" minlength="8" required autocomplete="new-password" style="${f}"></label>
      <button class="btn btn-red" type="submit" style="justify-content:center">Crear cuenta</button>
      <p class="note">Te enviaremos un correo para confirmar tu cuenta.</p></form>`;
  if (mode === "forgot") form = `<form data-form="forgot" style="display:grid;gap:14px">
      <label class="mono" style="color:var(--mute)">Correo de tu cuenta<input name="email" type="email" required autocomplete="email" style="${f}"></label>
      <button class="btn btn-red" type="submit" style="justify-content:center">Enviar enlace</button></form>`;
  layerOpen(`<div class="overlay" data-action="close-layer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Acceso" style="height:auto;top:auto;bottom:12px">
      <header><div style="display:flex;gap:18px">${tab("login", "Entrar")}${tab("register", "Crear cuenta")}</div>
        <button class="icon-btn" aria-label="Cerrar" data-action="close-layer">${I.close}</button></header>
      <div style="padding:22px;display:grid;gap:14px"><p class="msg mono" data-msg hidden style="color:var(--red);margin:0"></p>${form}</div>
    </aside>`);
}

function showMsg(form, text, isError = true) {
  const el = form.querySelector("[data-msg]");
  if (!el) return toast(text);
  el.hidden = false;
  el.style.color = isError ? "var(--red)" : "var(--soft)";
  el.textContent = text;
}

// ---------------------------------------------------------------------------
// Acciones (delegación de eventos)
// ---------------------------------------------------------------------------
const actions = {
  "close-layer": () => closeLayer(),
  "open-cart": () => openCart(),
  "open-menu": () => openMenu(),
  "open-auth": () => openAuth("login"),
  "auth-tab": (el) => openAuth(el.dataset.mode),
  "toggle-mega": (el) => {
    const id = el.dataset.nav ?? "legacy";
    state.megaOpen = !(state.megaOpen && state.megaNav === id);
    state.megaNav = id;
    renderNav(currentRoute());
  },
  logout: async () => { await sb.auth.signOut(); toast("Sesión cerrada"); location.hash = "#/"; },
  "add-to-cart": async (el) => {
    if (!requireLogin()) return;
    const p = state.products.find((x) => x.id === el.dataset.id);
    const checked = document.querySelector('input[name="lic"]:checked');
    if (!p || !checked) return;
    const { error } = await sb.from("cart_items").upsert(
      { user_id: state.uid, product_id: p.id, license_type_id: checked.value }, { onConflict: "user_id,product_id" });
    if (error) return toast(errMsg(error));
    await loadUserData();
    renderNav(currentRoute());
    toast(`Añadido: ${p.title}`);
    openCart();
  },
  "remove-cart": async (el) => {
    const { error } = await sb.from("cart_items").delete().eq("user_id", state.uid).eq("product_id", el.dataset.id);
    if (error) return toast(errMsg(error));
    await loadUserData();
    toast("Quitado del carrito");
    render();
  },
  fav: async (el) => {
    if (!requireLogin()) return;
    const id = el.dataset.id;
    if (state.favorites.has(id)) {
      await sb.from("favorites").delete().eq("user_id", state.uid).eq("product_id", id);
      state.favorites.delete(id);
      toast("Quitado de favoritos");
    } else {
      const { error } = await sb.from("favorites").insert({ user_id: state.uid, product_id: id });
      if (error) return toast(errMsg(error));
      state.favorites.add(id);
      toast("Guardado en favoritos");
    }
    render();
  },
  preview: async (el) => {
    const p = state.products.find((x) => x.id === el.dataset.id);
    if (!p?.previewUrl) return;
    if (!state.audio) {
      state.audio = new Audio();
      state.audio.addEventListener("ended", () => { state.playingId = null; paintPlayButtons(); });
      state.audio.addEventListener("pause", paintPlayButtons);
      state.audio.addEventListener("play", paintPlayButtons);
      state.audio.addEventListener("timeupdate", () => {
        const bar = document.getElementById("plProgress");
        if (bar && state.audio.duration) bar.style.width = (state.audio.currentTime / state.audio.duration * 100) + "%";
      });
    }
    if (state.playingId === p.id) {
      state.audio.pause();
      state.playingId = null;
      return paintPlayButtons();
    }
    state.audio.src = p.previewUrl;
    try { await state.audio.play(); } catch { return toast("No se pudo reproducir la muestra"); }
    state.playingId = p.id;
    paintPlayButtons();
    sb.rpc("record_play", { p_product: p.id }); // contador de reproducciones; no bloquea
  },
  "create-order": async () => {
    if (!requireLogin()) return;
    const coupon = document.getElementById("coupon")?.value.trim() || null;
    const { data, error } = await sb.rpc("create_order_from_cart", { p_coupon: coupon });
    if (error) return toast(errMsg(error));
    await loadUserData();
    location.hash = `#/pedido/${data}`;
  },
  "pay-paypal": async (el) => {
    try {
      const r = await callFn("paypal-create-order", { order_id: el.dataset.id });
      location.href = r.approve_url;
    } catch (e) { toast(e.message); }
  },
  download: async (el) => {
    try {
      const r = await callFn("download-url", { file_id: el.dataset.file });
      location.href = r.url;
    } catch (e) { toast(e.message); }
  },
  go: (el) => { location.hash = el.dataset.href; },
};

function paintPlayButtons() {
  document.querySelectorAll('[data-action="preview"]').forEach((b) => {
    const playing = b.dataset.id === state.playingId;
    b.innerHTML = playing ? I.pause : I.play;
    b.setAttribute("aria-pressed", playing ? "true" : "false");
  });
  syncPlayer();
}

// Barra inferior del reproductor: visible mientras hay una muestra cargada.
function syncPlayer() {
  const bar = document.getElementById("player");
  if (!bar) return;
  const p = state.products.find((x) => x.id === state.playingId);
  const active = !!(p && state.audio && state.audio.src);
  bar.classList.toggle("on", active);
  document.body.classList.toggle("has-player", active);
  if (!active) return;
  const playing = !state.audio.paused && !state.audio.ended;
  document.getElementById("plTitle").textContent = p.title;
  const cover = document.getElementById("plCover");
  cover.hidden = !p.coverUrl;
  if (p.coverUrl) cover.src = p.coverUrl;
  const btn = document.getElementById("plToggle");
  btn.innerHTML = playing ? I.pause : I.play;
  btn.setAttribute("aria-label", playing ? "Pausar muestra" : "Reproducir muestra");
}

function initPlayer() {
  document.getElementById("plToggle")?.addEventListener("click", () => {
    if (!state.audio || !state.playingId) return;
    if (state.audio.paused) { state.audio.play().catch(() => toast("No se pudo reproducir")); }
    else { state.audio.pause(); }
    paintPlayButtons();
  });
  document.getElementById("plClose")?.addEventListener("click", () => {
    if (state.audio) { state.audio.pause(); state.audio.removeAttribute("src"); }
    state.playingId = null;
    paintPlayButtons();
  });
}
initPlayer();

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) {
    // Los botones no navegan; los enlaces con href real (p. ej. "Ir al checkout") sí.
    if (el.tagName === "BUTTON" || el.getAttribute("href") === "#") e.preventDefault();
    return actions[el.dataset.action](el, e);
  }
  const card = e.target.closest("[data-href]");
  if (card && !e.target.closest("a")) location.hash = card.dataset.href;
  if (!e.target.closest("#hdr") && state.megaOpen) { state.megaOpen = false; renderNav(currentRoute()); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeLayer(); if (state.megaOpen) { state.megaOpen = false; renderNav(currentRoute()); } }
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "q") return;
  state.q = e.target.value;
  const pos = e.target.selectionStart;
  const { parts } = parseRoute();
  app.innerHTML = viewCatalog(parts[1] ?? "");
  const n = document.getElementById("q");
  n.focus();
  n.setSelectionRange(pos, pos);
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const kind = form.dataset.form;
  const btn = form.querySelector('[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    if (kind === "login") {
      const { error } = await sb.auth.signInWithPassword({ email: fd.get("email"), password: fd.get("password") });
      if (error) throw error;
      closeLayer();
      toast("Sesión iniciada");
    } else if (kind === "register") {
      const { error } = await sb.auth.signUp({
        email: fd.get("email"), password: fd.get("password"),
        options: { data: { display_name: fd.get("display_name") }, emailRedirectTo: location.href.split("#")[0] },
      });
      if (error) throw error;
      showMsg(form, "Revisa tu correo para confirmar la cuenta.", false);
    } else if (kind === "forgot") {
      const { error } = await sb.auth.resetPasswordForEmail(fd.get("email"), {
        redirectTo: location.href.split("#")[0] + "#/cuenta/seguridad",
      });
      if (error) throw error;
      showMsg(form, "Si el correo existe, recibirás un enlace para cambiar tu contraseña.", false);
    } else if (kind === "password") {
      if (fd.get("password") !== fd.get("confirm")) throw new Error("Las contraseñas no coinciden.");
      const { error } = await sb.auth.updateUser({ password: fd.get("password") });
      if (error) throw error;
      state.recovery = false;
      showMsg(form, "Contraseña actualizada.", false);
    } else if (kind === "profile") {
      const file = fd.get("avatar");
      let avatarPath = null;
      if (file && file.size > 0) {
        if (file.size > 5 * 1024 * 1024) throw new Error("La imagen supera 5 MB.");
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        avatarPath = `${state.uid}/avatar-${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await sb.storage.from("avatars").upload(avatarPath, file, { contentType: file.type, upsert: false });
        if (upErr) throw upErr;
      }
      const update = { display_name: String(fd.get("display_name") ?? "").trim(), preferences: { news: fd.get("news") === "on" } };
      if (avatarPath) update.avatar_path = avatarPath;
      const { error } = await sb.from("profiles").update(update).eq("id", state.uid);
      if (error) throw error;
      showMsg(form, "Perfil guardado.", false);
      render();
    } else if (kind === "contact") {
      const { error } = await sb.rpc("submit_contact", {
        p_name: fd.get("name"), p_email: fd.get("email"), p_reason: fd.get("reason"), p_message: fd.get("message"),
      });
      if (error) throw error;
      form.reset();
      showMsg(form, "Mensaje enviado. Te responderemos pronto.", false);
    } else if (kind === "yape") {
      const { error } = await sb.rpc("submit_yape_payment", { p_order: form.dataset.order, p_operation_code: fd.get("code") });
      if (error) throw error;
      toast("Código recibido. Tu pago está en revisión.");
      render();
    }
  } catch (err) {
    showMsg(form, errMsg(err));
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Render y arranque
// ---------------------------------------------------------------------------
async function render() {
  const id = ++state.renderId;
  if (!configured) { app.innerHTML = setupView(); return; }
  const { parts, query } = parseRoute();
  const [first, second] = parts;
  const route = currentRoute();
  let html;
  try {
    if (!first) html = viewHome();
    else if (first === "catalogo") html = viewCatalog(second ?? "", query);
    else if (first === "producto") html = viewProduct(second);
    else if (first === "checkout") html = viewCheckout();
    else if (first === "pedido") html = await viewOrder(second, query);
    else if (first === "cuenta") html = await viewAccount(second ?? "perfil");
    else if (first === "nosotros") html = viewAbout();
    else if (first === "contacto") html = viewContact();
    else if (first === "legal") html = viewLegal(second);
    else html = notFound();
  } catch (err) {
    html = `<div class="wrap ph"><h1 class="display">Error</h1><p class="note">${esc(errMsg(err))}</p></div>`;
  }
  if (id !== state.renderId) return; // llegó una navegación más reciente
  app.innerHTML = html;
  renderNav(route);
  paintPlayButtons();
  if (route !== "catalog" || !state.q) window.scrollTo(0, 0);
  document.title = (route === "home" ? "" : `${first === "catalogo" ? "Catálogo" : first} — `) + "U3M — Urbano Beat Maker";
}

// Identidad visual y pie de página administrados desde el panel (settings: theme, favicon_path, footer).
function applyBranding() {
  const t = state.settings.theme ?? {};
  const root = document.documentElement.style;
  const vars = { primary: "--red", secondary: "--red2", background: "--paper", surface: "--smoke", text: "--ink" };
  for (const [k, v] of Object.entries(vars)) if (/^#[0-9a-fA-F]{6}$/.test(t[k] ?? "")) root.setProperty(v, t[k]);
  const fav = publicUrl("product-public", state.settings.favicon_path);
  if (fav) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = fav;
  }
  renderFooter();
}

function renderFooter() {
  const f = state.settings.footer;
  const wrap = document.querySelector("footer.site .wrap");
  if (!f || !wrap) return; // sin ajustes, se conserva el pie original
  const links = (Array.isArray(f.links) ? f.links : []).map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join("");
  const social = (Array.isArray(f.social) ? f.social : []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("");
  wrap.innerHTML = `
    <div class="fbox">
      <div><h3 class="display">${esc(f.description ?? "")}</h3></div>
      <div><p class="mono" style="color:var(--mute)">Tienda</p><ul>${links}</ul></div>
      <div><p class="mono" style="color:var(--mute)">Redes</p><ul>${social || '<li style="color:var(--mute)">—</li>'}</ul>
        ${f.legal_text ? `<p class="note" style="margin-top:18px">${esc(f.legal_text)}</p>` : ""}</div>
    </div>
    <p class="display wordmark" aria-hidden="true">Urbano <span style="color:var(--red)">Beat</span> Maker</p>
    <div class="fbot mono"><span>${esc(f.copyright ?? "")}</span><span><a href="#/nosotros">Nosotros</a></span></div>`;
}

async function boot() {
  if (!configured) { render(); return; }
  state.settings = await getSettings();
  const logo = publicUrl("product-public", state.settings.logo_path);
  if (logo) document.querySelector(".logo img").src = logo;
  applyBranding();
  await loadCatalog();
  state.cms = await loadCms();
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  state.uid = session?.user?.id ?? null;
  await loadUserData();
  render();

  sb.auth.onAuthStateChange(async (event, s) => {
    if (event === "PASSWORD_RECOVERY") { state.recovery = true; location.hash = "#/cuenta/seguridad"; }
    if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") {
      state.session = s;
      state.uid = s?.user?.id ?? null;
      await loadUserData();
      render();
    }
  });
  window.addEventListener("hashchange", render);
}

boot().catch((e) => { app.innerHTML = `<div class="wrap ph"><h1 class="display">Sin conexión</h1><p class="note">${esc(errMsg(e))}</p></div>`; });
