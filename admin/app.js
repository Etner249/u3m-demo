// Panel administrativo U3M. La seguridad real está en RLS y en las funciones SQL / Edge Functions;
// este código solo muestra y envía lo que la base permite.
import { sb, configured, errMsg, esc, money, publicUrl, TYPE_LABEL, STATUS_LABEL } from "../assets/js/supabase.js";
import { Chart } from "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm";

const root = document.getElementById("root");
const PAGE = 20;
const TYPES = ["beat", "drum_kit", "sample_pack", "plugin"];

// Archivos por tipo de producto (kind → etiqueta, bucket, múltiple, accept)
const FILE_SLOTS = {
  cover:            { label: "Portada", multi: false, accept: "image/jpeg,image/png,image/webp", common: true },
  promo_image:      { label: "Imágenes promocionales", multi: true, accept: "image/jpeg,image/png,image/webp" },
  preview_audio:    { label: "Previsualización MP3", multi: false, accept: "audio/mpeg" },
  demo_audio:       { label: "Audios de demostración", multi: true, accept: "audio/mpeg,audio/wav,audio/x-wav" },
  original_mp3:     { label: "Archivo MP3 original", multi: false, accept: "audio/mpeg" },
  wav:              { label: "Archivo WAV", multi: false, accept: "audio/wav,audio/x-wav" },
  stems:            { label: "Stems / trackouts (ZIP o RAR)", multi: true, accept: ".zip,.rar" },
  kit_archive:      { label: "Archivo descargable (ZIP o RAR)", multi: false, accept: ".zip,.rar" },
  plugin_installer: { label: "Instalador del plugin", multi: false, accept: ".exe,.dmg,.pkg,.zip" },
  user_manual:      { label: "Manual de usuario (PDF)", multi: false, accept: "application/pdf" },
  license_document: { label: "Documento de licencia (PDF)", multi: false, accept: "application/pdf" },
};
const SLOTS_BY_TYPE = {
  beat: ["cover", "preview_audio", "original_mp3", "wav", "stems", "license_document"],
  drum_kit: ["cover", "demo_audio", "kit_archive", "license_document"],
  sample_pack: ["cover", "demo_audio", "kit_archive", "license_document"],
  plugin: ["cover", "promo_image", "demo_audio", "plugin_installer", "user_manual", "license_document"],
};

const state = { session: null, isAdmin: false, route: "", toastTimer: null };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
async function fnErr(error) {
  let msg = error.message;
  try { msg = (await error.context.json()).error ?? msg; } catch { /* sin JSON */ }
  return new Error(msg);
}

async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) throw await fnErr(error);
  return data;
}

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.remove(), 3000);
}

function fail(e) { toast(errMsg(e)); }

function modal(html) {
  closeModal();
  const m = document.createElement("div");
  m.className = "modal"; m.id = "modal";
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true">${html}</div>`;
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(); });
  document.body.appendChild(m);
  return m.querySelector(".box");
}
function closeModal() { document.getElementById("modal")?.remove(); }

function confirmBox(text, okLabel = "Confirmar") {
  return new Promise((resolve) => {
    const box = modal(`<h2>Confirmación</h2><p style="line-height:1.5">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end;margin-top:18px">
        <button class="btn ghost" data-r="0">Cancelar</button><button class="btn red" data-r="1">${esc(okLabel)}</button></div>`);
    box.addEventListener("click", (e) => {
      const r = e.target.closest("[data-r]");
      if (!r) return;
      closeModal();
      resolve(r.dataset.r === "1");
    });
  });
}

const fmtDate = (d) => d ? new Date(d).toLocaleString("es-PE") : "—";
const badge = (s) => `<span class="st-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/&/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (cents) => (Number(cents ?? 0) / 100).toFixed(2);
const toCents = (v) => Math.round(Number(String(v).replace(",", ".")) * 100);

function pager(page, total, key) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return `<div class="pager"><span class="mono">Página ${page + 1} de ${pages} · ${total} registros</span>
    <button class="btn sm" ${page <= 0 ? "disabled" : ""} data-act="page" data-key="${key}" data-page="${page - 1}">Anterior</button>
    <button class="btn sm" ${page + 1 >= pages ? "disabled" : ""} data-act="page" data-key="${key}" data-page="${page + 1}">Siguiente</button></div>`;
}
const pages = {}; // paginación por vista
const filters = {}; // filtros por vista

// ---------------------------------------------------------------------------
// Sesión y acceso
// ---------------------------------------------------------------------------
async function checkAdmin() {
  const { data, error } = await sb.rpc("has_role", { p_code: "admin" });
  return !error && data === true;
}

function loginView(message = "") {
  root.innerHTML = `<div class="login"><form class="card" data-submit="login">
    <h1 style="font-size:26px">Panel U3M</h1>
    <p class="mono">Acceso administrativo</p>
    ${message ? `<p style="color:#ff9b9b;margin:0">${esc(message)}</p>` : ""}
    <label>Correo<input name="email" type="email" required autocomplete="username"></label>
    <label>Contraseña<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn red" type="submit" style="justify-content:center">Entrar</button>
    <p class="mono" style="margin:0">Solo cuentas con rol administrador.</p></form></div>`;
}

// ---------------------------------------------------------------------------
// Estructura
// ---------------------------------------------------------------------------
function shell(content) {
  const link = (h, label) => `<a href="#/${h}" class="${state.route === h.split("/")[0] ? "on" : ""}">${label}</a>`;
  root.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand"><img src="../logo.png" alt=""><span class="mono">Panel</span></div>
      <nav>
        ${link("dashboard", "Dashboard")}
        <div class="mono group">Biblioteca</div>
        ${link("productos/beat", "Beats")}
        ${link("productos/drum_kit", "Drum Kits")}
        ${link("productos/sample_pack", "Sample Packs")}
        ${link("productos/plugin", "Plugins")}
        ${link("taxonomia", "Categorías y etiquetas")}
        <div class="mono group">Ventas</div>
        ${link("pedidos", "Pedidos")}
        ${link("pagos", "Pagos")}
        ${link("licencias", "Licencias")}
        ${link("cupones", "Cupones y promociones")}
        <div class="mono group">Administración</div>
        ${link("usuarios", "Usuarios")}
        ${link("archivos", "Archivos")}
        ${link("mensajes", "Mensajes")}
        ${link("configuracion", "Configuración")}
        ${link("auditoria", "Auditoría")}
        <a data-act="logout" style="margin-top:16px">Cerrar sesión</a>
      </nav>
    </aside>
    <main class="content">${content}</main></div>`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
