// Utilidades compartidas por las Edge Functions de U3M.
// Las claves de servicio solo existen aquí, en el servidor. Nunca se envían al navegador.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  // Solo se devuelve el origen si está en la lista blanca.
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? "null");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json; charset=utf-8" },
  });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

// Cliente con el JWT del usuario: RLS aplica.
export function userClient(req: Request): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Cliente con service role: salta RLS. Usar solo después de validar permisos.
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type AuthOk = { user: { id: string; email?: string }; uc: SupabaseClient };
type AuthResult = AuthOk | { error: Response };

export async function requireUser(req: Request): Promise<AuthResult> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: json(req, { error: "No autenticado" }, 401) };
  const uc = userClient(req);
  const { data, error } = await uc.auth.getUser(token);
  if (error || !data.user) return { error: json(req, { error: "Sesión no válida" }, 401) };
  return { user: data.user, uc };
}

// Comprueba el rol en la base de datos (función has_role), no en el token.
export async function requireAdmin(req: Request): Promise<AuthResult> {
  const r = await requireUser(req);
  if ("error" in r) return r;
  const { data, error } = await r.uc.rpc("has_role", { p_code: "admin" });
  if (error || data !== true) return { error: json(req, { error: "Se requiere rol administrador" }, 403) };
  return r;
}

export async function auditLog(
  admin: SupabaseClient, actorId: string, action: string, entity: string,
  entityId: string, details: Record<string, unknown> = {},
): Promise<void> {
  await admin.from("admin_audit_log").insert({
    actor_id: actorId, action, entity, entity_id: entityId, details,
  });
}

// Hash de IP con sal: nunca se guarda la IP en claro.
export async function hashIp(req: Request): Promise<string | null> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (!ip) return null;
  const salt = Deno.env.get("IP_HASH_SALT") ?? "";
  const buf = new TextEncoder().encode(salt + ip);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
