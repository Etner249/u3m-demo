-- U3M — esquema inicial (Fase 2)
-- Migración idempotente en lo posible. Ejecutar en Supabase SQL editor o `supabase db push`.
-- Ninguna tabla guarda archivos binarios: solo referencias a Supabase Storage.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
do $$ begin
  create type product_type   as enum ('beat', 'drum_kit', 'sample_pack', 'plugin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type product_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status   as enum ('pending', 'paid', 'failed', 'refunded', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending', 'approved', 'rejected', 'refunded', 'manual_review');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_provider as enum ('paypal', 'yape');
exception when duplicate_object then null; end $$;

do $$ begin
  create type file_kind as enum ('cover', 'promo_image', 'preview_audio', 'demo_audio',
                                 'original_mp3', 'wav', 'stems', 'kit_archive',
                                 'plugin_installer', 'user_manual', 'license_document', 'other');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Usuarios, roles y permisos
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_path  text,                       -- ruta en bucket público "avatars"
  preferences  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.roles (
  id   smallint generated always as identity primary key,
  code text not null unique               -- 'admin', 'customer'
);

create table if not exists public.permissions (
  id   smallint generated always as identity primary key,
  code text not null unique               -- 'products:write', 'orders:read', ...
);

create table if not exists public.role_permissions (
  role_id       smallint not null references public.roles(id) on delete cascade,
  permission_id smallint not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id smallint not null references public.roles(id) on delete cascade,
  primary key (user_id, role_id)
);

insert into public.roles (code) values ('admin'), ('customer')
  on conflict (code) do nothing;

-- Función de comprobación de rol: SECURITY DEFINER para evitar recursión de RLS.
create or replace function public.has_role(p_code text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.code = p_code
  );
$$;

-- Nuevo usuario => perfil + rol customer.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  insert into public.user_roles (user_id, role_id)
  select new.id, id from public.roles where code = 'customer';
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Taxonomía
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references public.categories(id) on delete restrict,
  slug       text not null unique,
  name       text not null,
  description text not null default '',
  sort_order int  not null default 0,
  constraint categories_no_self_parent check (parent_id is distinct from id)
);

create table if not exists public.genres (
  id   uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null
);

create table if not exists public.tags (
  id   uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null
);

-- ---------------------------------------------------------------------------
-- Productos
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  type          product_type not null,
  slug          text not null unique,
  title         text not null check (length(title) between 1 and 160),
  producer      text not null default '',         -- productor o artista
  description   text not null default '',
  category_id   uuid references public.categories(id) on delete set null,
  genre_id      uuid references public.genres(id) on delete set null,
  bpm           smallint check (bpm is null or bpm between 40 and 300),
  musical_key   text,                              -- p. ej. 'D Minor'
  price_cents   integer not null check (price_cents >= 0),
  currency      char(3) not null default 'USD',
  status        product_status not null default 'draft',
  is_featured   boolean not null default false,
  published_at  timestamptz,
  -- Metadatos específicos (Drum Kit: sound_count, formats, size; Plugin: version, os, requirements…)
  attributes    jsonb not null default '{}'::jsonb,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint products_published_has_date
    check (status <> 'published' or published_at is not null)
);

create index if not exists products_status_type_idx on public.products (status, type);
create index if not exists products_category_idx    on public.products (category_id);
create index if not exists products_featured_idx    on public.products (is_featured) where is_featured;

