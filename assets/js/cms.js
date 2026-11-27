// Lectura del contenido administrable de la tienda (CMS).
// Una sola consulta por tipo al arrancar; RLS ya filtra lo no publicado.
import { sb } from "./supabase.js";

// Estructura por defecto si la migración 0003 aún no está aplicada: la tienda sigue funcionando.
const EMPTY = { nav: [], sections: [], banners: [], bestIds: [] };

export async function loadCms() {
  if (!sb) return EMPTY;
  try {
    const [nav, sections, banners, best] = await Promise.all([
      sb.from("nav_items").select("id, parent_id, label, url, category_id, sort_order, is_visible").eq("is_visible", true).order("sort_order"),
      sb.from("site_sections").select("id, internal_name, section_type, title, subtitle, description, image_path, bg_color, text_color, button_label, button_url, product_limit, sort_order, is_active, site_section_items(product_id, category_id, position)").order("sort_order"),
      sb.from("site_banners").select("id, title, description, eyebrow, image_path, bg_color, button_label, button_url, starts_at, ends_at, sort_order").eq("is_published", true).order("sort_order"),
      sb.rpc("best_seller_product_ids", { p_limit: 12 }),
    ]);
    if (nav.error || sections.error || banners.error) throw nav.error || sections.error || banners.error;
    const now = Date.now();
    return {
      nav: nav.data ?? [],
      sections: (sections.data ?? []).filter((s) => s.is_active),
      banners: (banners.data ?? []).filter((b) =>
        (!b.starts_at || new Date(b.starts_at).getTime() <= now) &&
        (!b.ends_at || new Date(b.ends_at).getTime() >= now)),
      bestIds: (best.data ?? []).map((r) => r.product_id),
    };
  } catch (e) {
    console.warn("CMS no disponible; se usa la estructura por defecto.", e?.message ?? e);
    return EMPTY;
  }
}

// Árbol de menú: { ...item, children: [...] }. Solo un nivel de submenú.
export function navTree(nav) {
  const top = nav.filter((n) => !n.parent_id);
  return top.map((t) => ({ ...t, children: nav.filter((c) => c.parent_id === t.id) }));
}
