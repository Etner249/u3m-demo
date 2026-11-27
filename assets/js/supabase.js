// Cliente Supabase compartido por la tienda y el panel.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "./config.js";

export const configured = !!CONFIG.SUPABASE_ANON_KEY;

export const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Mensajes de error legibles para el usuario (sin filtrar detalles internos).
export function errMsg(error, fallback = "Ocurrió un error. Inténtalo de nuevo.") {
  if (!error) return fallback;
  const m = String(error.message ?? error);
  if (m.includes("Invalid login")) return "Correo o contraseña incorrectos.";
  if (m.includes("already registered")) return "Ya existe una cuenta con ese correo.";
  if (m.includes("Password should")) return "La contraseña debe tener al menos 8 caracteres.";
  if (m.includes("Email not confirmed")) return "Confirma tu correo antes de entrar.";
  if (m.includes("Failed to fetch")) return "No se pudo conectar con el servidor.";
  return m.length < 160 ? m : fallback;
}

export function publicUrl(bucket, path) {
  if (!sb || !path) return null;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const CURRENCY_LABEL = { USD: "US$", PEN: "S/" };
export function money(cents, currency = "USD") {
  const n = (Number(cents || 0) / 100).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n} ${CURRENCY_LABEL[currency] ?? currency}`;
}

export const TYPE_LABEL = {
  beat: "Beat", drum_kit: "Drum Kit", sample_pack: "Sample Pack", plugin: "Plugin",
};

export const STATUS_LABEL = {
  pending: "Pendiente", paid: "Pagado", failed: "Fallido", refunded: "Reembolsado", cancelled: "Cancelado",
  manual_review: "En revisión", approved: "Aprobado", rejected: "Rechazado",
};

// Lee la configuración pública (tabla settings) una sola vez por carga de página.
let settingsCache = null;
export async function getSettings() {
  if (settingsCache) return settingsCache;
  const out = {};
  if (sb) {
    const { data } = await sb.from("settings").select("key, value");
    for (const row of data ?? []) out[row.key] = row.value;
  }
  settingsCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// Imágenes: validación, optimización y subida con progreso
// ---------------------------------------------------------------------------
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Lanza un error legible si el archivo no es válido.
export function validateImage(file, { maxMb = 8, types = IMAGE_TYPES } = {}) {
  if (!file || !file.size) throw new Error("Selecciona una imagen.");
  if (!types.includes(file.type)) throw new Error("Formato no permitido. Usa " + types.map((t) => t.split("/")[1].toUpperCase()).join(", ") + ".");
  if (file.size > maxMb * 1048576) throw new Error(`La imagen supera ${maxMb} MB.`);
}

// Reduce el lado mayor a maxSide y convierte a WebP si ocupa menos. Si no mejora, devuelve el original.
export async function optimizeImage(file, { maxSide = 2000, quality = 0.86 } = {}) {
  if (file.type === "image/svg+xml" || file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  return blob && blob.size < file.size ? blob : file;
}

// Sube con XMLHttpRequest para reportar progreso. Usa el JWT del administrador: RLS decide.
export async function uploadWithProgress(bucket, path, body, contentType, onProgress) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Tu sesión caducó. Vuelve a iniciar sesión.");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CONFIG.SUPABASE_URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("apikey", CONFIG.SUPABASE_ANON_KEY);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(100); resolve(); }
      else reject(new Error("La subida falló (" + xhr.status + ")."));
    };
    xhr.onerror = () => reject(new Error("Error de red al subir la imagen."));
    xhr.send(body);
  });
}
