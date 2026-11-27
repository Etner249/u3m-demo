-- U3M — migración 0002: panel admin, checkout en servidor, pagos, estadísticas.
-- Requiere 20261127000000_init.sql. Solo añade objetos; no borra datos.

-- ---------------------------------------------------------------------------
-- Tablas nuevas
-- ---------------------------------------------------------------------------
create table if not exists public.product_plays (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references public.products(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists product_plays_product_idx on public.product_plays (product_id, created_at desc);
alter table public.product_plays enable row level security;
-- Sin políticas: solo se escribe mediante record_play().

create table if not exists public.contact_messages (
  id          bigint generated always as identity primary key,
  name        text not null check (length(name) between 1 and 120),
  email       text not null check (length(email) between 3 and 200),
  reason      text not null check (length(reason) between 1 and 60),
  message     text not null check (length(message) between 1 and 5000),
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.contact_messages enable row level security;
create policy "contact_admin_read"   on public.contact_messages for select using (public.has_role('admin'));
create policy "contact_admin_update" on public.contact_messages for update
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Licencias base (se pueden editar desde el panel)
insert into public.license_types (code, name, formats, terms, is_exclusive) values
  ('basic_mp3',   'Licencia básica MP3',   '{mp3}',                          '{"uses":"uso no exclusivo, distribución limitada"}', false),
  ('premium_wav', 'Licencia premium WAV',  '{mp3,wav}',                      '{"uses":"uso no exclusivo, archivo WAV"}',           false),
  ('unlimited',   'Licencia ilimitada',    '{mp3,wav,stems,kit,plugin}',     '{"uses":"uso ilimitado no exclusivo"}',               false),
  ('exclusive',   'Licencia exclusiva',    '{mp3,wav,stems,kit,plugin}',     '{"uses":"derechos exclusivos, venta única"}',        true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Funciones de administración y de rol
-- ---------------------------------------------------------------------------
create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then
    raise exception 'Se requiere rol administrador' using errcode = '42501';
  end if;
end $$;

-- Primer administrador: solo funciona si todavía no existe ninguno.
-- Se ejecuta desde el SQL Editor (rol postgres). No está expuesta a clientes.
create or replace function public.bootstrap_first_admin(p_email text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  v_user uuid;
  v_role smallint;
begin
  if exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where r.code = 'admin'
  ) then
    raise exception 'Ya existe un administrador. Usa admin_set_role desde el panel.';
  end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'No existe ninguna cuenta con ese correo. Regístrala primero.';
  end if;
  select id into v_role from public.roles where code = 'admin';
  insert into public.user_roles (user_id, role_id) values (v_user, v_role) on conflict do nothing;
  insert into public.admin_audit_log (actor_id, action, entity, entity_id, details)
  values (v_user, 'admin.bootstrap', 'user', v_user::text, '{}'::jsonb);
end $$;
revoke all on function public.bootstrap_first_admin(text) from public, anon, authenticated;

create or replace function public.admin_list_users()
returns table (id uuid, email text, display_name text, created_at timestamptz,
               last_sign_in_at timestamptz, roles text[])
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public.require_admin();
  return query
    select p.id, u.email::text, p.display_name, p.created_at, u.last_sign_in_at,
           coalesce(array_agg(r.code order by r.code) filter (where r.code is not null), '{}')
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.user_roles ur on ur.user_id = p.id
    left join public.roles r on r.id = ur.role_id
    group by p.id, u.email, p.display_name, p.created_at, u.last_sign_in_at
    order by p.created_at desc;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_role smallint;
  v_admins int;
begin
  perform public.require_admin();
  select id into v_role from public.roles where code = p_role;
  if v_role is null then raise exception 'Rol desconocido: %', p_role; end if;

  if p_role = 'admin' and not p_on then
    if p_user = auth.uid() then
      raise exception 'No puedes quitarte tu propio rol de administrador';
    end if;
    select count(*) into v_admins from public.user_roles ur join public.roles r on r.id = ur.role_id where r.code = 'admin';
    if v_admins <= 1 then raise exception 'Debe quedar al menos un administrador'; end if;
  end if;

  if p_on then
    insert into public.user_roles (user_id, role_id) values (p_user, v_role) on conflict do nothing;
  else
    delete from public.user_roles where user_id = p_user and role_id = v_role;
  end if;

  insert into public.admin_audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), case when p_on then 'role.grant' else 'role.revoke' end,
          'user', p_user::text, jsonb_build_object('role', p_role));
end $$;

-- Estadísticas reales del dashboard, filtradas por rango de fechas.
create or replace function public.admin_dashboard_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform public.require_admin();
  select jsonb_build_object(
    'users_total',        (select count(*) from public.profiles),
    'products_published', (select count(*) from public.products where status = 'published'),
    'sales_count',        (select count(*) from public.orders o where o.status = 'paid' and o.paid_at between p_from and p_to),
    'revenue_cents',      coalesce((select sum(o.total_cents) from public.orders o where o.status = 'paid' and o.paid_at between p_from and p_to), 0),
    'pending_payments',   (select count(*) from public.payments where status = 'manual_review'),
    'downloads_count',    (select count(*) from public.downloads d where d.created_at between p_from and p_to),
    'plays_count',        (select count(*) from public.product_plays pl where pl.created_at between p_from and p_to),
    'top_sold', coalesce((
        select jsonb_agg(t) from (
          select p.id, p.title, sum(1)::int as units
          from public.order_items oi
          join public.orders o on o.id = oi.order_id and o.status = 'paid' and o.paid_at between p_from and p_to
          join public.products p on p.id = oi.product_id
          group by p.id, p.title order by units desc limit 5) t), '[]'::jsonb),
    'top_played', coalesce((
        select jsonb_agg(t) from (
          select p.id, p.title, count(*)::int as plays
          from public.product_plays pl
          join public.products p on p.id = pl.product_id
          where pl.created_at between p_from and p_to
          group by p.id, p.title order by plays desc limit 5) t), '[]'::jsonb),
    'recent_activity', coalesce((
        select jsonb_agg(t) from (
          select action, entity, entity_id, created_at from public.admin_audit_log
          order by created_at desc limit 10) t), '[]'::jsonb),
    'daily_revenue', coalesce((
        select jsonb_agg(t order by t.day) from (
          select date_trunc('day', o.paid_at) as day, sum(o.total_cents)::bigint as cents, count(*)::int as sales
          from public.orders o
          where o.status = 'paid' and o.paid_at between p_from and p_to
          group by 1) t), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Catálogo público: reproducciones y contacto (solo por función)
-- ---------------------------------------------------------------------------
create or replace function public.record_play(p_product uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.products where id = p_product and status = 'published') then
    return;
  end if;
  insert into public.product_plays (product_id, user_id) values (p_product, auth.uid());
end $$;
revoke execute on function public.record_play(uuid) from public;
grant execute on function public.record_play(uuid) to anon, authenticated;

create or replace function public.submit_contact(p_name text, p_email text, p_reason text, p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.contact_messages where created_at > now() - interval '10 minutes') > 200 then
    raise exception 'Demasiados mensajes en poco tiempo. Intenta más tarde.';
  end if;
  insert into public.contact_messages (name, email, reason, message)
  values (trim(p_name), trim(p_email), trim(p_reason), trim(p_message));
end $$;
revoke execute on function public.submit_contact(text, text, text, text) from public;
grant execute on function public.submit_contact(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Entitlements y descargas
-- ---------------------------------------------------------------------------
-- Mapa de tipo de archivo a formato de licencia.
create or replace function public.file_format(p_kind file_kind)
returns text language sql immutable as $$
  select case p_kind
    when 'original_mp3' then 'mp3'
    when 'wav' then 'wav'
    when 'stems' then 'stems'
    when 'kit_archive' then 'kit'
    when 'plugin_installer' then 'plugin'
    else 'doc'
  end;
$$;

-- ¿El usuario actual puede descargar este archivo? (compra pagada, licencia vigente y formato incluido)
create or replace function public.user_can_download(p_file uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.product_files f
    where f.id = p_file
      and f.bucket = 'product-private'
      and (
        public.has_role('admin')
        or exists (
          select 1
          from public.issued_licenses il
          join public.license_types lt on lt.id = il.license_type_id
          join public.order_items oi on oi.id = il.order_item_id
          join public.orders o on o.id = oi.order_id
          where il.user_id = auth.uid()
            and il.product_id = f.product_id
            and il.revoked_at is null
            and o.status = 'paid'
            -- Todo archivo privado exige licencia: el formato debe estar incluido.
            -- Los documentos ('doc': manual y licencia) se incluyen en cualquier licencia.
            and (public.file_format(f.kind) = 'doc' or public.file_format(f.kind) = any (lt.formats))
        )
      )
  );
$$;
revoke execute on function public.user_can_download(uuid) from public;
grant execute on function public.user_can_download(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Carrito → pedido. El precio se toma SIEMPRE de product_licenses (servidor).
-- ---------------------------------------------------------------------------
create or replace function public.create_order_from_cart(p_coupon text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_order uuid;
  v_subtotal int := 0;
  v_discount int := 0;
  v_coupon public.coupons%rowtype;
  v_item record;
  v_price int;
  v_avail boolean;
  v_max int;
  v_sold int;
begin
  if v_user is null then raise exception 'Debes iniciar sesión'; end if;
  if not exists (select 1 from public.cart_items where user_id = v_user) then
    raise exception 'El carrito está vacío';
  end if;

  for v_item in
    select ci.product_id, ci.license_type_id, p.title, p.status
    from public.cart_items ci join public.products p on p.id = ci.product_id
    where ci.user_id = v_user
  loop
    if v_item.status <> 'published' then
      raise exception 'El producto "%" ya no está disponible', v_item.title;
    end if;
    -- Bloqueo de la fila de licencia: serializa a los compradores simultáneos de la misma licencia.
    select pl.price_cents, pl.is_available, pl.max_sales into v_price, v_avail, v_max
    from public.product_licenses pl
    where pl.product_id = v_item.product_id and pl.license_type_id = v_item.license_type_id
    for update;
    if v_price is null or not v_avail then
      raise exception 'La licencia de "%" no está disponible', v_item.title;
    end if;
    if v_max is not null then
      -- Emitidas + reservadas por pedidos pendientes de OTROS compradores (reserva de 30 minutos).
      select (select count(*) from public.issued_licenses il
               where il.product_id = v_item.product_id and il.license_type_id = v_item.license_type_id
                 and il.revoked_at is null)
           + (select count(*) from public.order_items oi
               join public.orders o on o.id = oi.order_id
              where oi.product_id = v_item.product_id and oi.license_type_id = v_item.license_type_id
                and o.status = 'pending' and o.user_id <> v_user
                and o.created_at > now() - interval '30 minutes')
        into v_sold;
      if v_sold >= v_max then raise exception 'La licencia de "%" está agotada', v_item.title; end if;
    end if;
    v_subtotal := v_subtotal + v_price;
  end loop;

  if p_coupon is not null and length(trim(p_coupon)) > 0 then
    select * into v_coupon from public.coupons
    where upper(code) = upper(trim(p_coupon)) and is_active
      and (valid_until is null or valid_until > now())
      and (max_redemptions is null or redemptions < max_redemptions);
    if v_coupon.id is null then raise exception 'Cupón no válido o expirado'; end if;
    if v_coupon.percent_off is not null then
      v_discount := floor(v_subtotal * v_coupon.percent_off / 100.0);
    else
      v_discount := least(v_coupon.amount_off_cents, v_subtotal);
    end if;
  end if;

  insert into public.orders (user_id, status, subtotal_cents, discount_cents, total_cents, currency, coupon_id)
  values (v_user, 'pending', v_subtotal, v_discount, v_subtotal - v_discount,
          left(coalesce((select value #>> '{}' from public.settings where key = 'currency'), 'USD'), 3),
          v_coupon.id)
  returning id into v_order;

  insert into public.order_items (order_id, product_id, license_type_id, unit_price_cents)
  select v_order, ci.product_id, ci.license_type_id, pl.price_cents
  from public.cart_items ci
  join public.product_licenses pl on pl.product_id = ci.product_id and pl.license_type_id = ci.license_type_id
  where ci.user_id = v_user;

  return v_order;
end $$;
revoke execute on function public.create_order_from_cart(text) from public;
grant execute on function public.create_order_from_cart(text) to authenticated;

-- Confirma un pedido: pedido pagado, licencias emitidas, carrito limpio.
create or replace function public._fulfill_order(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_max int;
  v_sold int;
begin
  select * into v_order from public.orders where id = p_order for update;
  if v_order.status = 'paid' then return 'paid'; end if;

  -- 1) Comprobar TODOS los artículos (con bloqueo) antes de escribir nada.
  for v_item in select oi.product_id, oi.license_type_id from public.order_items oi where oi.order_id = p_order loop
    select pl.max_sales into v_max from public.product_licenses pl
    where pl.product_id = v_item.product_id and pl.license_type_id = v_item.license_type_id
    for update;
    if v_max is not null then
      select count(*) into v_sold from public.issued_licenses
      where product_id = v_item.product_id and license_type_id = v_item.license_type_id and revoked_at is null;
      if v_sold >= v_max then return 'sold_out'; end if;
    end if;
  end loop;

  -- 2) Emitir licencias.
  for v_item in select oi.id, oi.product_id, oi.license_type_id from public.order_items oi where oi.order_id = p_order loop
    insert into public.issued_licenses (order_item_id, user_id, product_id, license_type_id, license_code)
    values (v_item.id, v_order.user_id, v_item.product_id, v_item.license_type_id,
            'U3M-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)));
  end loop;

  -- 3) Agotar la disponibilidad cuando se llega al máximo.
  update public.product_licenses pl set is_available = false
  where pl.max_sales is not null
    and exists (select 1 from public.order_items oi where oi.order_id = p_order
                and oi.product_id = pl.product_id and oi.license_type_id = pl.license_type_id)
    and (select count(*) from public.issued_licenses il
         where il.product_id = pl.product_id and il.license_type_id = pl.license_type_id
           and il.revoked_at is null) >= pl.max_sales;

  -- 4) Carrito, estado y cupón.
  delete from public.cart_items ci
  where ci.user_id = v_order.user_id
    and exists (select 1 from public.order_items oi where oi.order_id = p_order and oi.product_id = ci.product_id);

  update public.orders set status = 'paid', paid_at = now() where id = p_order;

  if v_order.coupon_id is not null then
    update public.coupons set redemptions = redemptions + 1 where id = v_order.coupon_id;
  end if;
  return 'paid';
end $$;
revoke all on function public._fulfill_order(uuid) from public, anon, authenticated;

-- Pago PayPal ya capturado (llamado por la Edge Function con service role).
-- Devuelve jsonb con el estado. No lanza RAISE para montos distintos o licencias agotadas:
-- en esos casos el pago queda en 'manual_review' y se conserva (no se revierte).
create or replace function public.fulfill_paypal_order(p_paypal_order text, p_capture_id text,
                                                       p_amount_cents int, p_currency text, p_raw jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments%rowtype;
  v_order public.orders%rowtype;
  v_res text;
begin
  select * into v_pay from public.payments
  where provider = 'paypal' and provider_ref = p_paypal_order for update;
  if v_pay.id is null then raise exception 'Pago PayPal desconocido'; end if;
  if v_pay.status = 'approved' then
    return jsonb_build_object('status', 'paid', 'order_id', v_pay.order_id, 'duplicate', true);
  end if;

  select * into v_order from public.orders where id = v_pay.order_id for update;
  if v_order.status <> 'pending' then raise exception 'El pedido no está pendiente'; end if;
  if exists (select 1 from public.payments where provider = 'paypal' and raw_event->>'capture_id' = p_capture_id) then
    raise exception 'Captura ya utilizada';
  end if;

  if p_amount_cents <> v_order.total_cents or upper(p_currency) <> upper(v_order.currency::text) then
    update public.payments
       set status = 'manual_review',
           raw_event = p_raw || jsonb_build_object('capture_id', p_capture_id, 'reason', 'amount_mismatch',
                                                   'received_cents', p_amount_cents, 'expected_cents', v_order.total_cents)
     where id = v_pay.id;
    return jsonb_build_object('status', 'manual_review', 'reason', 'amount_mismatch', 'order_id', v_order.id);
  end if;

  update public.payments
     set status = 'approved', verified_at = now(), amount_cents = p_amount_cents,
         raw_event = p_raw || jsonb_build_object('capture_id', p_capture_id)
   where id = v_pay.id;
  v_res := public._fulfill_order(v_order.id);
  if v_res = 'sold_out' then
    update public.payments
       set status = 'manual_review', raw_event = raw_event || jsonb_build_object('reason', 'sold_out')
     where id = v_pay.id;
    return jsonb_build_object('status', 'manual_review', 'reason', 'sold_out', 'order_id', v_order.id);
  end if;
  return jsonb_build_object('status', 'paid', 'order_id', v_order.id);
end $$;
revoke all on function public.fulfill_paypal_order(text, text, int, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fulfill_paypal_order(text, text, int, text, jsonb) from public;
grant execute on function public.fulfill_paypal_order(text, text, int, text, jsonb) to service_role;

-- Crea el pago PayPal pendiente al iniciar el checkout (llamado por la Edge Function con service role).
create or replace function public.register_paypal_attempt(p_order uuid, p_user uuid, p_paypal_order text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order;
  if v_order.id is null or v_order.user_id <> p_user then raise exception 'Pedido no válido'; end if;
  if v_order.status <> 'pending' then raise exception 'El pedido no está pendiente'; end if;
  insert into public.payments (order_id, provider, provider_ref, amount_cents, currency, status)
  values (p_order, 'paypal', p_paypal_order, v_order.total_cents, v_order.currency, 'pending');
end $$;
revoke all on function public.register_paypal_attempt(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.register_paypal_attempt(uuid, uuid, text) from public;
grant execute on function public.register_paypal_attempt(uuid, uuid, text) to service_role;

-- Yape: el cliente envía el código de operación; queda en revisión manual.
create or replace function public.submit_yape_payment(p_order uuid, p_operation_code text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order;
  if v_order.id is null or v_order.user_id <> auth.uid() then raise exception 'Pedido no válido'; end if;
  if v_order.status <> 'pending' then raise exception 'El pedido no está pendiente'; end if;
  if length(trim(p_operation_code)) < 4 then raise exception 'Código de operación no válido'; end if;
  insert into public.payments (order_id, provider, provider_ref, amount_cents, currency, status)
  values (p_order, 'yape', trim(p_operation_code), v_order.total_cents, v_order.currency, 'manual_review');
end $$;
revoke execute on function public.submit_yape_payment(uuid, text) from public;
grant execute on function public.submit_yape_payment(uuid, text) to authenticated;

-- Admin aprueba o rechaza un pago de Yape.
create or replace function public.admin_review_yape(p_payment uuid, p_approve boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments%rowtype;
begin
  perform public.require_admin();
  select * into v_pay from public.payments where id = p_payment for update;
  if v_pay.id is null or v_pay.provider <> 'yape' or v_pay.status <> 'manual_review' then
    raise exception 'Pago no pendiente de revisión';
  end if;
  if p_approve then
    if public._fulfill_order(v_pay.order_id) = 'sold_out' then
      raise exception 'Licencia agotada: este pago no puede confirmarse automáticamente';
    end if;
    update public.payments set status = 'approved', verified_at = now(), raw_event = jsonb_build_object('reviewed_by', auth.uid())
    where id = p_payment;
  else
    update public.payments set status = 'rejected', raw_event = jsonb_build_object('reason', p_reason, 'reviewed_by', auth.uid())
    where id = p_payment;
  end if;
  insert into public.admin_audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), case when p_approve then 'payment.approve' else 'payment.reject' end,
          'payment', p_payment::text, jsonb_build_object('order_id', v_pay.order_id, 'reason', p_reason));
end $$;
revoke execute on function public.admin_review_yape(uuid, boolean, text) from public;
grant execute on function public.admin_review_yape(uuid, boolean, text) to authenticated;

-- Auditoría de archivos huérfanos: objetos en Storage sin fila en product_files.
create or replace function public.admin_orphan_storage()
returns table (bucket_id text, name text, size_bytes bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public, storage as $$
begin
  perform public.require_admin();
  return query
    select o.bucket_id::text, o.name::text, (o.metadata->>'size')::bigint, o.created_at
    from storage.objects o
    where o.bucket_id in ('product-public', 'product-private')
      and o.name not like 'site/%'   -- logotipo, banners y promociones: se gestionan desde Portada
      and not exists (
        select 1 from public.product_files f where f.bucket = o.bucket_id and f.storage_path = o.name
      )
    order by o.created_at desc;
end $$;
revoke execute on function public.admin_orphan_storage() from public;
grant execute on function public.admin_orphan_storage() to authenticated;

-- ---------------------------------------------------------------------------
-- Políticas de escritura del admin (las que faltaban en 0001)
-- ---------------------------------------------------------------------------
-- Pedidos y pagos NO tienen escritura directa para admin: cambian solo por funciones
-- (admin_review_yape, fulfill_paypal_order), para que siempre se emitan las licencias.
create policy "issued_licenses_admin_write" on public.issued_licenses for update
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "downloads_admin_read_all" on public.downloads for select
  using (public.has_role('admin'));
create policy "cart_read_admin" on public.cart_items for select using (public.has_role('admin'));
create policy "favorites_admin_read" on public.favorites for select using (public.has_role('admin'));
create policy "product_plays_admin_read" on public.product_plays for select using (public.has_role('admin'));
create policy "order_items_admin_read" on public.order_items for select using (public.has_role('admin'));

-- El cliente ve los pagos de sus propios pedidos (para mostrar "en revisión" en Yape).
create policy "payments_owner_read" on public.payments for select using (
  exists (select 1 from public.orders o where o.id = payments.order_id and o.user_id = auth.uid()));

-- Lectura de archivos por el público y por el comprador.
-- Portadas, previews y demos: solo de productos publicados.
create policy "product_files_public_read" on public.product_files for select using (
  bucket = 'product-public' and exists (
    select 1 from public.products p where p.id = product_id and p.status = 'published'))
;
-- Originales: el comprador ve el listado de sus archivos (la URL real solo sale de download-url).
create policy "product_files_buyer_read" on public.product_files for select using (
  bucket = 'product-private' and exists (
    select 1 from public.issued_licenses il
    where il.product_id = product_files.product_id and il.user_id = auth.uid() and il.revoked_at is null))
;

-- Ajustes públicos: se amplía la lista de claves legibles por el sitio.
drop policy if exists "settings_public_read" on public.settings;
create policy "settings_public_read" on public.settings for select using (
  key in ('site_name', 'logo_path', 'currency', 'contact', 'social', 'banners',
          'payment_methods', 'terms', 'privacy', 'about', 'team', 'promo')
  or public.has_role('admin')
);

-- Ajustes por defecto (el cliente los cambia desde el panel).
insert into public.settings (key, value) values
  ('site_name', '"U3M — Urbano Beat Maker"'),
  ('currency', '"USD"'),
  ('contact', '{"email":"","phone":"","hours":""}'),
  ('social', '{}'),
  ('payment_methods', '{"paypal":false,"yape":false,"yape_number":"","yape_holder":""}'),
  ('terms', '""'),
  ('privacy', '""'),
  ('about', '""'),
  ('team', '[]')
on conflict (key) do nothing;

-- Escritura del cliente sobre su propio carrito ya existe (cart_owner). Pedidos: solo por función.

-- Compras: el cliente puede ver sus licencias (ya existe); la creación de pedidos es solo por función.
-- Perfiles: el cliente puede actualizar su propio perfil (profiles_self_update).

-- ---------------------------------------------------------------------------
-- Realtime/limpieza: los archivos borrados se eliminan del Storage desde la Edge Function admin-delete-file.
-- ---------------------------------------------------------------------------
