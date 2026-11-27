// Cliente mínimo de la API REST de PayPal (sin SDK de navegador).
// Credenciales solo desde variables de entorno del servidor.
const BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com";

export function paypalConfigured(): boolean {
  return !!(Deno.env.get("PAYPAL_CLIENT_ID") && Deno.env.get("PAYPAL_CLIENT_SECRET"));
}

let cached: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;
  const id = Deno.env.get("PAYPAL_CLIENT_ID") ?? "";
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET") ?? "";
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${id}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth ${res.status}`);
  const data = await res.json();
  cached = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

export async function paypalRequest(
  method: "GET" | "POST", path: string, body?: unknown, requestId?: string,
): Promise<{ status: number; data: any }> {
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}