create table if not exists public.product_categories (
  product_id  uuid not null references public.products(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (product_id, category_id)
);

create table if not exists public.product_tags (
  product_id uuid not null references public.products(id) on delete cascade,
  tag_id     uuid not null references public.tags(id) on delete cascade,
  primary key (product_id, tag_id)
);
create index if not exists product_tags_tag_idx on public.product_tags (tag_id);

-- Archivos: referencias a Storage. Originales SOLO en bucket privado.
create table if not exists public.product_files (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products(id) on delete cascade,
  kind          file_kind not null,
  bucket        text not null,                    -- 'product-public' | 'product-private'
  storage_path  text not null,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  sha256        text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  created_at    timestamptz not null default now(),
  constraint product_files_bucket_check check (bucket in ('product-public', 'product-private')),
  constraint product_files_kind_bucket_check check (
    (kind in ('cover', 'promo_image', 'preview_audio', 'demo_audio') and bucket = 'product-public')
    or
    (kind not in ('cover', 'promo_image', 'preview_audio', 'demo_audio') and bucket = 'product-private')
  ),
  constraint product_files_unique_path unique (bucket, storage_path)
);
create index if not exists product_files_product_idx on public.product_files (product_id);

-- ---------------------------------------------------------------------------
-- Licencias configurables
-- ---------------------------------------------------------------------------
create table if not exists public.license_types (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,              -- basic_mp3, premium_wav, unlimited, exclusive
  name        text not null,
  formats     text[] not null default '{}',      -- formatos incluidos
  terms       jsonb not null default '{}'::jsonb,-- restricciones de uso
  is_exclusive boolean not null default false,
  is_active   boolean not null default true
);

-- Precio y disponibilidad por producto y tipo de licencia.
create table if not exists public.product_licenses (
  product_id      uuid not null references public.products(id) on delete cascade,
  license_type_id uuid not null references public.license_types(id) on delete restrict,
  price_cents     integer not null check (price_cents >= 0),
  is_available    boolean not null default true,
  -- Exclusiva: se vende una sola vez; al venderse se desactiva.
  max_sales       integer check (max_sales is null or max_sales > 0),
  primary key (product_id, license_type_id)
);

-- ---------------------------------------------------------------------------
-- Carrito, favoritos, cupones
-- ---------------------------------------------------------------------------
create table if not exists public.cart_items (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  product_id      uuid not null references public.products(id) on delete cascade,
  license_type_id uuid not null references public.license_types(id) on delete restrict,
  added_at        timestamptz not null default now(),
  primary key (user_id, product_id)                -- un producto por carrito
);

create table if not exists public.favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table if not exists public.coupons (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  percent_off   smallint check (percent_off between 1 and 100),
  amount_off_cents integer check (amount_off_cents > 0),
  valid_until   timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redemptions   integer not null default 0,
  is_active     boolean not null default true,
  constraint coupons_one_discount check (
    (percent_off is null) <> (amount_off_cents is null)
  )
);

-- ---------------------------------------------------------------------------
-- Pedidos y pagos
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete restrict,
  status         order_status not null default 'pending',
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  total_cents    integer not null check (total_cents >= 0),
  currency       char(3) not null default 'USD',
  coupon_id      uuid references public.coupons(id) on delete set null,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz,
  constraint orders_total_consistent check (total_cents = subtotal_cents - discount_cents)
);
create index if not exists orders_user_idx   on public.orders (user_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status);

create table if not exists public.order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  product_id      uuid not null references public.products(id) on delete restrict,
  license_type_id uuid not null references public.license_types(id) on delete restrict,
  unit_price_cents integer not null check (unit_price_cents >= 0),  -- precio congelado
  constraint order_items_unique_product unique (order_id, product_id)
);
create index if not exists order_items_product_idx on public.order_items (product_id);

create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete restrict,
  provider        payment_provider not null,
  provider_ref    text not null,                 -- id de captura PayPal o código de operación Yape
  amount_cents    integer not null check (amount_cents >= 0),
  currency        char(3) not null default 'USD',
  status          payment_status not null default 'pending',
  raw_event       jsonb,                         -- respuesta verificada del proveedor
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  -- Evita pagos duplicados: una referencia de proveedor solo puede usarse una vez.
  constraint payments_provider_ref_unique unique (provider, provider_ref)
);
create index if not exists payments_order_idx on public.payments (order_id);

