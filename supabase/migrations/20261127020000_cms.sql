-- U3M — migración 0003: CMS de la tienda (inicio, banners, menú, categorías).
-- Requiere 0001 y 0002. No borra datos: solo añade columnas y tablas, y copia el banner
-- existente de settings a site_banners una sola vez.

-- ---------------------------------------------------------------------------
-- Categorías: imagen, miniatura, color representativo y activación
-- ---------------------------------------------------------------------------
alter table public.categories
  add column if not exists image_path text,
  add column if not exists thumb_path text,
  add column if not exists color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists is_active boolean not null default true;

-- Los visitantes solo ven categorías activas. Antes la política era "using (true)".
drop policy if exists "catalog_public_read" on public.categories;
create policy "categories_public_read" on public.categories for select
  using (is_active or public.has_role('admin'));

-- Número de productos publicados por categoría (para validar antes de eliminar).
create or replace function public.category_product_count(p_category uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.products
  where category_id = p_category and status <> 'archived';
$$;
grant execute on function public.category_product_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Secciones de la página de inicio
-- ---------------------------------------------------------------------------
create table if not exists public.site_sections (
  id            uuid primary key default gen_random_uuid(),
  internal_name text not null check (length(internal_name) between 1 and 120),
  section_type  text not null check (section_type in (
                  'featured_products','new_releases','best_sellers','featured_categories',
                  'promo_banner','editorial','collection','image_text')),
  title         text not null default '' check (length(title) <= 160),
  subtitle      text not null default '' check (length(subtitle) <= 200),
  description   text not null default '' check (length(description) <= 2000),
  image_path    text,
  bg_color      text check (bg_color is null or bg_color ~ '^#[0-9a-fA-F]{6}$'),
  text_color    text check (text_color is null or text_color ~ '^#[0-9a-fA-F]{6}$'),
  button_label  text not null default '' check (length(button_label) <= 60),
  button_url    text not null default '' check (length(button_url) <= 300),
  product_limit smallint not null default 4 check (product_limit between 1 and 12),
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists site_sections_order_idx on public.site_sections (sort_order);

-- Elementos de una sección: un producto o una categoría por fila.
create table if not exists public.site_section_items (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references public.site_sections(id) on delete cascade,
  product_id  uuid references public.products(id) on delete cascade,
  category_id uuid references public.categories(id) on delete cascade,
  position    integer not null default 0,
  constraint site_section_items_one_target check (num_nonnulls(product_id, category_id) = 1)
);
create index if not exists site_section_items_section_idx on public.site_section_items (section_id, position);

-- ---------------------------------------------------------------------------
-- Banners promocionales
-- ---------------------------------------------------------------------------
create table if not exists public.site_banners (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(title) between 1 and 120),
  description  text not null default '' check (length(description) <= 500),
  eyebrow      text not null default '' check (length(eyebrow) <= 30),   -- etiqueta, p. ej. NUEVO
  image_path   text,
  bg_color     text check (bg_color is null or bg_color ~ '^#[0-9a-fA-F]{6}$'),
  button_label text not null default '' check (length(button_label) <= 60),
  button_url   text not null default '' check (length(button_url) <= 300),
  starts_at    timestamptz,
  ends_at      timestamptz,
  is_published boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint site_banners_dates check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- Copia única del banner antiguo guardado en settings (si existe). No se borra el original.
insert into public.site_banners (title, description, image_path, button_label, button_url, is_published, sort_order)
select coalesce(b->>'title', 'Banner'), '', b->>'image_path', '', coalesce(b->>'link', ''),
       coalesce((b->>'active')::boolean, false), coalesce((b->>'sort')::int, 0)
from public.settings s, jsonb_array_elements(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) b
where s.key = 'banners'
  and not exists (select 1 from public.site_banners)
  and (b->>'image_path') is not null;

-- ---------------------------------------------------------------------------
-- Menú de navegación (con un nivel de submenú)
-- ---------------------------------------------------------------------------
create table if not exists public.nav_items (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid references public.nav_items(id) on delete cascade,
  label        text not null check (length(label) between 1 and 60),
  url          text not null check (length(url) between 1 and 300),
  category_id  uuid references public.categories(id) on delete set null,
  is_visible   boolean not null default true,
  is_protected boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint nav_items_no_self_parent check (parent_id is distinct from id)
);

-- Los enlaces esenciales no se pueden borrar (solo ocultar).
create or replace function public.prevent_protected_nav_delete()
returns trigger language plpgsql as $$
begin
  if old.is_protected then
    raise exception 'Este enlace es esencial y no se puede eliminar; puedes ocultarlo.';
  end if;
  return old;
end $$;
drop trigger if exists nav_items_protect on public.nav_items;
create trigger nav_items_protect before delete on public.nav_items
  for each row execute function public.prevent_protected_nav_delete();

-- ---------------------------------------------------------------------------
-- Ajustes del hero y de la tarjeta promocional del menú (en settings)
-- ---------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('hero', jsonb_build_object(
    'active', true,
    'eyebrow', 'Instrumentales con licencia por nivel',
    'title', 'Beats que rompen calle.',
    'subtitle', 'Compra una vez, descarga al confirmar el pago y usa cada producto según la licencia que elegiste.',
    'bg_color', '#ffffff', 'text_color', '#0c0c0c',
    'image_path', null, 'mobile_image_path', null,
    'button_label', 'Explorar catálogo', 'button_url', '#/catalogo',
    'secondary_label', 'Ver Drum Kits', 'secondary_url', '#/catalogo/drum-kits')),
  ('menu_promo', jsonb_build_object(
    'active', false, 'eyebrow', 'Nuevo', 'title', '', 'description', '',
    'image_path', null, 'button_label', 'Ver', 'button_url', '#/catalogo'))
on conflict (key) do nothing;

-- Lista blanca pública ampliada con las claves nuevas.
drop policy if exists "settings_public_read" on public.settings;
create policy "settings_public_read" on public.settings for select using (
  key in ('site_name', 'logo_path', 'currency', 'contact', 'social', 'banners',
          'payment_methods', 'terms', 'privacy', 'about', 'team', 'promo', 'hero', 'menu_promo')
  or public.has_role('admin')
);

-- ---------------------------------------------------------------------------
-- Más vendidos (público, sin datos personales): solo cuenta pedidos pagados.
-- ---------------------------------------------------------------------------
create or replace function public.best_seller_product_ids(p_limit int default 8)
returns table (product_id uuid, units bigint) language sql stable security definer set search_path = public as $$
  select oi.product_id, count(*)::bigint as units
  from public.order_items oi
  join public.orders o on o.id = oi.order_id and o.status = 'paid'
  join public.products p on p.id = oi.product_id and p.status = 'published'
  group by oi.product_id
  order by units desc
  limit greatest(1, least(p_limit, 24));
$$;
grant execute on function public.best_seller_product_ids(int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS del CMS
-- ---------------------------------------------------------------------------
alter table public.site_sections       enable row level security;
alter table public.site_section_items  enable row level security;
alter table public.site_banners        enable row level security;
alter table public.nav_items           enable row level security;

create policy "sections_public_read" on public.site_sections for select
  using (is_active or public.has_role('admin'));
create policy "sections_admin_write" on public.site_sections for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "section_items_public_read" on public.site_section_items for select using (
  public.has_role('admin') or exists (
    select 1 from public.site_sections s where s.id = section_id and s.is_active));
create policy "section_items_admin_write" on public.site_section_items for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "banners_public_read" on public.site_banners for select
  using (is_published or public.has_role('admin'));
create policy "banners_admin_write" on public.site_banners for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "nav_public_read" on public.nav_items for select
  using (is_visible or public.has_role('admin'));
create policy "nav_admin_write" on public.nav_items for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- ---------------------------------------------------------------------------
-- Contenido inicial: menú y secciones del inicio (mismo orden que el sitio original).
-- Solo se inserta si las tablas están vacías; el propietario lo edita desde el panel.
-- ---------------------------------------------------------------------------
insert into public.nav_items (label, url, is_protected, sort_order)
select * from (values
  ('Inicio', '#/', true, 0),
  ('Catálogo', '#/catalogo', true, 1),
  ('Nosotros', '#/nosotros', false, 90),
  ('Contacto', '#/contacto', false, 91)
) v(label, url, is_protected, sort_order)
where not exists (select 1 from public.nav_items);

-- Menú "Categorías" con un enlace por categoría principal (solo si no hay submenús todavía).
do $$
declare v_parent uuid;
begin
  if not exists (select 1 from public.nav_items where parent_id is not null) then
    insert into public.nav_items (label, url, sort_order) values ('Categorías', '#/catalogo', 2)
      returning id into v_parent;
    insert into public.nav_items (parent_id, label, url, category_id, sort_order)
    select v_parent, c.name, '#/catalogo/' || c.slug, c.id, c.sort_order
    from public.categories c where c.parent_id is null
    order by c.sort_order;
  end if;
end $$;

insert into public.site_sections (internal_name, section_type, title, subtitle, product_limit, sort_order)
select * from (values
  ('Destacados', 'featured_products', 'Destacados', '', 4, 10),
  ('Categorías', 'featured_categories', 'Por categoría', '', 8, 20),
  ('Cómo comprar', 'editorial', 'Compra hoy. Tuyo para siempre.', 'Escucha, compra, descarga.', 4, 30),
  ('Novedades', 'new_releases', 'Novedades', '', 8, 40)
) v(internal_name, section_type, title, subtitle, product_limit, sort_order)
where not exists (select 1 from public.site_sections);

-- ---------------------------------------------------------------------------
-- Auditoría de huérfanos: las imágenes del CMS cuentan como referenciadas.
-- ---------------------------------------------------------------------------
create or replace function public.admin_orphan_storage()
returns table (bucket_id text, name text, size_bytes bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public, storage as $$
begin
  perform public.require_admin();
  return query
    select o.bucket_id::text, o.name::text, (o.metadata->>'size')::bigint, o.created_at
    from storage.objects o
    where o.bucket_id in ('product-public', 'product-private')
      and not exists (select 1 from public.product_files f where f.bucket = o.bucket_id and f.storage_path = o.name)
      and not (o.bucket_id = 'product-public' and o.name like 'site/%' and (
        exists (select 1 from public.site_banners b where b.image_path = o.name)
        or exists (select 1 from public.site_sections s where s.image_path = o.name)
        or exists (select 1 from public.categories c where c.image_path = o.name or c.thumb_path = o.name)
        or exists (select 1 from public.settings st where st.value::text like '%' || o.name || '%')
      ))
    order by o.created_at desc;
end $$;
grant execute on function public.admin_orphan_storage() to authenticated;
