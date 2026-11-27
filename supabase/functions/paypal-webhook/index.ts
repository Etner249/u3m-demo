// POST desde PayPal → verifica la firma con la API oficial y confirma el pago.
// Es la vía de respaldo: si el cliente cierra la pestaña tras pagar, el pedido se confirma igualmente.
// Desplegar con --no-verify-jwt (PayPal no envía JWT de Supabase). La firma es la autenticación.
import { adminClient, json } from "../_shared/common.ts";
import { paypalConfigured, paypalRequest } from "../_shared/paypal.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });
  if (!paypalConfigured() || !Deno.env.get("PAYPAL_WEBHOOK_ID")) {
    return new Response("Webhook no configurado", { status: 503 });
  }

  const raw = await req.text();
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("JSON no válido", { status: 400 }); }

  // 1) Verificación de firma con PayPal (no basta con leer el cuerpo).
  const h = (k: string) => req.headers.get(k) ?? "";
  const verify = await paypalRequest("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: Deno.env.get("PAYPAL_WEBHOOK_ID"),
    webhook_event: event,
  });
  if (verify.status >= 300 || verify.data?.verification_status !== "SUCCESS") {
    return new Response("Firma no válida", { status: 400 });
  }

  // 2) Solo las capturas completadas confirman pagos.
  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return json(req, { ignored: event.event_type });
  }
  const cap = event.resource ?? {};
  const paypalOrderId: string | undefined = cap.supplementary_data?.related_ids?.order_id;
  if (!paypalOrderId || cap.status !== "COMPLETED" || !cap.amount) {
    return new Response("Evento incompleto", { status: 400 });
  }

  // 3) Confirmación idempotente: si ya estaba aprobado, la función SQL no duplica nada.
  const admin = adminClient();
  const { data: res, error } = await admin.rpc("fulfill_paypal_order", {
    p_paypal_order: paypalOrderId,
    p_capture_id: String(cap.id),
    p_amount_cents: Math.round(Number(cap.amount.value) * 100),
    p_currency: cap.amount.currency_code,
    p_raw: { source: "webhook", event_id: event.id, capture_status: cap.status },
  });
  if (error) {
    // Pago desconocido para U3M: no reintentar indefinidamente.
    if (error.message.includes("desconocido")) return json(req, { ok: true, note: "pago no asociado" });
    // Otro error: PayPal reintenta con un código no 2xx.
    return new Response("No se pudo registrar: " + error.message, { status: 500 });
  }
  return json(req, { ok: true, result: res?.status ?? null });
});
