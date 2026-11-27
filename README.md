# U3M — Urbano Beat Maker

Tienda de beats, drum kits, sample packs y plugins, con panel de administración.
Frontend estático (GitHub Pages) + Supabase (base, autenticación, archivos y funciones).

## Puesta en marcha (una vez)

Necesitas: Node.js 18 o superior y el repositorio clonado.

### 1. Abre PowerShell en la carpeta del proyecto
```powershell
cd "$HOME\Documents\U3M"
```

### 2. Define las claves solo para esta ventana de PowerShell
Las pide en pantalla y no las guarda en ningún archivo:
```powershell
$env:SUPABASE_SERVICE_ROLE_KEY = Read-Host "Clave service_role de Supabase"
$env:SUPABASE_ACCESS_TOKEN     = Read-Host "Token de acceso del CLI de Supabase"
```
- La clave `service_role` está en Supabase → Project Settings → API.
- El token se crea en https://supabase.com/dashboard/account/tokens.

### 3. Ejecuta la configuración
```powershell
npm --prefix scripts install
node scripts/setup-supabase.mjs
```
Esto despliega las Edge Functions, carga los 22 productos y crea las dos cuentas de prueba.
Al final muestra las contraseñas temporales **una sola vez**: cópialas.

### 4. Publica la tienda
```powershell
node scripts/publish-gh-pages.mjs --dry-run   # comprueba, sin publicar
node scripts/publish-gh-pages.mjs             # publica en gh-pages
```
El script no publica si no hay 22 productos ni si PayPal está activado.

## Opciones útiles
- `node scripts/setup-supabase.mjs --skip-functions` — no despliega funciones.
- `node scripts/setup-supabase.mjs --skip-products` — no carga productos.
- `node scripts/setup-supabase.mjs --skip-accounts` — no crea cuentas.

## Pagos
- **PayPal**: desactivado. Se activa desde el panel solo cuando el propietario configure sus credenciales en el servidor.
- **Yape**: modo manual. El cliente envía el código de operación y el administrador lo aprueba en el panel.

## Seguridad
- Ninguna clave se guarda en el repositorio. `service_role` y el token del CLI solo viven en la ventana de PowerShell.
- `.mcp.json`, `node_modules/` y `.atl/` están fuera de Git (`.gitignore`).
- Las ramas de respaldo `backup/gh-pages-2026-11-27` y `backup/pre-visual-2026-11-27` no se modifican.

## Pruebas de base de datos (sin conexión a Supabase)
```powershell
node scripts/test-migrations.mjs
```
Aplica 0001–0003 en un PostgreSQL local en memoria y ejecuta 45 comprobaciones de seguridad y negocio.

## Estructura
- `index.html`, `assets/`: tienda.
- `admin/`: panel administrativo.
- `supabase/migrations/`: esquema, políticas y CMS (0001–0003).
- `supabase/functions/`: Edge Functions.
- `scripts/`: configuración, carga de productos y publicación.
- `docs/ENTREGA.md`: documentación técnica completa.
