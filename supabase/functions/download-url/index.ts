// POST { file_id } → URL firmada de descarga de vida corta.
// Verifica en la base de datos que el usuario tiene una compra pagada con licencia vigente.
import { adminClient, hashIp, json, preflight, requireUser, UUID_RE } from "../_shared/common.ts";

const TTL = Number(Deno.env.get("SIGNED_URL_TTL_SECONDS") ?? "300");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);

  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "JSON no válido" }, 400); }
  const fileId = String(body.file_id ?? "");
  if (!UUID_RE.test(fileId)) return json(req, { error: "Archivo no válido" }, 400);

  // Comprobación con el JWT del usuario: la función SQL usa auth.uid().
  const { data: allowed, error: rpcErr } = await auth.uc.rpc("user_can_download", { p_file: fileId });
  if (rpcErr) return json(req, { error: "No se pudo verificar la compra" }, 500);
  if (allowed !== true) return json(req, { error: "No tienes una licencia vigente para este archivo" }, 403);

  const admin = adminClient();
  const { data: file } = await admin.from("product_files")
    .select("id, product_id, bucket, storage_path").eq("id", fileId).maybeSingle();
  if (!file || file.bucket !== "product-private") return json(req, { error: "Archivo no disponible" }, 404);

  // La ruta es <producto>/<tipo>/<uuid>-<nombre>; el nombre que ve el cliente no incluye el uuid.
  const lastSegment = file.storage_path.split("/").pop() ?? "archivo";
  const filename = lastSegment.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
  const { data: signed, error: sErr } = await admin.storage.from("product-private")
    .createSignedUrl(file.storage_path, TTL, { download: filename });
  if (sErr || !signed) return json(req, { error: "No se pudo generar el enlace" }, 500);

  // Registro de descarga con licencia asociada, si existe.
  const { data: lic } = await admin.from("issued_licenses").select("id")
    .eq("user_id", auth.user.id).eq("product_id", file.product_id).is("revoked_at", null)
    .order("issued_at", { ascending: false }).limit(1).maybeSingle();
  await admin.from("downloads").insert({
    user_id: auth.user.id,
    product_id: file.product_id,
    file_id: file.id,
    issued_license_id: lic?.id ?? null,
    ip_hash: await hashIp(req),
  });

  return json(req, { url: signed.signedUrl, expires_in: TTL });
});