let chart = null;
async function viewDashboard() {
  const f = filters.dash ?? { from: isoDay(-30), to: isoDay(1) };
  filters.dash = f;
  const { data, error } = await sb.rpc("admin_dashboard_stats", {
    p_from: new Date(f.from).toISOString(), p_to: new Date(f.to).toISOString(),
  });
  if (error) throw error;
  const maxSold = Math.max(1, ...(data.top_sold ?? []).map((x) => x.units));
  const maxPlay = Math.max(1, ...(data.top_played ?? []).map((x) => x.plays));
  shell(`<div class="spread"><h1>Dashboard</h1>
    <div class="row"><label>Desde<input type="date" value="${f.from}" data-change="dash" data-field="from"></label>
    <label>Hasta<input type="date" value="${f.to}" data-change="dash" data-field="to"></label></div></div>
    <div class="kpis" style="margin-top:18px">
      <div class="card kpi"><span class="mono">Usuarios registrados</span><b>${data.users_total}</b></div>
      <div class="card kpi"><span class="mono">Productos publicados</span><b>${data.products_published}</b></div>
      <div class="card kpi"><span class="mono">Ventas (rango)</span><b>${data.sales_count}</b></div>
      <div class="card kpi"><span class="mono">Ingresos (rango)</span><b>${money(data.revenue_cents, "USD")}</b></div>
      <div class="card kpi"><span class="mono">Pagos pendientes de revisión</span><b>${data.pending_payments}</b></div>
      <div class="card kpi"><span class="mono">Descargas (rango)</span><b>${data.downloads_count}</b></div>
      <div class="card kpi"><span class="mono">Reproducciones (rango)</span><b>${data.plays_count}</b></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Ingresos por día</h2><canvas id="revChart" height="140" style="margin-top:12px"></canvas>
        ${(data.daily_revenue ?? []).length ? "" : '<p class="mono">Sin ventas en este rango.</p>'}</div>
      <div class="card"><h2>Actividad reciente</h2><div style="display:grid;gap:8px;margin-top:12px">
        ${(data.recent_activity ?? []).map((a) => `<div class="file-row"><span>${esc(a.action)} · ${esc(a.entity)}</span><span class="mono">${fmtDate(a.created_at)}</span></div>`).join("") || '<p class="mono">Sin actividad.</p>'}
      </div></div>
      <div class="card"><h2>Productos más vendidos</h2>
        ${(data.top_sold ?? []).map((x) => `<div style="margin-top:12px"><div class="spread"><span>${esc(x.title)}</span><b>${x.units}</b></div>
          <div class="bars"><span style="width:${(x.units / maxSold) * 100}%"></span></div></div>`).join("") || '<p class="mono">Sin ventas.</p>'}</div>
      <div class="card"><h2>Productos más reproducidos</h2>
        ${(data.top_played ?? []).map((x) => `<div style="margin-top:12px"><div class="spread"><span>${esc(x.title)}</span><b>${x.plays}</b></div>
          <div class="bars"><span style="width:${(x.plays / maxPlay) * 100}%"></span></div></div>`).join("") || '<p class="mono">Sin reproducciones.</p>'}</div>
    </div>`);
  if (chart) chart.destroy();
  const canvas = document.getElementById("revChart");
  if (canvas && (data.daily_revenue ?? []).length) {
    chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: data.daily_revenue.map((d) => new Date(d.day).toLocaleDateString("es-PE")),
        datasets: [{ label: "US$", data: data.daily_revenue.map((d) => d.cents / 100), backgroundColor: "#e10600" }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { color: "#a3a3a3" } }, x: { ticks: { color: "#a3a3a3" } } } },
    });
  }
}

