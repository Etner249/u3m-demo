// POST { file_id } | { product_id } → elimina archivo o producto y sus objetos de Storage.
// Solo administradores. Si hay ventas o descargas registradas, no borra: pide archivar.
import { adminClient, auditLog, json, preflight, requireAdmin, UUID_RE } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);

  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  const actor = auth.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "JSON no válido" }, 400); }
  const admin = adminClient();

  // ---- Un archivo ----
  if (body.file_id !== undefined) {
    const fileId = String(body.file_id);
    if (!UUID_RE.test(fileId)) return json(req, { error: "Archivo no válido" }, 400);
    const { data: file } = await admin.from("product_files").select("*").eq("id", fileId).maybeSingle();
    if (!file) return json(req, { error: "Archivo no encontrado" }, 404);

    // Primero la fila: si tiene descargas, la base lo impide y no se toca Storage.
    const { error: delErr } = await admin.from("product_files").delete().eq("id", fileId);
    if (delErr) {
      return json(req, { error: "El archivo tiene descargas registradas. Sustitúyelo en lugar de borrarlo." }, 409);
    }
    const { error: stErr } = await admin.storage.from(file.bucket).remove([file.storage_path]);
    await auditLog(admin, actor, "file.delete", "product_file", fileId, { product_id: file.product_id });
    return json(req, { ok: true, storage_error: stErr ? stErr.message : null });
  }

  // ---- Un producto completo ----
  if (body.product_id !== undefined) {
    const productId = String(body.product_id);
    if (!UUID_RE.test(productId)) return json(req, { error: "Producto no válido" }, 400);

    const [{ count: sold }, { count: sales }] = await Promise.all([
      admin.from("issued_licenses").select("id", { count: "exact", head: true }).eq("product_id", productId),
      admin.from("order_items").select("id", { count: "exact", head: true }).eq("product_id", productId),
    ]);
    if ((sold ?? 0) > 0 || (sales ?? 0) > 0) {
      return json(req, { error: "Este producto tiene ventas. Archívalo en lugar de eliminarlo." }, 409);
    }

    const { data: files } = await admin.from("product_files").select("bucket, storage_path").eq("product_id", productId);
    const { error: delErr } = await admin.from("products").delete().eq("id", productId);
    if (delErr) return json(req, { error: "No se pudo eliminar el producto: " + delErr.message }, 409);

    // Storage después de la fila: si algo falla aquí, queda como huérfano visible en el panel.
    const storageErrors: string[] = [];
    for (const bucket of ["product-public", "product-private"]) {
      const paths = (files ?? []).filter((f) => f.bucket === bucket).map((f) => f.storage_path);
      if (paths.length === 0) continue;
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) storageErrors.push(`${bucket}: ${error.message}`);
    }
    await auditLog(admin, actor, "product.delete", "product", productId, { files: files?.length ?? 0 });
    return json(req, { ok: true, storage_errors: storageErrors });
  }

  // ---- Objeto huérfano de Storage (sin fila en product_files) ----
  if (body.storage_bucket !== undefined) {
    const bucket = String(body.storage_bucket);
    const path = String(body.storage_path ?? "");
    if (!["product-public", "product-private"].includes(bucket) || !path || path.includes("..")) {
      return json(req, { error: "Ruta de almacenamiento no válida" }, 400);
    }
    // Solo se borra si realmente no lo referencia ningún archivo de producto.
    const { data: ref } = await admin.from("product_files").select("id")
      .eq("bucket", bucket).eq("storage_path", path).maybeSingle();
    if (ref) return json(req, { error: "El objeto sí está en uso por un producto" }, 409);
    const { error } = await admin.storage.from(bucket).remove([path]);
    if (error) return json(req, { error: "No se pudo eliminar: " + error.message }, 500);
    await auditLog(admin, actor, "storage.orphan_delete", "storage_object", `${bucket}/${path}`);
    return json(req, { ok: true });
  }

  return json(req, { error: "Indica file_id, product_id o storage_bucket + storage_path" }, 400);
});