-- Licencias emitidas por compra.
create table if not exists public.issued_licenses (
  id              uuid primary key default gen_random_uuid(),
  order_item_id   uuid not null unique references public.order_items(id) on delete restrict,
  user_id         uuid not null references public.profiles(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete restrict,
  license_type_id uuid not null references public.license_types(id) on delete restrict,
  license_code    text not null unique,         -- identificador legible
  issued_at       timestamptz not null default now(),
  revoked_at      timestamptz
);
create index if not exists issued_licenses_user_idx on public.issued_licenses (user_id);

-- ---------------------------------------------------------------------------
-- Descargas (historial)
-- ---------------------------------------------------------------------------
create table if not exists public.downloads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete restrict,
  product_id    uuid not null references public.products(id) on delete restrict,
  file_id       uuid not null references public.product_files(id) on delete restrict,
  issued_license_id uuid references public.issued_licenses(id) on delete restrict,
  ip_hash       text,                           -- hash, nunca IP en claro
  created_at    timestamptz not null default now()
);
create index if not exists downloads_user_idx on public.downloads (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Configuración y auditoría
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key        text primary key,                 -- 'site_name', 'currency', 'payment_methods', ...
  value      jsonb not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,                    -- 'product.publish', 'order.approve_yape', ...
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

-- Registro de intentos de autenticación fallidos (rate limit en Edge Function / auth hooks).
create table if not exists public.auth_attempts (
  id         bigint generated always as identity primary key,
  identifier text not null,                     -- hash del correo o IP
  created_at timestamptz not null default now()
);
create index if not exists auth_attempts_identifier_idx on public.auth_attempts (identifier, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers de updated_at
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.roles              enable row level security;
alter table public.permissions        enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.user_roles         enable row level security;
alter table public.categories         enable row level security;
alter table public.genres             enable row level security;
alter table public.tags               enable row level security;
alter table public.products           enable row level security;
alter table public.product_categories enable row level security;
alter table public.product_tags       enable row level security;
alter table public.product_files      enable row level security;
alter table public.license_types      enable row level security;
alter table public.product_licenses   enable row level security;
alter table public.cart_items         enable row level security;
alter table public.favorites          enable row level security;
alter table public.coupons            enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.payments           enable row level security;
alter table public.issued_licenses    enable row level security;
alter table public.downloads          enable row level security;
alter table public.settings           enable row level security;
alter table public.admin_audit_log    enable row level security;
alter table public.auth_attempts      enable row level security;

-- Catálogo público (solo lectura de lo publicado)
create policy "catalog_public_read" on public.categories for select using (true);
create policy "genres_public_read"  on public.genres     for select using (true);
create policy "tags_public_read"    on public.tags       for select using (true);
create policy "license_types_read"  on public.license_types for select using (is_active or public.has_role('admin'));

create policy "products_public_read" on public.products for select
  using (status = 'published' or public.has_role('admin'));
create policy "products_admin_write" on public.products for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "product_categories_read" on public.product_categories for select using (true);
create policy "product_tags_read"       on public.product_tags       for select using (true);
create policy "product_licenses_read" on public.product_licenses for select using (
  exists (select 1 from public.products p where p.id = product_id and (p.status = 'published' or public.has_role('admin')))
);

-- Archivos: el listado de metadatos solo es visible para admins.
-- Los archivos públicos se sirven desde el bucket público; los privados nunca.
create policy "product_files_admin" on public.product_files for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Taxonomía y catálogo: escritura solo admin
create policy "categories_admin_write" on public.categories for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "genres_admin_write" on public.genres for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "tags_admin_write" on public.tags for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "product_categories_admin_write" on public.product_categories for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "product_tags_admin_write" on public.product_tags for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "product_licenses_admin_write" on public.product_licenses for all
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "license_types_admin_write" on public.license_types for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Perfil: cada usuario ve y edita el suyo; admin ve todos.
create policy "profiles_self_read"   on public.profiles for select using (id = auth.uid() or public.has_role('admin'));
create policy "profiles_self_update" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid());
-- Los roles nunca se cambian desde el cliente: no hay política de escritura en user_roles.
create policy "user_roles_self_read" on public.user_roles for select using (user_id = auth.uid() or public.has_role('admin'));
create policy "roles_read" on public.roles for select using (true);
create policy "permissions_read" on public.permissions for select using (true);
create policy "role_permissions_read" on public.role_permissions for select using (true);

-- Carrito y favoritos: solo del propio usuario
create policy "cart_owner" on public.cart_items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "favorites_owner" on public.favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Cupones: el cliente no los lee; se validan en el backend.
create policy "coupons_admin" on public.coupons for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Pedidos: el cliente solo lee los suyos. Crear/modificar pagos NO está permitido al cliente:
-- lo hacen las Edge Functions con la service role key.
create policy "orders_owner_read" on public.orders for select
  using (user_id = auth.uid() or public.has_role('admin'));
create policy "order_items_owner_read" on public.order_items for select using (
  exists (select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.has_role('admin')))
);
create policy "payments_admin_read" on public.payments for select using (public.has_role('admin'));
create policy "issued_licenses_owner_read" on public.issued_licenses for select
  using (user_id = auth.uid() or public.has_role('admin'));
create policy "downloads_owner_read" on public.downloads for select
  using (user_id = auth.uid() or public.has_role('admin'));

-- Configuración: lectura pública de claves no sensibles; escritura solo admin.
create policy "settings_public_read" on public.settings for select using (
  key in ('site_name', 'logo_path', 'currency', 'contact', 'social', 'banners',
          'payment_methods', 'terms', 'privacy')
  or public.has_role('admin')
);
create policy "settings_admin_write" on public.settings for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Auditoría: solo admin lee; nadie edita ni borra desde la API.
create policy "audit_admin_read" on public.admin_audit_log for select using (public.has_role('admin'));
revoke update, delete, truncate on public.admin_audit_log from anon, authenticated;

-- Intentos de login: sin acceso desde el cliente.
-- (Sin políticas = denegado para anon/authenticated; solo service role.)

-- ---------------------------------------------------------------------------
-- Storage: buckets público y privado
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('product-public',  'product-public',  true,  52428800),    -- portadas, previews, demos (50 MB)
  ('product-private', 'product-private', false, 2147483648),  -- originales, WAV, stems, ZIP (2 GB)
  ('avatars',         'avatars',         true,  5242880)      -- imagen de perfil (5 MB)
on conflict (id) do nothing;

-- Escritura y lectura de product-private: ningún rol de cliente. Solo service role.
-- Escritura de product-public: solo admin.
create policy "product_public_admin_write" on storage.objects for all
  using (bucket_id = 'product-public' and public.has_role('admin'))
  with check (bucket_id = 'product-public' and public.has_role('admin'));
create policy "avatars_owner_write" on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars_public_read" on storage.objects for select
  using (bucket_id = 'avatars');
