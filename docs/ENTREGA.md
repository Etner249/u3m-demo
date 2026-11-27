# U3M — Guía de instalación, administración y entrega

Esta guía es para quien instala, opera y transfiere la plataforma. Todo lo que aquí figura existe en el repositorio.

## 1. Arquitectura
- **Tienda**: `index.html` + `assets/js/` (HTML/JS vanilla, sin build). Hospedaje: GitHub Pages.
- **Panel**: `admin/` (mismo origen, sesión de Supabase; solo entra quien tenga rol `admin`).
- **Base y archivos**: Supabase (Postgres con RLS, Auth, Storage con buckets público y privado).
- **Lógica sensible**: Edge Functions en `supabase/functions/` (subida firmada, descarga firmada, PayPal, borrado seguro).

La seguridad real está en la base (RLS y funciones SQL), no en el navegador. El navegador solo muestra lo que la base permite.

## 2. Servicios externos y costos
| Servicio | Para qué | Costo |
|---|---|---|
| Supabase | Base, Auth, Storage, Edge Functions | Revisar precios vigentes en supabase.com/pricing. No verificados aquí. |
| PayPal | Cobros | Comisiones según el contrato del titular. Requiere cuenta de negocio. |
| GitHub Pages | Hospedaje de la tienda y el panel | Gratis para repositorios públicos. |

## 3. Variables de entorno

**Públicas** (van en `assets/js/config.js`, son seguras en el navegador):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`: clave *publishable/anon*. Nunca la `service_role`.
- `APP_BASE_URL`: URL pública de la tienda (retorno de PayPal).

**Secretas** (solo en Supabase → Edge Functions → Secrets, nunca en el repositorio):
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`
- `PAYPAL_API_BASE`: `https://api-m.sandbox.paypal.com` para pruebas; `https://api-m.paypal.com` en producción.
- `APP_BASE_URL`, `ALLOWED_ORIGINS` (orígenes permitidos, p. ej. `https://<usuario>.github.io`)
- `SIGNED_URL_TTL_SECONDS` (por defecto 300), `IP_HASH_SALT`

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta Supabase en las Edge Functions.

Plantilla sin valores reales: `.env.example`.

## 4. Puesta en marcha (una sola vez)

1. **Migraciones** en el SQL Editor del proyecto, en este orden:
   - `supabase/migrations/20261127000000_init.sql`
   - `supabase/migrations/20261127010000_admin_checkout.sql`
2. **Edge Functions**: con Supabase CLI instalado y el proyecto vinculado:
   ```powershell
   supabase functions deploy admin-sign-upload
   supabase functions deploy admin-delete
   supabase functions deploy download-url
   supabase functions deploy paypal-create-order
   supabase functions deploy paypal-capture-order
   ```
3. **Secretos** (Settings → Edge Functions → Secrets) según la sección 3.
4. **Clave pública**: pegar `SUPABASE_ANON_KEY` en `assets/js/config.js` y publicar.
5. **Autenticación** (Authentication → URL Configuration): añadir la URL de GitHub Pages como *Site URL* y como *Redirect URL*, para que los enlaces de confirmación y de recuperación vuelvan a la tienda.
6. **Catálogo inicial** (opcional): `supabase/seed/legacy-products.json` contiene los 22 productos del sitio original. Carga:
   ```powershell
   $env:SUPABASE_URL="https://<ref>.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY="<clave service_role>"
   npm --prefix scripts install
   node scripts/import-legacy-products.mjs
   ```
   La clave `service_role` se usa solo en tu equipo y nunca se guarda en el repositorio.

## 5. Primer administrador (seguro)

Ningún registro se convierte en administrador por sí mismo. El primer administrador se asigna una vez, desde el SQL Editor:

1. La persona que administrará se registra en la tienda (Mi cuenta → Crear cuenta) y confirma el correo.
2. En el SQL Editor:
   ```sql
   select public.bootstrap_first_admin('correo-del-administrador@ejemplo.com');
   ```
3. La función solo funciona si **todavía no existe ningún administrador**. Después, los administradores se gestionan desde Usuarios en el panel.

Para pruebas en desarrollo usa un correo de prueba, nunca el personal del desarrollador.

