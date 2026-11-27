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