function isoDay(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Productos (Beats, Drum Kits, Sample Packs, Plugins)
// ---------------------------------------------------------------------------
async function viewProductList(type) {
  const f = filters[`p-${type}`] ?? { q: "", status: "", page: 0 };
  filters[`p-${type}`] = f;
  let q = sb.from("products").select("id, title, slug, status, is_featured, price_cents, updated_at", { count: "exact" })
    .eq("type", type).order("updated_at", { ascending: false })
    .range(f.page * PAGE, f.page * PAGE + PAGE - 1);
  if (f.q) q = q.ilike("title", `%${f.q}%`);
  if (f.status) q = q.eq("status", f.status);
  const { data, error, count } = await q;
  if (error) throw error;
  shell(`<div class="spread"><h1>${esc(TYPE_LABEL[type])}s</h1>
      <a class="btn red" href="#/productos/${type}/nuevo">Nuevo ${esc(TYPE_LABEL[type]).toLowerCase()}</a></div>
    <div class="toolbar" style="margin-top:18px">
      <input placeholder="Buscar por título" value="${esc(f.q)}" data-change="pq" data-type="${type}" data-field="q">
      <select data-change="pq" data-type="${type}" data-field="status">
        <option value="">Todos los estados</option>
        ${["draft", "published", "archived"].map((s) => `<option value="${s}" ${f.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}
      </select></div>
    <div class="card" style="padding:0;overflow:auto"><table>
      <thead><tr><th>Título</th><th>Estado</th><th>Destacado</th><th>Precio base</th><th>Actualizado</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((p) => `<tr>
        <td><a href="#/productos/${type}/${p.id}"><b>${esc(p.title)}</b></a></td>
        <td>${badge(p.status)}</td><td>${p.is_featured ? "Sí" : "—"}</td>
        <td>${p.price_cents ? money(p.price_cents, "USD") : "—"}</td><td class="mono">${fmtDate(p.updated_at)}</td>
        <td class="row" style="justify-content:flex-end">
          ${p.status === "published"
            ? `<a class="btn sm" href="../#/producto/${esc(p.slug)}" target="_blank" rel="noopener">Ver en tienda</a>
               <button class="btn sm" data-act="set-status" data-id="${p.id}" data-status="draft">Despublicar</button>`
            : `<button class="btn sm ok" data-act="set-status" data-id="${p.id}" data-status="published">Publicar</button>`}
          ${p.status !== "archived" ? `<button class="btn sm ghost" data-act="set-status" data-id="${p.id}" data-status="archived">Archivar</button>` : ""}
          <button class="btn sm red" data-act="delete-product" data-id="${p.id}" data-title="${esc(p.title)}">Eliminar</button>
        </td></tr>`).join("") || `<tr><td colspan="6" class="mono">Sin productos.</td></tr>`}</tbody></table></div>
    ${pager(f.page, count ?? 0, `p-${type}`)}`);
}

async function viewProductForm(type, id) {
  const isNew = id === "nuevo";
  let p = null;
  let licenses = [];
  let tags = [];
  let files = [];
  if (!isNew) {
    const { data, error } = await sb.from("products").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data || data.type !== type) return shell(`<h1>Producto no encontrado</h1>`);
    p = data;
    const [pl, pt, pf] = await Promise.all([
      sb.from("product_licenses").select("license_type_id, price_cents, is_available, max_sales").eq("product_id", id),
      sb.from("product_tags").select("tags(name)").eq("product_id", id),
      sb.from("product_files").select("id, kind, bucket, storage_path, size_bytes, mime_type, created_at").eq("product_id", id).order("created_at"),
    ]);
    licenses = pl.data ?? [];
    tags = (pt.data ?? []).map((t) => t.tags?.name).filter(Boolean);
    files = pf.data ?? [];
  }
  const [{ data: genres }, { data: cats }, { data: lts }] = await Promise.all([
    sb.from("genres").select("id, name").order("name"),
    sb.from("categories").select("id, name, parent_id").order("sort_order"),
    sb.from("license_types").select("id, code, name, formats, is_exclusive, is_active").order("code"),
  ]);
  const attrs = p?.attributes ?? {};
  const licFor = (ltId) => licenses.find((l) => l.license_type_id === ltId);
  const slots = SLOTS_BY_TYPE[type];

  shell(`<div class="spread"><div><p class="mono"><a href="#/productos/${type}">${esc(TYPE_LABEL[type])}s</a> / ${isNew ? "Nuevo" : esc(p.title)}</p>
      <h1>${isNew ? "Nuevo " + esc(TYPE_LABEL[type]).toLowerCase() : esc(p.title)}</h1></div>
      ${p ? badge(p.status) : ""}</div>

    <form class="card" data-submit="product" data-type="${type}" data-id="${isNew ? "" : id}" style="margin-top:18px;display:grid;gap:14px">
      <h2>Datos del producto</h2>
      <div class="grid2">
        <label>Título *<input name="title" required maxlength="160" value="${esc(p?.title ?? "")}"><span class="field-err" data-err="title"></span></label>
        <label>Productor o artista<input name="producer" maxlength="120" value="${esc(p?.producer ?? "")}"></label>
        <label>Género<select name="genre_id"><option value="">Sin género</option>
          ${(genres ?? []).map((g) => `<option value="${g.id}" ${p?.genre_id === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
        <label>Categoría<select name="category_id"><option value="">Sin categoría</option>
          ${(cats ?? []).map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? "selected" : ""}>${c.parent_id ? "— " : ""}${esc(c.name)}</option>`).join("")}</select></label>
        <label>BPM<input name="bpm" type="number" min="40" max="300" value="${p?.bpm ?? ""}"><span class="field-err" data-err="bpm"></span></label>
        <label>Tonalidad<input name="musical_key" maxlength="30" placeholder="D Minor" value="${esc(p?.musical_key ?? "")}"></label>
      </div>
      <label>Descripción<textarea name="description" rows="4" maxlength="4000">${esc(p?.description ?? "")}</textarea></label>
      <label>Etiquetas (separadas por coma)<input name="tags" value="${esc(tags.join(", "))}"></label>
      <div class="grid2">
        <label>Estado<select name="status">
          ${["draft", "published", "archived"].map((s) => `<option value="${s}" ${(p?.status ?? "draft") === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select></label>
        <label class="chk"><input type="checkbox" name="is_featured" ${p?.is_featured ? "checked" : ""}> Producto destacado en la portada</label>
      </div>
      ${p?.published_at ? `<p class="mono">Publicado: ${fmtDate(p.published_at)}</p>` : ""}

      <h2 style="margin-top:6px">Datos específicos</h2>
      <div class="grid2">${specFields(type, attrs)}</div>

      <h2 style="margin-top:6px">Licencias y precios</h2>
      <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Activa</th><th>Licencia</th><th>Formatos</th><th>Precio (US$)</th><th>Ventas máx. (vacío = sin límite)</th></tr></thead>
        <tbody>${(lts ?? []).filter((l) => l.is_active).map((l) => {
          const cur = licFor(l.id);
          return `<tr><td><input type="checkbox" name="lic_on_${l.id}" ${cur?.is_available ? "checked" : ""}></td>
            <td>${esc(l.name)}${l.is_exclusive ? ' <span class="tag">exclusiva</span>' : ""}</td>
            <td class="mono">${esc((l.formats ?? []).join(" · "))}</td>
            <td><input name="lic_price_${l.id}" inputmode="decimal" value="${cur ? usd(cur.price_cents) : ""}" style="width:120px"></td>
            <td><input name="lic_max_${l.id}" type="number" min="1" value="${cur?.max_sales ?? ""}" style="width:120px"></td></tr>`;
        }).join("")}</tbody></table></div>
      <p class="field-err" data-err="licenses"></p>

      <div class="row" style="justify-content:flex-end">
        <button class="btn red" type="submit">${isNew ? "Crear producto" : "Guardar cambios"}</button></div>
      <p class="field-err" data-err="form"></p>
    </form>

    <div class="card" style="margin-top:18px">
      <h2>Archivos</h2>
      ${isNew ? `<p class="note">Guarda el producto primero para poder subir archivos.</p>` : slots.map((k) => fileSection(id, k, files)).join("")}
    </div>

    ${p ? `<div class="card" style="margin-top:18px"><h2>Previsualización</h2>
      <div class="grid2" style="margin-top:12px">
        <div>${p.id && files.find((f) => f.kind === "cover") ? `<img src="${esc(publicUrl("product-public", files.find((f) => f.kind === "cover").storage_path))}" alt="" style="width:100%;max-width:320px;border-radius:16px">` : '<p class="mono">Sin portada</p>'}</div>
        <div>${files.find((f) => f.kind === "preview_audio") ? `<audio controls preload="none" src="${esc(publicUrl("product-public", files.find((f) => f.kind === "preview_audio").storage_path))}"></audio>` : '<p class="mono">Sin previsualización de audio</p>'}</div>
      </div></div>` : ""}`);
}

function specFields(type, a) {
  const v = (k) => esc(a[k] ?? "");
  if (type === "drum_kit") return `<label>Cantidad de sonidos<input name="sound_count" type="number" min="0" value="${v("sound_count")}"></label>
    <label>Formatos incluidos<input name="formats" placeholder="WAV 24-bit, MIDI" value="${v("formats")}"></label>`;
  if (type === "sample_pack") return `<label>Cantidad de samples<input name="sample_count" type="number" min="0" value="${v("sample_count")}"></label>
    <label>Formatos incluidos<input name="formats" placeholder="WAV 24-bit" value="${v("formats")}"></label>`;
  if (type === "plugin") return `<label>Desarrollador<input name="developer" maxlength="120" value="${v("developer")}"></label>
    <label>Versión<input name="version" maxlength="30" placeholder="1.0.0" value="${v("version")}"></label>
    <label>Formatos<input name="plugin_formats" placeholder="VST3, AU" value="${v("plugin_formats")}"></label>
    <div class="row"><label class="chk"><input type="checkbox" name="os_win" ${a.os_win ? "checked" : ""}> Windows</label>
      <label class="chk"><input type="checkbox" name="os_mac" ${a.os_mac ? "checked" : ""}> macOS</label></div>
    <label style="grid-column:1/-1">Requisitos del sistema<textarea name="requirements" rows="3">${v("requirements")}</textarea></label>`;
  return `<p class="mono" style="grid-column:1/-1">Los beats usan los campos generales (BPM, tonalidad, género y etiquetas).</p>`;
}

function fileSection(productId, kind, files) {
  const slot = FILE_SLOTS[kind];
  const mine = files.filter((f) => f.kind === kind);
  const canAdd = slot.multi || mine.length === 0;
  return `<div style="margin-top:16px"><div class="spread"><b>${esc(slot.label)}</b><span class="mono">${slot.multi ? "varios" : "uno"}</span></div>
    <div class="files-list">${mine.map((f) => `<div class="file-row"><span>${esc(f.storage_path.split("/").pop().replace(/^[0-9a-f-]{36}-/, ""))} · ${(f.size_bytes / 1048576).toFixed(1)} MB · <span class="mono">${f.bucket === "product-private" ? "privado" : "público"}</span></span>
      <button class="btn sm red" data-act="delete-file" data-id="${f.id}">Eliminar</button></div>`).join("")}</div>
    ${canAdd ? `<input type="file" accept="${slot.accept}" ${slot.multi ? "multiple" : ""} data-upload="${kind}" data-product="${productId}" style="margin-top:10px">
      <div class="progress" data-progress="${kind}" hidden><span></span></div>` : `<p class="mono" style="margin-top:8px">Sustituye el archivo actual para cambiarlo.</p>`}</div>`;
}

async function uploadFile(productId, kind, file, onProgress) {
  const s = await callFn("admin-sign-upload", {
    product_id: productId, kind, filename: file.name, size: file.size, mime: file.type,
  });
  await putWithProgress(s.signed_url, file, s.content_type, onProgress);
  const { error } = await sb.from("product_files").insert({
    product_id: productId, kind, bucket: s.bucket, storage_path: s.path,
    mime_type: s.content_type, size_bytes: file.size,
  });
  if (error) throw error;
}

function putWithProgress(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("La subida falló (" + xhr.status + ")")));
    xhr.onerror = () => reject(new Error("Error de red durante la subida"));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------------------
// Taxonomía
// ---------------------------------------------------------------------------
async function viewTaxonomy() {
  const [{ data: cats }, { data: genres }, { data: tags }] = await Promise.all([
    sb.from("categories").select("id, name, slug, description, parent_id, sort_order").order("sort_order"),
    sb.from("genres").select("id, name, slug").order("name"),
    sb.from("tags").select("id, name, slug").order("name"),
  ]);
  shell(`<h1>Categorías, géneros y etiquetas</h1>
    <div class="grid2" style="margin-top:18px">
      <div class="card"><div class="spread"><h2>Categorías</h2><button class="btn sm" data-act="tax-new" data-table="categories">Nueva</button></div>
        <table style="margin-top:10px"><thead><tr><th>Nombre</th><th>Padre</th><th>Orden</th><th></th></tr></thead><tbody>
        ${(cats ?? []).map((c) => `<tr><td>${c.parent_id ? "— " : ""}${esc(c.name)}<br><span class="mono">${esc(c.slug)}</span></td>
          <td>${esc((cats ?? []).find((x) => x.id === c.parent_id)?.name ?? "—")}</td><td>${c.sort_order}</td>
          <td class="row" style="justify-content:flex-end"><button class="btn sm" data-act="tax-edit" data-table="categories" data-id="${c.id}">Editar</button>
          <button class="btn sm red" data-act="tax-del" data-table="categories" data-id="${c.id}" data-name="${esc(c.name)}">Eliminar</button></td></tr>`).join("")}
        </tbody></table></div>
      <div class="card"><div class="spread"><h2>Géneros</h2><button class="btn sm" data-act="tax-new" data-table="genres">Nuevo</button></div>
        <table style="margin-top:10px"><tbody>${(genres ?? []).map((g) => `<tr><td>${esc(g.name)}</td>
          <td class="row" style="justify-content:flex-end"><button class="btn sm" data-act="tax-edit" data-table="genres" data-id="${g.id}">Editar</button>
          <button class="btn sm red" data-act="tax-del" data-table="genres" data-id="${g.id}" data-name="${esc(g.name)}">Eliminar</button></td></tr>`).join("")}</tbody></table></div>
      <div class="card" style="grid-column:1/-1"><div class="spread"><h2>Etiquetas</h2><button class="btn sm" data-act="tax-new" data-table="tags">Nueva</button></div>
        <div style="margin-top:10px">${(tags ?? []).map((t) => `<span class="tag">${esc(t.name)} <a href="#" data-act="tax-del" data-table="tags" data-id="${t.id}" data-name="${esc(t.name)}" style="color:#ff9b9b;margin-left:6px">×</a></span>`).join("") || '<p class="mono">Sin etiquetas.</p>'}</div></div>
    </div>`);
  state.taxCats = cats ?? [];
}

function taxForm(table, row = {}) {
  const cats = state.taxCats ?? [];
  const parent = table === "categories" ? `<label>Categoría padre<select name="parent_id"><option value="">Ninguna (principal)</option>
      ${cats.filter((c) => c.id !== row.id).map((c) => `<option value="${c.id}" ${row.parent_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label>Descripción<textarea name="description" rows="2">${esc(row.description ?? "")}</textarea></label>
    <label>Orden<input name="sort_order" type="number" value="${row.sort_order ?? 0}"></label>` : "";
  const title = row.id ? "Editar" : "Nuevo";
  modal(`<h2>${title} ${table === "categories" ? "categoría" : table === "genres" ? "género" : "etiqueta"}</h2>
    <form data-submit="tax" data-table="${table}" data-id="${row.id ?? ""}" style="display:grid;gap:12px;margin-top:14px">
      <label>Nombre *<input name="name" required maxlength="80" value="${esc(row.name ?? "")}"></label>
      ${parent}
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-act="close">Cancelar</button><button class="btn red" type="submit">Guardar</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Usuarios, pedidos, pagos, licencias, archivos, cupones, mensajes, config, auditoría
// ---------------------------------------------------------------------------
async function viewUsers() {
  const { data, error } = await sb.rpc("admin_list_users");
  if (error) throw error;
  const q = (filters.users ?? "").toLowerCase();
  const list = (data ?? []).filter((u) => !q || `${u.email} ${u.display_name}`.toLowerCase().includes(q));
  shell(`<div class="spread"><h1>Usuarios</h1></div>
    <div class="toolbar" style="margin-top:18px"><input placeholder="Buscar por correo o nombre" value="${esc(filters.users ?? "")}" data-change="users" data-field="q"></div>
    <div class="card" style="padding:0;overflow:auto"><table>
      <thead><tr><th>Correo</th><th>Nombre</th><th>Roles</th><th>Registro</th><th>Último acceso</th><th></th></tr></thead>
      <tbody>${list.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.display_name || "—")}</td>
        <td>${(u.roles ?? []).map((r) => `<span class="tag">${esc(r)}</span>`).join("")}</td>
        <td class="mono">${fmtDate(u.created_at)}</td><td class="mono">${fmtDate(u.last_sign_in_at)}</td>
        <td style="text-align:right">${(u.roles ?? []).includes("admin")
          ? `<button class="btn sm" data-act="role" data-user="${u.id}" data-role="admin" data-on="0">Quitar admin</button>`
          : `<button class="btn sm" data-act="role" data-user="${u.id}" data-role="admin" data-on="1">Hacer admin</button>`}</td></tr>`).join("")
        || `<tr><td colspan="6" class="mono">Sin usuarios.</td></tr>`}</tbody></table></div>`);
}

async function viewOrders() {
  const f = filters.orders ?? { status: "", page: 0 };
  filters.orders = f;
  let q = sb.from("orders").select("id, status, total_cents, currency, created_at, paid_at, profiles(display_name)", { count: "exact" })
    .order("created_at", { ascending: false }).range(f.page * PAGE, f.page * PAGE + PAGE - 1);
  if (f.status) q = q.eq("status", f.status);
  const { data, error, count } = await q;
  if (error) throw error;
  shell(`<div class="spread"><h1>Pedidos y ventas</h1></div>
    <div class="toolbar" style="margin-top:18px"><select data-change="orders" data-field="status"><option value="">Todos</option>
      ${["pending", "paid", "failed", "refunded", "cancelled"].map((s) => `<option value="${s}" ${f.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select></div>
    <div class="card" style="padding:0;overflow:auto"><table>
      <thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Estado</th><th>Creado</th><th>Pagado</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((o) => `<tr><td class="mono">${esc(o.id.slice(0, 8))}</td><td>${esc(o.profiles?.display_name || "—")}</td>
        <td>${money(o.total_cents, o.currency)}</td><td>${badge(o.status)}</td><td class="mono">${fmtDate(o.created_at)}</td><td class="mono">${fmtDate(o.paid_at)}</td>
        <td style="text-align:right"><button class="btn sm" data-act="order-detail" data-id="${o.id}">Ver</button></td></tr>`).join("")
        || `<tr><td colspan="7" class="mono">Sin pedidos.</td></tr>`}</tbody></table></div>
    ${pager(f.page, count ?? 0, "orders")}`);
}

async function orderDetail(id) {
  const [{ data: o }, { data: items }, { data: pays }] = await Promise.all([
    sb.from("orders").select("id, status, subtotal_cents, discount_cents, total_cents, currency, created_at, paid_at").eq("id", id).maybeSingle(),
    sb.from("order_items").select("unit_price_cents, products(title), license_types(name)").eq("order_id", id),
    sb.from("payments").select("provider, provider_ref, amount_cents, status, created_at").eq("order_id", id),
  ]);
  modal(`<div class="spread"><h2>Pedido ${esc(id.slice(0, 8))}</h2>${o ? badge(o.status) : ""}</div>
    <table style="margin-top:12px"><tbody>${(items ?? []).map((i) => `<tr><td>${esc(i.products?.title)}</td><td>${esc(i.license_types?.name)}</td><td>${money(i.unit_price_cents, o?.currency)}</td></tr>`).join("")}</tbody></table>
    <p style="margin-top:12px">Total: <b>${o ? money(o.total_cents, o.currency) : "—"}</b> · Creado ${fmtDate(o?.created_at)}</p>
    <h3 style="margin-top:14px">Pagos</h3>
    <table><tbody>${(pays ?? []).map((p) => `<tr><td>${esc(p.provider)}</td><td class="mono">${esc(p.provider_ref)}</td><td>${money(p.amount_cents, o?.currency)}</td><td>${badge(p.status)}</td></tr>`).join("") || '<tr><td class="mono">Sin pagos.</td></tr>'}</tbody></table>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" data-act="close">Cerrar</button></div>`);
}

async function viewPayments() {
  const f = filters.pays ?? { provider: "", status: "", page: 0 };
  filters.pays = f;
  let q = sb.from("payments").select("id, provider, provider_ref, amount_cents, status, created_at, order_id, orders(currency)", { count: "exact" })
    .order("created_at", { ascending: false }).range(f.page * PAGE, f.page * PAGE + PAGE - 1);
  if (f.provider) q = q.eq("provider", f.provider);
  if (f.status) q = q.eq("status", f.status);
  const { data, error, count } = await q;
  if (error) throw error;
  shell(`<div class="spread"><h1>Pagos</h1></div>
    <div class="toolbar" style="margin-top:18px">
      <select data-change="pays" data-field="provider"><option value="">Todos los proveedores</option>
        <option value="paypal" ${f.provider === "paypal" ? "selected" : ""}>PayPal</option><option value="yape" ${f.provider === "yape" ? "selected" : ""}>Yape</option></select>
      <select data-change="pays" data-field="status"><option value="">Todos los estados</option>
        ${["pending", "approved", "manual_review", "rejected", "refunded"].map((s) => `<option value="${s}" ${f.status === s ? "selected" : ""}>${STATUS_LABEL[s] ?? s}</option>`).join("")}</select></div>
    <div class="card" style="padding:0;overflow:auto"><table>
      <thead><tr><th>Fecha</th><th>Proveedor</th><th>Referencia</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((p) => `<tr><td class="mono">${fmtDate(p.created_at)}</td><td>${esc(p.provider)}</td>
        <td class="mono">${esc(p.provider_ref)}</td><td>${money(p.amount_cents, p.orders?.currency ?? "USD")}</td><td>${badge(p.status)}</td>
        <td class="row" style="justify-content:flex-end">${p.provider === "yape" && p.status === "manual_review"
          ? `<button class="btn sm ok" data-act="yape-review" data-id="${p.id}" data-approve="1">Aprobar</button>
             <button class="btn sm red" data-act="yape-review" data-id="${p.id}" data-approve="0">Rechazar</button>` : ""}
          <button class="btn sm" data-act="order-detail" data-id="${p.order_id}">Pedido</button></td></tr>`).join("")
        || `<tr><td colspan="6" class="mono">Sin pagos.</td></tr>`}</tbody></table></div>
    ${pager(f.page, count ?? 0, "pays")}`);
}

async function viewLicenses() {
  const [{ data: lts }, { data: issued }] = await Promise.all([
    sb.from("license_types").select("*").order("code"),
    sb.from("issued_licenses").select("id, license_code, issued_at, revoked_at, products(title), license_types(name)")
      .order("issued_at", { ascending: false }).limit(100),
  ]);
  shell(`<h1>Licencias</h1>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Código</th><th>Nombre</th><th>Formatos</th><th>Exclusiva</th><th>Activa</th><th>Términos (JSON)</th><th></th></tr></thead>
      <tbody>${(lts ?? []).map((l) => `<tr><td class="mono">${esc(l.code)}</td>
        <td><input value="${esc(l.name)}" data-lt="name" data-id="${l.id}" style="width:180px"></td>
        <td><input value="${esc((l.formats ?? []).join(", "))}" data-lt="formats" data-id="${l.id}" style="width:160px"></td>
        <td><input type="checkbox" data-lt="is_exclusive" data-id="${l.id}" ${l.is_exclusive ? "checked" : ""}></td>
        <td><input type="checkbox" data-lt="is_active" data-id="${l.id}" ${l.is_active ? "checked" : ""}></td>
        <td><textarea rows="2" data-lt="terms" data-id="${l.id}" style="width:260px">${esc(JSON.stringify(l.terms ?? {}))}</textarea></td>
        <td><button class="btn sm ok" data-act="lt-save" data-id="${l.id}">Guardar</button></td></tr>`).join("")}</tbody></table></div>
    <div class="spread" style="margin-top:26px"><h2>Licencias emitidas (últimas 100)</h2>
      <input placeholder="Filtrar por código" data-change="lic-filter" style="max-width:260px"></div>
    <div class="card" style="margin-top:10px;padding:0;overflow:auto"><table>
      <thead><tr><th>Código</th><th>Producto</th><th>Licencia</th><th>Emitida</th><th>Estado</th><th></th></tr></thead>
      <tbody id="issued">${(issued ?? []).map((i) => `<tr data-code="${esc(i.license_code)}"><td class="mono">${esc(i.license_code)}</td><td>${esc(i.products?.title)}</td>
        <td>${esc(i.license_types?.name)}</td><td class="mono">${fmtDate(i.issued_at)}</td><td>${i.revoked_at ? badge("rejected").replace("Rechazado", "Revocada") : badge("approved").replace("Aprobado", "Vigente")}</td>
        <td style="text-align:right">${i.revoked_at ? "" : `<button class="btn sm red" data-act="revoke" data-id="${i.id}">Revocar</button>`}</td></tr>`).join("")}</tbody></table></div>`);
}

async function viewFiles() {
  const f = filters.files ?? { page: 0 };
  filters.files = f;
  const [{ data: files, count }, { data: orphans }] = await Promise.all([
    sb.from("product_files").select("id, kind, bucket, storage_path, size_bytes, products(title)", { count: "exact" })
      .order("created_at", { ascending: false }).range(f.page * PAGE, f.page * PAGE + PAGE - 1),
    sb.rpc("admin_orphan_storage"),
  ]);
  shell(`<h1>Archivos</h1>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Producto</th><th>Tipo</th><th>Bucket</th><th>Tamaño</th><th>Ruta</th><th></th></tr></thead>
      <tbody>${(files ?? []).map((x) => `<tr><td>${esc(x.products?.title)}</td><td>${esc(x.kind)}</td><td class="mono">${esc(x.bucket)}</td>
        <td>${(x.size_bytes / 1048576).toFixed(1)} MB</td><td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis">${esc(x.storage_path)}</td>
        <td><button class="btn sm red" data-act="delete-file" data-id="${x.id}">Eliminar</button></td></tr>`).join("")
        || `<tr><td colspan="6" class="mono">Sin archivos.</td></tr>`}</tbody></table></div>
    ${pager(f.page, count ?? 0, "files")}
    <div class="spread" style="margin-top:26px"><h2>Archivos huérfanos en Storage</h2></div>
    <p class="note">Objetos en Storage sin registro en la base. Se pueden eliminar sin afectar a ningún producto.</p>
    <div class="card" style="margin-top:10px;padding:0;overflow:auto"><table>
      <thead><tr><th>Bucket</th><th>Ruta</th><th>Tamaño</th><th>Creado</th><th></th></tr></thead>
      <tbody>${(orphans ?? []).map((o) => `<tr><td class="mono">${esc(o.bucket_id)}</td><td class="mono">${esc(o.name)}</td>
        <td>${o.size_bytes ? (o.size_bytes / 1048576).toFixed(1) + " MB" : "—"}</td><td class="mono">${fmtDate(o.created_at)}</td>
        <td><button class="btn sm red" data-act="delete-orphan" data-bucket="${esc(o.bucket_id)}" data-path="${esc(o.name)}">Eliminar</button></td></tr>`).join("")
        || `<tr><td colspan="5" class="mono">No hay archivos huérfanos.</td></tr>`}</tbody></table></div>`);
}

async function viewCoupons() {
  const { data } = await sb.from("coupons").select("*").order("created_at", { ascending: false });
  shell(`<div class="spread"><h1>Cupones y promociones</h1><button class="btn red" data-act="coupon-new">Nuevo cupón</button></div>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Código</th><th>Descuento</th><th>Vence</th><th>Usos</th><th>Activo</th><th></th></tr></thead>
      <tbody>${(data ?? []).map((c) => `<tr><td class="mono">${esc(c.code)}</td>
        <td>${c.percent_off ? c.percent_off + " %" : money(c.amount_off_cents, "USD")}</td><td class="mono">${c.valid_until ? new Date(c.valid_until).toLocaleDateString("es-PE") : "—"}</td>
        <td>${c.redemptions}${c.max_redemptions ? " / " + c.max_redemptions : ""}</td><td>${c.is_active ? "Sí" : "No"}</td>
        <td class="row" style="justify-content:flex-end"><button class="btn sm" data-act="coupon-toggle" data-id="${c.id}" data-on="${c.is_active ? 0 : 1}">${c.is_active ? "Desactivar" : "Activar"}</button>
        ${c.redemptions === 0 ? `<button class="btn sm red" data-act="coupon-del" data-id="${c.id}">Eliminar</button>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="6" class="mono">Sin cupones.</td></tr>`}</tbody></table></div>`);
}

async function viewMessages() {
  const { data } = await sb.from("contact_messages").select("*").order("created_at", { ascending: false }).limit(200);
  shell(`<h1>Mensajes de contacto</h1>
    <div style="display:grid;gap:12px;margin-top:18px">${(data ?? []).map((m) => `<div class="card">
      <div class="spread"><b>${esc(m.name)} · <a href="mailto:${esc(m.email)}">${esc(m.email)}</a></b><span class="mono">${fmtDate(m.created_at)}</span></div>
      <p class="mono" style="margin:6px 0">${esc(m.reason)} ${m.is_read ? "· leído" : '· <span style="color:#ffc27a">nuevo</span>'}</p>
      <p style="white-space:pre-wrap;line-height:1.5">${esc(m.message)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn sm" data-act="msg-read" data-id="${m.id}" data-on="${m.is_read ? 0 : 1}">${m.is_read ? "Marcar no leído" : "Marcar leído"}</button></div></div>`).join("") || '<p class="mono">Sin mensajes.</p>'}</div>`);
}

async function viewSettings() {
  const { data } = await sb.from("settings").select("key, value");
  const s = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const pm = s.payment_methods ?? {};
  const c = s.contact ?? {};
  const so = s.social ?? {};
  shell(`<h1>Configuración general</h1>
    <form class="card" data-submit="settings" style="margin-top:18px;display:grid;gap:16px">
      <div class="grid2">
        <label>Nombre de la plataforma<input name="site_name" value="${esc(s.site_name ?? "")}"></label>
        <label>Moneda<select name="currency">${["USD", "PEN"].map((m) => `<option ${s.currency === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <label>Correo de contacto<input name="contact_email" type="email" value="${esc(c.email ?? "")}"></label>
        <label>Teléfono / WhatsApp<input name="contact_phone" value="${esc(c.phone ?? "")}"></label>
        <label>Horario de atención<input name="contact_hours" value="${esc(c.hours ?? "")}"></label>
        <label>Instagram (URL)<input name="social_instagram" value="${esc(so.instagram ?? "")}"></label>
        <label>YouTube (URL)<input name="social_youtube" value="${esc(so.youtube ?? "")}"></label>
        <label>TikTok (URL)<input name="social_tiktok" value="${esc(so.tiktok ?? "")}"></label>
      </div>
      <h2>Métodos de pago</h2>
      <div class="grid2">
        <label class="chk"><input type="checkbox" name="pm_paypal" ${pm.paypal ? "checked" : ""}> PayPal habilitado (requiere credenciales en el servidor)</label>
        <label class="chk"><input type="checkbox" name="pm_yape" ${pm.yape ? "checked" : ""}> Yape habilitado (validación manual)</label>
        <label>Número de Yape<input name="yape_number" value="${esc(pm.yape_number ?? "")}"></label>
        <label>Titular de Yape<input name="yape_holder" value="${esc(pm.yape_holder ?? "")}"></label>
      </div>
      <label>Nosotros (párrafos separados por línea en blanco)<textarea name="about" rows="6">${esc(s.about ?? "")}</textarea></label>
      <label>Equipo (JSON: [{"name":"","role":"","photo_path":""}])<textarea name="team" rows="4">${esc(JSON.stringify(s.team ?? [], null, 1))}</textarea></label>
      <label>Términos y condiciones<textarea name="terms" rows="6">${esc(s.terms ?? "")}</textarea></label>
      <label>Política de privacidad<textarea name="privacy" rows="6">${esc(s.privacy ?? "")}</textarea></label>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn red" type="submit">Guardar configuración</button></div>
    </form>`);
}

async function viewAudit() {
  const { data } = await sb.from("admin_audit_log").select("action, entity, entity_id, details, created_at, actor_id")
    .order("created_at", { ascending: false }).limit(200);
  shell(`<h1>Auditoría</h1><p class="note">Acciones administrativas registradas. No se pueden editar ni borrar desde la API.</p>
    <div class="card" style="margin-top:18px;padding:0;overflow:auto"><table>
      <thead><tr><th>Fecha</th><th>Acción</th><th>Entidad</th><th>ID</th><th>Actor</th></tr></thead>
      <tbody>${(data ?? []).map((a) => `<tr><td class="mono">${fmtDate(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.entity)}</td>
        <td class="mono">${esc(a.entity_id ?? "")}</td><td class="mono">${esc((a.actor_id ?? "—").slice(0, 8))}</td></tr>`).join("")}</tbody></table></div>`);
}

// ---------------------------------------------------------------------------
// Enrutado
// ---------------------------------------------------------------------------
async function render() {
  if (!configured) { root.innerHTML = `<div class="login"><div class="card"><h1>Panel sin configurar</h1><p>Falta la clave pública en <code>assets/js/config.js</code>.</p></div></div>`; return; }
  if (!state.session) return loginView();
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
  state.route = parts[0] ?? "dashboard";
  try {
    if (!parts[0] || parts[0] === "dashboard") await viewDashboard();
    else if (parts[0] === "productos" && TYPES.includes(parts[1]) && parts[2]) await viewProductForm(parts[1], parts[2]);
    else if (parts[0] === "productos" && TYPES.includes(parts[1])) await viewProductList(parts[1]);
    else if (parts[0] === "taxonomia") await viewTaxonomy();
    else if (parts[0] === "usuarios") await viewUsers();
    else if (parts[0] === "pedidos") await viewOrders();
    else if (parts[0] === "pagos") await viewPayments();
    else if (parts[0] === "licencias") await viewLicenses();
    else if (parts[0] === "archivos") await viewFiles();
    else if (parts[0] === "cupones") await viewCoupons();
    else if (parts[0] === "mensajes") await viewMessages();
    else if (parts[0] === "configuracion") await viewSettings();
    else if (parts[0] === "auditoria") await viewAudit();
    else shell(`<h1>No encontrado</h1>`);
  } catch (e) {
    shell(`<h1>Error</h1><p class="note">${esc(errMsg(e))}</p>`);
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
const acts = {
  close: () => closeModal(),
  logout: async () => { await sb.auth.signOut(); location.hash = ""; },
  page: (el) => { const f = filters[el.dataset.key] ?? (filters[el.dataset.key] = {}); f.page = Number(el.dataset.page); render(); },
  "set-status": async (el) => {
    const status = el.dataset.status;
    const patch = { status };
    if (status === "published") patch.published_at = new Date().toISOString();
    const { error } = await sb.from("products").update(patch).eq("id", el.dataset.id);
    if (error) return fail(error);
    toast(status === "published" ? "Publicado en la tienda" : status === "draft" ? "Despublicado" : "Archivado");
    render();
  },
  "delete-product": async (el) => {
    const ok = await confirmBox(`¿Eliminar "${el.dataset.title}" y todos sus archivos? Esta acción no se puede deshacer. Si tiene ventas, se bloqueará y deberás archivarlo.`, "Eliminar");
    if (!ok) return;
    try {
      const r = await callFn("admin-delete", { product_id: el.dataset.id });
      toast(r.storage_errors?.length ? "Eliminado; revisa archivos huérfanos" : "Producto eliminado");
      render();
    } catch (e) { fail(e); }
  },
  "delete-file": async (el) => {
    const ok = await confirmBox("¿Eliminar este archivo? Si ya fue descargado, la base lo impedirá; en ese caso sustitúyelo.", "Eliminar");
    if (!ok) return;
    try { await callFn("admin-delete", { file_id: el.dataset.id }); toast("Archivo eliminado"); render(); }
    catch (e) { fail(e); }
  },
  "delete-orphan": async (el) => {
    const ok = await confirmBox("¿Eliminar este objeto huérfano de Storage?", "Eliminar");
    if (!ok) return;
    try { await callFn("admin-delete", { storage_bucket: el.dataset.bucket, storage_path: el.dataset.path }); toast("Huérfano eliminado"); render(); }
    catch (e) { fail(e); }
  },
  "tax-new": (el) => taxForm(el.dataset.table),
  "tax-edit": async (el) => {
    const { data } = await sb.from(el.dataset.table).select("*").eq("id", el.dataset.id).maybeSingle();
    if (data) taxForm(el.dataset.table, data);
  },
  "tax-del": async (el) => {
    const ok = await confirmBox(`¿Eliminar "${el.dataset.name}"? Los productos que la usaban quedarán sin esa asignación.`, "Eliminar");
    if (!ok) return;
    const { error } = await sb.from(el.dataset.table).delete().eq("id", el.dataset.id);
    if (error) return fail(error);
    toast("Eliminado"); render();
  },
  role: async (el) => {
    const on = el.dataset.on === "1";
    const ok = await confirmBox(on ? "¿Dar rol de administrador a este usuario?" : "¿Quitar rol de administrador a este usuario?", "Confirmar");
    if (!ok) return;
    const { error } = await sb.rpc("admin_set_role", { p_user: el.dataset.user, p_role: el.dataset.role, p_on: on });
    if (error) return fail(error);
    toast("Rol actualizado"); render();
  },
  "order-detail": (el) => orderDetail(el.dataset.id),
  "yape-review": async (el) => {
    const approve = el.dataset.approve === "1";
    let reason = null;
    if (!approve) {
      reason = prompt("Motivo del rechazo (visible en auditoría):") ?? "";
      if (!reason.trim()) return;
    }
    const ok = await confirmBox(approve ? "¿Confirmar que el pago llegó a la cuenta? Se emitirán las licencias." : "¿Rechazar este pago?", approve ? "Aprobar" : "Rechazar");
    if (!ok) return;
    const { error } = await sb.rpc("admin_review_yape", { p_payment: el.dataset.id, p_approve: approve, p_reason: reason });
    if (error) return fail(error);
    toast(approve ? "Pago aprobado y licencias emitidas" : "Pago rechazado");
    render();
  },
  "lt-save": async (el) => {
    const id = el.dataset.id;
    const get = (k) => document.querySelector(`[data-lt="${k}"][data-id="${id}"]`);
    let terms;
    try { terms = JSON.parse(get("terms").value || "{}"); } catch { return toast("Los términos deben ser JSON válido"); }
    const { error } = await sb.from("license_types").update({
      name: get("name").value.trim(),
      formats: get("formats").value.split(",").map((s) => s.trim()).filter(Boolean),
      is_exclusive: get("is_exclusive").checked,
      is_active: get("is_active").checked,
      terms,
    }).eq("id", id);
    if (error) return fail(error);
    toast("Licencia guardada");
  },
  revoke: async (el) => {
    const ok = await confirmBox("¿Revocar esta licencia? El cliente perderá el acceso a las descargas. No reembolsa el pago.", "Revocar");
    if (!ok) return;
    const { error } = await sb.from("issued_licenses").update({ revoked_at: new Date().toISOString() }).eq("id", el.dataset.id);
    if (error) return fail(error);
    toast("Licencia revocada"); render();
  },
  "coupon-new": () => couponForm(),
  "coupon-toggle": async (el) => {
    const { error } = await sb.from("coupons").update({ is_active: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return fail(error);
    render();
  },
  "coupon-del": async (el) => {
    const ok = await confirmBox("¿Eliminar este cupón?", "Eliminar");
    if (!ok) return;
    const { error } = await sb.from("coupons").delete().eq("id", el.dataset.id);
    if (error) return fail(error);
    render();
  },
  "msg-read": async (el) => {
    const { error } = await sb.from("contact_messages").update({ is_read: el.dataset.on === "1" }).eq("id", el.dataset.id);
    if (error) return fail(error);
    render();
  },
};

function couponForm() {
  modal(`<h2>Nuevo cupón</h2>
    <form data-submit="coupon" style="display:grid;gap:12px;margin-top:14px">
      <label>Código *<input name="code" required maxlength="40" style="text-transform:uppercase"></label>
      <div class="grid2">
        <label>Tipo<select name="kind"><option value="percent">Porcentaje</option><option value="amount">Monto fijo (US$)</option></select></label>
        <label>Valor *<input name="value" required inputmode="decimal"></label>
        <label>Válido hasta<input name="valid_until" type="date"></label>
        <label>Usos máximos (vacío = ilimitado)<input name="max_redemptions" type="number" min="1"></label>
      </div>
      <p class="field-err" data-err="form"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-act="close">Cancelar</button><button class="btn red" type="submit">Crear</button></div>
    </form>`);
}

// ---------------------------------------------------------------------------
// Formularios (delegación)
// ---------------------------------------------------------------------------
async function submitProduct(form) {
  const type = form.dataset.type;
  const id = form.dataset.id;
  const fd = new FormData(form);
  const errs = (k, msg) => { form.querySelector(`[data-err="${k}"]`).textContent = msg; };
  form.querySelectorAll("[data-err]").forEach((el) => (el.textContent = ""));

  const title = String(fd.get("title") ?? "").trim();
  if (!title) return errs("title", "El título es obligatorio.");
  const bpmRaw = String(fd.get("bpm") ?? "").trim();
  const bpm = bpmRaw ? Number(bpmRaw) : null;
  if (bpm !== null && (!Number.isInteger(bpm) || bpm < 40 || bpm > 300)) return errs("bpm", "BPM entre 40 y 300.");

  // Licencias: precios válidos para las activas.
  const { data: lts } = await sb.from("license_types").select("id").eq("is_active", true);
  const licRows = [];
  for (const l of lts ?? []) {
    if (!fd.get(`lic_on_${l.id}`)) continue;
    const priceTxt = String(fd.get(`lic_price_${l.id}`) ?? "").trim();
    const price = toCents(priceTxt);
    if (!priceTxt || !Number.isFinite(price) || price < 0) return errs("licenses", "Indica un precio válido para cada licencia activa.");
    const maxTxt = String(fd.get(`lic_max_${l.id}`) ?? "").trim();
    licRows.push({ license_type_id: l.id, price_cents: price, is_available: true, max_sales: maxTxt ? Number(maxTxt) : null });
  }
  if (!licRows.length) return errs("licenses", "Activa al menos una licencia con precio.");

  const attributes = buildAttributes(type, fd);
  const status = String(fd.get("status") ?? "draft");
  const base = {
    type, title, producer: String(fd.get("producer") ?? "").trim(), description: String(fd.get("description") ?? "").trim(),
    genre_id: fd.get("genre_id") || null, category_id: fd.get("category_id") || null,
    bpm, musical_key: String(fd.get("musical_key") ?? "").trim() || null,
    is_featured: fd.get("is_featured") === "on", status, attributes,
    price_cents: Math.min(...licRows.map((r) => r.price_cents)),
  };

  let productId = id;
  if (!id) {
    const slug = `${slugify(title) || "producto"}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await sb.from("products").insert({
      ...base, slug, published_at: status === "published" ? new Date().toISOString() : null,
    }).select("id").single();
    if (error) return errs("form", errMsg(error));
    productId = data.id;
  } else {
    const { data: cur } = await sb.from("products").select("published_at").eq("id", id).maybeSingle();
    const publishedAt = status === "published" ? (cur?.published_at ?? new Date().toISOString()) : cur?.published_at ?? null;
    const { error } = await sb.from("products").update({ ...base, published_at: publishedAt }).eq("id", id);
    if (error) return errs("form", errMsg(error));
  }

  // Licencias: reemplazo completo de las activas.
  await sb.from("product_licenses").delete().eq("product_id", productId);
  const { error: lErr } = await sb.from("product_licenses").insert(licRows.map((r) => ({ ...r, product_id: productId })));
  if (lErr) return errs("licenses", errMsg(lErr));

  // Etiquetas
  const names = [...new Set(String(fd.get("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  await sb.from("product_tags").delete().eq("product_id", productId);
  for (const name of names) {
    const slug = slugify(name);
    if (!slug) continue;
    const { data: tag } = await sb.from("tags").upsert({ name, slug }, { onConflict: "slug" }).select("id").single();
    if (tag) await sb.from("product_tags").insert({ product_id: productId, tag_id: tag.id });
  }

  toast("Producto guardado");
  location.hash = `#/productos/${type}/${productId}`;
  if (!id) return;
  render();
}

function buildAttributes(type, fd) {
  const s = (k) => String(fd.get(k) ?? "").trim();
  if (type === "drum_kit") return { sound_count: Number(s("sound_count")) || null, formats: s("formats") };
  if (type === "sample_pack") return { sample_count: Number(s("sample_count")) || null, formats: s("formats") };
  if (type === "plugin") return {
    developer: s("developer"), version: s("version"), plugin_formats: s("plugin_formats"),
    os_win: fd.get("os_win") === "on", os_mac: fd.get("os_mac") === "on", requirements: s("requirements"),
  };
  return {};
}

async function submitTaxonomy(form) {
  const table = form.dataset.table;
  const id = form.dataset.id;
  const fd = new FormData(form);
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  const row = { name, slug: slugify(name) };
  if (table === "categories") {
    row.parent_id = fd.get("parent_id") || null;
    row.description = String(fd.get("description") ?? "");
    row.sort_order = Number(fd.get("sort_order") ?? 0);
  }
  const { error } = id ? await sb.from(table).update(row).eq("id", id) : await sb.from(table).insert(row);
  if (error) return form.querySelector('[data-err="form"]').textContent = errMsg(error);
  closeModal(); toast("Guardado"); render();
}

async function submitSettings(form) {
  const fd = new FormData(form);
  const set = (key, value) => sb.from("settings").upsert({ key, value, updated_by: state.session.user.id, updated_at: new Date().toISOString() });
  let team;
  try { team = JSON.parse(String(fd.get("team") || "[]")); } catch { return form.querySelector('[data-err="form"]').textContent = "El equipo debe ser JSON válido."; }
  const writes = [
    set("site_name", String(fd.get("site_name") ?? "").trim()),
    set("currency", fd.get("currency")),
    set("contact", { email: String(fd.get("contact_email") ?? "").trim(), phone: String(fd.get("contact_phone") ?? "").trim(), hours: String(fd.get("contact_hours") ?? "").trim() }),
    set("social", { instagram: fd.get("social_instagram") || "", youtube: fd.get("social_youtube") || "", tiktok: fd.get("social_tiktok") || "" }),
    set("payment_methods", { paypal: fd.get("pm_paypal") === "on", yape: fd.get("pm_yape") === "on",
      yape_number: String(fd.get("yape_number") ?? "").trim(), yape_holder: String(fd.get("yape_holder") ?? "").trim() }),
    set("about", String(fd.get("about") ?? "")),
    set("team", team),
    set("terms", String(fd.get("terms") ?? "")),
    set("privacy", String(fd.get("privacy") ?? "")),
  ];
  const results = await Promise.all(writes);
  const failed = results.find((r) => r.error);
  if (failed) return form.querySelector('[data-err="form"]').textContent = errMsg(failed.error);
  toast("Configuración guardada");
}

async function submitCoupon(form) {
  const fd = new FormData(form);
  const kind = fd.get("kind");
  const value = Number(String(fd.get("value")).replace(",", "."));
  const row = {
    code: String(fd.get("code") ?? "").trim().toUpperCase(),
    percent_off: kind === "percent" ? Math.round(value) : null,
    amount_off_cents: kind === "amount" ? Math.round(value * 100) : null,
    valid_until: fd.get("valid_until") ? new Date(fd.get("valid_until") + "T23:59:59").toISOString() : null,
    max_redemptions: fd.get("max_redemptions") ? Number(fd.get("max_redemptions")) : null,
    is_active: true,
  };
  if (kind === "percent" && (row.percent_off < 1 || row.percent_off > 100)) return form.querySelector('[data-err="form"]').textContent = "Porcentaje entre 1 y 100.";
  if (kind === "amount" && !(row.amount_off_cents > 0)) return form.querySelector('[data-err="form"]').textContent = "El monto debe ser mayor que cero.";
  const { error } = await sb.from("coupons").insert(row);
  if (error) return form.querySelector('[data-err="form"]').textContent = errMsg(error);
  closeModal(); toast("Cupón creado"); render();
}

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-submit]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.submit;
  const btn = form.querySelector('[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    if (kind === "login") {
      const fd = new FormData(form);
      const { error } = await sb.auth.signInWithPassword({ email: fd.get("email"), password: fd.get("password") });
      if (error) return loginView(errMsg(error));
      state.session = (await sb.auth.getSession()).data.session;
      state.isAdmin = await checkAdmin();
      if (!state.isAdmin) { await sb.auth.signOut(); return loginView("Tu cuenta no tiene acceso de administrador."); }
      location.hash = "#/dashboard";
      render();
    } else if (kind === "product") await submitProduct(form);
    else if (kind === "tax") await submitTaxonomy(form);
    else if (kind === "settings") await submitSettings(form);
    else if (kind === "coupon") await submitCoupon(form);
  } catch (err) {
    fail(err);
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || !acts[el.dataset.act]) return;
  if (el.tagName === "A" && el.getAttribute("href") === "#") e.preventDefault();
  if (el.tagName === "BUTTON") e.preventDefault();
  acts[el.dataset.act](el, e);
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.upload) {
    const kind = el.dataset.upload;
    const productId = el.dataset.product;
    const bar = document.querySelector(`[data-progress="${kind}"]`);
    const files = [...el.files];
    if (!files.length) return;
    try {
      for (const file of files) {
        bar.hidden = false;
        bar.firstElementChild.style.width = "0%";
        await uploadFile(productId, kind, file, (pct) => { bar.firstElementChild.style.width = pct + "%"; });
      }
      toast("Archivo(s) subido(s)");
      render();
    } catch (err) { fail(err); bar.hidden = true; }
    return;
  }
  if (el.dataset.change === "dash") {
    filters.dash = { ...(filters.dash ?? {}), [el.dataset.field]: el.value };
    return render();
  }
  if (el.dataset.change === "pq") {
    const f = filters[`p-${el.dataset.type}`] ?? (filters[`p-${el.dataset.type}`] = {});
    f[el.dataset.field] = el.value; f.page = 0;
    return render();
  }
  if (el.dataset.change === "orders") { filters.orders = { ...(filters.orders ?? {}), status: el.value, page: 0 }; return render(); }
  if (el.dataset.change === "pays") { filters.pays = { ...(filters.pays ?? {}), [el.dataset.field]: el.value, page: 0 }; return render(); }
  if (el.dataset.change === "users") { filters.users = el.value; return render(); }
  if (el.dataset.change === "lic-filter") {
    const q = el.value.trim().toLowerCase();
    document.querySelectorAll("#issued tr").forEach((tr) => { tr.hidden = !!q && !tr.dataset.code.toLowerCase().includes(q); });
  }
});

// Búsqueda de productos con retardo para no consultar en cada tecla.
let searchTimer = null;
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.change === "pq" && el.dataset.field === "q") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const f = filters[`p-${el.dataset.type}`] ?? (filters[`p-${el.dataset.type}`] = {});
      f.q = el.value; f.page = 0; render();
    }, 400);
  }
  if (el.dataset.change === "users") { filters.users = el.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 250); }
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function boot() {
  if (!configured) return render();
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  state.isAdmin = session ? await checkAdmin() : false;
  if (session && !state.isAdmin) { await sb.auth.signOut(); state.session = null; return loginView("Tu cuenta no tiene acceso de administrador."); }
  sb.auth.onAuthStateChange((event, s) => {
    if (event === "SIGNED_OUT") { state.session = null; state.isAdmin = false; render(); }
  });
  window.addEventListener("hashchange", render);
  if (!location.hash) location.hash = "#/dashboard";
  render();
}

boot();
