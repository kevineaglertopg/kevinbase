-- =====================================================================
--  Automotora Aguilar · Esquema inicial de Supabase
--  Tablas: admins, cars (stock), requests (solicitudes "Vende tu auto")
--  Storage: car-photos (público), request-photos (privado)
--  Todas las tablas con Row Level Security (RLS) activado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Administradores
--    Solo los usuarios de Auth que estén en esta tabla pueden
--    administrar el sitio. Se agregan a mano desde el SQL Editor
--    (ver README). No hay políticas de escritura: nadie puede
--    convertirse en admin desde el navegador.
-- ---------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

create policy "admins: cada usuario ve solo su propia fila"
  on public.admins for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Función usada por todas las políticas. SECURITY DEFINER para poder
-- leer public.admins sin depender de su RLS; search_path vacío por seguridad.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Utilidad: mantener updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Autos (stock publicado en el sitio)
-- ---------------------------------------------------------------------
create table public.cars (
  id          uuid primary key default gen_random_uuid(),
  name        text    not null check (char_length(btrim(name)) between 1 and 120),
  brand       text    not null default '' check (char_length(brand) <= 60),
  type        text    not null default 'Sedán' check (char_length(type) between 1 and 40),
  color       text    not null default '' check (char_length(color) <= 40),
  trans       text    check (trans in ('Manual', 'Automática')),
  year        integer check (year between 1950 and 2100),
  km          integer check (km between 0 and 3000000),
  price       bigint  check (price between 0 and 100000000000),
  image_path  text    not null check (char_length(image_path) between 1 and 300),
  featured    boolean not null default false,
  recommended boolean not null default false,
  hidden      boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.cars.image_path is 'Ruta del archivo dentro del bucket car-photos';
comment on column public.cars.price is 'Precio en CLP. NULL = "Consultar"';

-- Solo un auto puede ser el "Recomendado" de la portada
create unique index cars_only_one_recommended on public.cars (recommended) where recommended;
create index cars_public_order on public.cars (sort_order) where not hidden;

create trigger cars_touch before update on public.cars
  for each row execute function public.touch_updated_at();

alter table public.cars enable row level security;

create policy "cars: todos ven los autos visibles; admin ve todos"
  on public.cars for select
  to anon, authenticated
  using (not hidden or (select public.is_admin()));

create policy "cars: solo admin crea"
  on public.cars for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "cars: solo admin edita"
  on public.cars for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "cars: solo admin elimina"
  on public.cars for delete
  to authenticated
  using ((select public.is_admin()));

-- Reordenar el stock en una sola operación (respeta RLS: SECURITY INVOKER)
create or replace function public.set_car_order(ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  update public.cars c
     set sort_order = array_position(ids, c.id) - 1
   where c.id = any (ids);
end;
$$;

revoke all on function public.set_car_order(uuid[]) from public, anon;
grant execute on function public.set_car_order(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Solicitudes del formulario "Vende / consigna / permuta tu auto"
--    El público solo puede CREAR (no leer, editar ni borrar).
-- ---------------------------------------------------------------------
create table public.requests (
  id         uuid primary key default gen_random_uuid(),
  servicio   text not null check (servicio in ('Quiero vender mi auto', 'Quiero consignar mi auto', 'Quiero una permuta')),
  nombre     text not null check (char_length(btrim(nombre)) between 1 and 120),
  whatsapp   text not null default '' check (char_length(whatsapp) <= 30 and whatsapp ~ '^[0-9 +().-]*$'),
  marca      text not null check (char_length(btrim(marca)) between 1 and 60),
  modelo     text not null check (char_length(btrim(modelo)) between 1 and 60),
  ano        integer check (ano between 1950 and 2100),
  km         integer check (km between 0 and 3000000),
  comuna     text not null default '' check (char_length(comuna) <= 80),
  precio     bigint check (precio between 0 and 100000000000),
  fotos      text[] not null default '{}' check (cardinality(fotos) <= 4),
  nfotos     smallint not null default 0 check (nfotos between 0 and 10),
  estado     text not null default 'nueva' check (estado in ('nueva', 'contactado', 'cerrado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.requests.fotos is 'Rutas dentro del bucket privado request-photos (máx. 4)';

create index requests_created on public.requests (created_at desc);
create index requests_estado on public.requests (estado, created_at desc);

-- Validación del lado del servidor para inserciones públicas:
-- fecha y estado los fija el servidor, y las fotos deben estar en la
-- carpeta de esta solicitud.
create or replace function public.requests_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare p text;
begin
  new.created_at := now();
  new.updated_at := now();
  if not public.is_admin() then
    new.estado := 'nueva';
  end if;
  foreach p in array coalesce(new.fotos, '{}') loop
    if p !~ ('^' || new.id::text || '/[0-9]+\.(jpg|jpeg|png|webp)$') then
      raise exception 'Ruta de foto no válida' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

create trigger requests_validate before insert on public.requests
  for each row execute function public.requests_before_insert();

create trigger requests_touch before update on public.requests
  for each row execute function public.touch_updated_at();

alter table public.requests enable row level security;

create policy "requests: cualquiera puede enviar una solicitud"
  on public.requests for insert
  to anon, authenticated
  with check (estado = 'nueva');

create policy "requests: solo admin lee"
  on public.requests for select
  to authenticated
  using ((select public.is_admin()));

create policy "requests: solo admin edita"
  on public.requests for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "requests: solo admin elimina"
  on public.requests for delete
  to authenticated
  using ((select public.is_admin()));

-- Permisos de tabla explícitos (las políticas RLS filtran encima de esto)
revoke all on public.admins, public.cars, public.requests from anon, authenticated;
grant select on public.admins to authenticated;
grant select on public.cars to anon, authenticated;
grant insert, update, delete on public.cars to authenticated;
grant insert on public.requests to anon, authenticated;
grant select, update, delete on public.requests to authenticated;

-- ---------------------------------------------------------------------
-- 4. Storage
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('car-photos',     'car-photos',     true,  5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('request-photos', 'request-photos', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- car-photos: lectura pública por URL (bucket público); escritura solo admin
create policy "car-photos: admin lista"
  on storage.objects for select to authenticated
  using (bucket_id = 'car-photos' and (select public.is_admin()));

create policy "car-photos: admin sube"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'car-photos' and (select public.is_admin()));

create policy "car-photos: admin actualiza"
  on storage.objects for update to authenticated
  using (bucket_id = 'car-photos' and (select public.is_admin()));

create policy "car-photos: admin elimina"
  on storage.objects for delete to authenticated
  using (bucket_id = 'car-photos' and (select public.is_admin()));

-- request-photos: el público solo puede SUBIR (no ver, reemplazar ni borrar),
-- dentro de una carpeta con forma de UUID y con nombre 0.jpg, 1.jpg, ...
create policy "request-photos: público sube"
  on storage.objects for insert to anon, authenticated
  with check (
    bucket_id = 'request-photos'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(jpg|jpeg|png|webp)$'
  );

create policy "request-photos: admin ve"
  on storage.objects for select to authenticated
  using (bucket_id = 'request-photos' and (select public.is_admin()));

create policy "request-photos: admin elimina"
  on storage.objects for delete to authenticated
  using (bucket_id = 'request-photos' and (select public.is_admin()));
