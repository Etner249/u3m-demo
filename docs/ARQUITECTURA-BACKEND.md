# Arquitectura del backend (Fase 2)

## Decisión
- **Frontend**: se mantiene en GitHub Pages, HTML/JS vanilla, sin cambiar de framework.
- **Backend**: Supabase (Auth, Postgres, Storage, Edge Functions).

## Servicios y uso
| Servicio | Uso | Notas |
|---|---|---|
| Supabase Auth | Registro, login, verificación de correo, recuperación | Sesiones gestionadas por el SDK |
| Supabase Postgres | Datos del catálogo, pedidos, pagos, auditoría | RLS en todas las tablas |
| Supabase Storage | Bucket `product-public` (portadas, previews), `product-private` (originales, WAV, stems, ZIP), `avatars` | Privado sin políticas para clientes |
| Edge Functions | Verificar pagos PayPal, emitir URLs firmadas, registrar Yape | Único lugar con service role key |
| PayPal | Cobro | Verificación por API y webhook firmado |

Costos: **no verificados aquí**. Revisar precios vigentes en supabase.com/pricing y paypal.com antes de contratar. Egreso de Storage y límites del plan gratuito son los puntos a revisar.

## Reglas de seguridad
1. Ningún archivo musical se guarda en Postgres; solo rutas y metadatos.
2. Los originales están en bucket privado. Solo se entregan con URL firmada de vida corta (`SIGNED_URL_TTL_SECONDS`), tras validar que existe un pedido pagado y una licencia emitida.
3. La descarga solo se habilita cuando `payments.status = 'approved'` y el pedido está `paid`. Una redirección a pantalla de éxito no basta.
4. Los pagos se verifican desde el backend. `payments.provider_ref` es único: evita reutilizar una captura de PayPal o un código Yape.
5. Los roles no se modifican desde el cliente: no hay política de escritura en `user_roles`.
6. La auditoría es de solo lectura para admin y no se puede editar ni borrar desde la API.
7. `SUPABASE_SERVICE_ROLE_KEY`, `PAYPAL_CLIENT_SECRET` y claves de firma nunca van al frontend.

## Migración
`supabase/migrations/20261127000000_init.sql`: tipos, tablas, índices, restricciones, función `has_role`, trigger de alta de usuario, RLS y buckets.

Verificación realizada: análisis sintáctico con `pglast` (PostgreSQL 17 parser), 119 sentencias sin errores.
Pendiente: aplicarla en un proyecto Supabase de prueba y comprobar las políticas RLS con usuarios reales. No se ha ejecutado contra ninguna base de datos.

## Pendiente de autorización
- Crear el proyecto Supabase (cuenta, región, plan).
- Aplicar la migración en ese proyecto.
- Contratar o activar PayPal sandbox.
