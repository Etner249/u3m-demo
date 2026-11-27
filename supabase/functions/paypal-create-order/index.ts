// POST { order_id } → crea la orden en PayPal con el total guardado en el servidor.
// Devuelve approve_url para redirigir al cliente. No habilita nada por sí misma.
import { adminClient, json, preflight, requireUser, UUID_RE } from "../_shared/common.ts";
import { paypalConfigured, paypalRequest } from "../_shared/paypal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);

  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  if (!paypalConfigured()) return json(req, { error: "PayPal no está configurado en el servidor" }, 503);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "JSON no válido" }, 400); }
  const orderId = String(body.order_id ?? "");
  if (!UUID_RE.test(orderId)) return json(req, { error: "Pedido no válido" }, 400);

  // RLS: solo el dueño del pedido lo puede leer.
  const { data: order } = await auth.uc.from("orders")
    .select("id, status, total_cents, currency").eq("id", orderId).maybeSingle();
  if (!order) return json(req, { error: "Pedido no encontrado" }, 404);
  if (order.status !== "pending") return json(req, { error: "El pedido ya no está pendiente" }, 409);
  if (order.total_cents <= 0) return json(req, { error: "Pedido sin importe a pagar" }, 400);

  const appBase = Deno.env.get("APP_BASE_URL") ?? "";
  const value = (order.total_cents / 100).toFixed(2);
  const payload = {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: order.id,
      custom_id: order.id,
      description: "Compra U3M",
      amount: { currency_code: order.currency, value },
    }],
    application_context: {
      brand_name: "U3M",
      user_action: "PAY_NOW",
      return_url: `${appBase}/#/pedido/${order.id}`,
      cancel_url: `${appBase}/#/pedido/${order.id}?cancelado=1`,
    },
  };

  const { status, data } = await paypalRequest("POST", "/v2/checkout/orders", payload, `create-${order.id}`);
  if (status >= 300 || !data?.id) return json(req, { error: "PayPal rechazó la orden" }, 502);

  const approve = (data.links ?? []).find((l: { rel: string }) => l.rel === "payer-action" || l.rel === "approve");
  if (!approve?.href) return json(req, { error: "PayPal no devolvió enlace de aprobación" }, 502);

  const admin = adminClient();
  const { error } = await admin.rpc("register_paypal_attempt", {
    p_order: order.id, p_user: auth.user.id, p_paypal_order: data.id,
  });
  if (error) return json(req, { error: error.message }, 409);

  return json(req, { paypal_order_id: data.id, approve_url: approve.href });
});
