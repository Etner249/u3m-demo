// POST { product_id, kind, filename, size, mime } → URL firmada de subida.
// Solo administradores. Valida tipo, tamaño y MIME antes de firmar.
import { adminClient, json, preflight, requireAdmin, UUID_RE } from "../_shared/common.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const ZIP_RAR = ["application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
  "application/vnd.rar", "application/octet-stream"];

type Rule = { bucket: "product-public" | "product-private"; max: number; mimes: string[] };
const RULES: Record<string, Rule> = {
  cover:            { bucket: "product-public",  max: 10 * MB, mimes: ["image/jpeg", "image/png", "image/webp"] },
  promo_image:      { bucket: "product-public",  max: 10 * MB, mimes: ["image/jpeg", "image/png", "image/webp"] },
  preview_audio:    { bucket: "product-public",  max: 20 * MB, mimes: ["audio/mpeg"] },
  demo_audio:       { bucket: "product-public",  max: 50 * MB, mimes: ["audio/mpeg", "audio/wav", "audio/x-wav"] },
  original_mp3:     { bucket: "product-private", max: 300 * MB, mimes: ["audio/mpeg"] },
  wav:              { bucket: "product-private", max: 1 * GB, mimes: ["audio/wav", "audio/x-wav", "audio/wave"] },
  stems:            { bucket: "product-private", max: 2 * GB, mimes: ZIP_RAR },
  kit_archive:      { bucket: "product-private", max: 2 * GB, mimes: ZIP_RAR },
  plugin_installer: { bucket: "product-private", max: 1 * GB,
                      mimes: ["application/octet-stream", "application/x-msdownload", "application/x-apple-diskimage",
                              "application/zip", "application/x-zip-compressed"] },
  user_manual:      { bucket: "product-private", max: 50 * MB, mimes: ["application/pdf"] },
  license_document: { bucket: "product-private", max: 10 * MB, mimes: ["application/pdf"] },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);

  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "JSON no válido" }, 400); }

  const productId = String(body.product_id ?? "");
  const kind = String(body.kind ?? "");
  const filename = String(body.filename ?? "");
  const size = Number(body.size);
  const mime = String(body.mime || "application/octet-stream").toLowerCase();

  if (!UUID_RE.test(productId)) return json(req, { error: "Producto no válido" }, 400);
  const rule = RULES[kind];
  if (!rule) return json(req, { error: "Tipo de archivo no permitido" }, 400);
  if (!filename || filename.length > 255) return json(req, { error: "Nombre de archivo no válido" }, 400);
  if (!Number.isFinite(size) || size <= 0) return json(req, { error: "Tamaño no válido" }, 400);
  if (size > rule.max) return json(req, { error: "El archivo supera el tamaño permitido" }, 413);
  if (!rule.mimes.includes(mime)) return json(req, { error: `Formato no permitido para ${kind}` }, 415);

  const admin = adminClient();
  const { data: product, error: pErr } = await admin.from("products").select("id").eq("id", productId).maybeSingle();
  if (pErr) return json(req, { error: "Error al consultar el producto" }, 500);
  if (!product) return json(req, { error: "Producto no encontrado" }, 404);

  // Nombre seguro: sin rutas ni caracteres especiales; se conserva la extensión.
  const safe = filename.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^_+/, "").slice(-100) || "archivo";
  const path = `${productId}/${kind}/${crypto.randomUUID()}-${safe}`;

  const { data, error } = await admin.storage.from(rule.bucket).createSignedUploadUrl(path);
  if (error || !data) return json(req, { error: "No se pudo preparar la subida" }, 500);

  return json(req, {
    bucket: rule.bucket,
    path,
    signed_url: data.signedUrl,
    content_type: mime,
    expires_in: 7200,
  });
});
