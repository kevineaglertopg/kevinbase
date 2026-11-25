-- Mueve is_admin() fuera del esquema expuesto por la API (las políticas la siguen por OID).
-- Corrige el aviso del Security Advisor "SECURITY DEFINER function executable by anon".
create schema if not exists private;
grant usage on schema private to anon, authenticated;
alter function public.is_admin() set schema private;

create or replace function public.set_car_order(ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  update public.cars c
     set sort_order = array_position(ids, c.id) - 1
   where c.id = any (ids);
end;
$$;

create or replace function public.requests_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare p text;
begin
  new.created_at := now();
  new.updated_at := now();
  if not private.is_admin() then
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
