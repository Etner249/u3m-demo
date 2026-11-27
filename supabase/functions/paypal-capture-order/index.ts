// POST { order_id, paypal_order_id } → captura en PayPal y verifica en el servidor:
// estado COMPLETED, referencia del pedido, monto y moneda. Solo entonces emite licencias.
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
  const paypalOrderId = String(body.paypal_order_id ?? "");
  if (!UUID_RE.test(orderId) || !/^[A-Z0-9]{10,30}$/.test(paypalOrderId)) {
    return json(req, { error: "Datos de pago no válidos" }, 400);
  }

  // Dueño del pedido (RLS) y pago pendiente creado al iniciar el checkout.
  const { data: order } = await auth.uc.from("orders").select("id, status").eq("id", orderId).maybeSingle();
  if (!order) return json(req, { error: "Pedido no encontrado" }, 404);
  if (order.status === "paid") return json(req, { order_id: orderId, status: "paid" });

  const admin = adminClient();
  const { data: pay } = await admin.from("payments").select("id, order_id, status")
    .eq("provider", "paypal").eq("provider_ref", paypalOrderId).maybeSingle();
  if (!pay || pay.order_id !== orderId) return json(req, { error: "Pago no reconocido para este pedido" }, 404);

  // Captura. Si PayPal dice que ya fue capturada, se consulta el estado real.
  let details: any;
  let cap = await paypalRequest("POST", `/v2/checkout/orders/${paypalOrderId}/capture`, {}, `capture-${paypalOrderId}`);
  if (cap.status === 422 && JSON.stringify(cap.data).includes("ORDER_ALREADY_CAPTURED")) {
    cap = await paypalRequest("GET", `/v2/checkout/orders/${paypalOrderId}`);
  }
  if (cap.status >= 300) return json(req, { error: "PayPal no confirmó el pago" }, 402);
  details = cap.data;

  const unit = details?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (details?.status !== "COMPLETED" || capture?.status !== "COMPLETED") {
    return json(req, { error: "El pago no está completado" }, 402);
  }
  if (unit?.reference_id !== orderId) return json(req, { error: "La referencia del pago no coincide" }, 409);

  const cents = Math.round(Number(capture.amount.value) * 100);
  const { data: res, error } = await admin.rpc("fulfill_paypal_order", {
    p_paypal_order: paypalOrderId,
    p_capture_id: String(capture.id),
    p_amount_cents: cents,
    p_currency: capture.amount.currency_code,
    p_raw: { paypal_status: details.status, capture_status: capture.status },
  });
  if (error) return json(req, { error: "Pago verificado pero no registrado: " + error.message }, 409);

  // La base decide: pago confirmado, o retenido para revisión manual (monto distinto o licencia agotada).
  if (res?.status === "manual_review") {
    return json(req, { order_id: orderId, status: "manual_review", reason: res.reason }, 202);
  }
  return json(req, { order_id: orderId, status: "paid" });
});