## 6. Uso del panel (`/admin/`)
- **Dashboard**: indicadores reales por rango de fechas (usuarios, ventas, ingresos, pagos pendientes, descargas, reproducciones, productos más vendidos y más reproducidos, actividad reciente).
- **Beats, Drum Kits, Sample Packs y Plugins**: crear, editar, publicar, despublicar, archivar y eliminar. Cada formulario sube portada, audios de demostración, archivos originales, licencias y precios con barra de progreso. La previsualización de audio se escucha antes de publicar.
- **Publicar**: el producto aparece en la tienda al instante. No hay que editar HTML ni JSON.
- **Eliminar**: si el producto tiene ventas o descargas, el sistema lo impide; usa *Archivar*.
- **Categorías, géneros y etiquetas**: alta, edición y borrado.
- **Usuarios**: otorgar o quitar rol administrador. Siempre queda al menos un administrador y nadie puede quitarse su propio rol.
- **Pedidos y pagos**: consulta de pedidos. Los pagos de **Yape** llegan en revisión: el administrador los aprueba (emite licencias) o los rechaza.
- **Licencias**: editar nombre, formatos, términos y si son exclusivas o están activas. Revocar licencias emitidas.
- **Archivos**: listado, eliminación y detección de archivos huérfanos en Storage.
- **Cupones**: porcentaje o monto fijo, fecha de vencimiento y límite de usos.
- **Mensajes**: formulario de contacto.
- **Configuración**: nombre, moneda, contacto, redes, métodos de pago (PayPal, Yape con número y titular), Nosotros, equipo, términos y privacidad.
- **Auditoría**: registro de acciones administrativas, no editable.

## 7. Flujo de compra
1. El cliente añade al carrito (requiere sesión).
2. Crea el pedido. **El precio lo calcula el servidor** desde la tabla de licencias; el navegador no lo decide.
3. Paga con PayPal (redirección) o con Yape (envía el código de operación).
4. **PayPal**: la Edge Function captura el pago, verifica estado, referencia, monto y moneda, y solo entonces emite licencias.
5. **Yape**: el administrador verifica la transferencia en su cuenta y aprueba en el panel.
6. La descarga se habilita solo con una licencia vigente y un pedido pagado. El enlace dura unos minutos.

## 8. Verificación antes de entregar
Pruebas que el responsable debe ejecutar en un entorno de pruebas (sandbox de PayPal) y luego en producción:
- [ ] Registro, confirmación de correo, inicio y cierre de sesión, recuperación de contraseña.
- [ ] Un usuario sin rol `admin` no ve datos del panel y no puede escribir en tablas administrativas.
- [ ] Crear, editar, publicar y despublicar un producto; comprobar que aparece y desaparece de la tienda.
- [ ] Subir portada, previsualización, original y archivo privado; comprobar que el archivo privado no tiene URL pública.
- [ ] Reproducir la muestra desde la ficha y desde la tarjeta.
- [ ] Compra con PayPal sandbox: el pedido pasa a pagado solo tras la captura, sin duplicados.
- [ ] Compra con Yape: queda en revisión y se emite licencia al aprobar.
- [ ] Biblioteca: solo los productos comprados, y descarga autorizada.
- [ ] Descarga sin licencia: bloqueada.
- [ ] Revisar la consola del navegador en la tienda y el panel.
- [ ] Probar en móvil (la tienda conserva el diseño original).

## 9. Pendiente y limitaciones reales
- **No probado en vivo**: el código se verificó por sintaxis y en una carga sin configurar. Falta la prueba de extremo a extremo con un proyecto Supabase y PayPal sandbox.
- **Webhook de PayPal**: no implementado. La captura desde el retorno de la tienda sí está. Si el cliente cierra la pestaña tras pagar, el pedido queda pendiente y debe confirmarse con un webhook (pendiente).
- **Logotipo y banners**: el logotipo es fijo en el sitio; los banners y promociones aún no se gestionan desde el panel.
- **Catálogo original**: el sitio original no tenía beats, solo otros productos. El panel sí gestiona beats.
- **Precios de la migración**: el sitio original mostraba Basic/Pro/Unlimited con multiplicadores. Se migran como básica (x1), premium WAV (x2.5) y ilimitada (x4). La exclusiva no se importó.
- **Portadas**: dos productos del original no tenían imagen en el repositorio; quedan sin portada hasta subirla.
- **Límite de tamaño**: los límites de subida dependen del plan de Supabase; revisa el límite por archivo de tu plan.
- **Antispam**: el formulario de contacto tiene un límite global básico, no por usuario.
- **Correos**: se usan las plantillas por defecto de Supabase Auth; conviene personalizarlas.

## 10. Entrega al propietario
1. Transferir el repositorio (o darle acceso como propietario).
2. Transferir el proyecto de Supabase (Settings → Transfer) o crear uno nuevo y repetir la sección 4.
3. Transferir la cuenta de PayPal y las credenciales a su titular; el titular las rota.
4. Ejecutar `bootstrap_first_admin` con **su** correo y quitar cualquier rol de pruebas.
5. Eliminar usuarios de prueba desde Authentication.
6. Restaurar en `.mcp.json` la configuración de solo lectura o eliminar el archivo (no debe quedar acceso de escritura a la base para el cliente).
7. Confirmar que no quedan correos personales en el historial de git ni en la configuración del repositorio.
