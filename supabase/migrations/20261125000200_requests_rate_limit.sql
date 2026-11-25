-- Anti-spam del formulario público: límites aplicados en el servidor.
--  * máx. 30 solicitudes por hora en total
--  * máx. 3 solicitudes por día desde el mismo WhatsApp
-- La cuenta se hace con SECURITY DEFINER porque los visitantes no pueden leer requests.
create or replace function private.requests_rate_ok(p_whatsapp text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.requests where created_at > now() - interval '1 hour') < 30
     and (coalesce(regexp_replace(p_whatsapp, '\D', '', 'g'), '') = ''
          or (select count(*) from public.requests
               where created_at > now() - interval '1 day'
                 and regexp_replace(whatsapp, '\D', '', 'g') = regexp_replace(p_whatsapp, '\D', '', 'g')) < 3);
$$;

revoke all on function private.requests_rate_ok(text) from public;
grant execute on function private.requests_rate_ok(text) to anon, authenticated;

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
    if not private.requests_rate_ok(new.whatsapp) then
      raise exception 'Demasiadas solicitudes en poco tiempo. Escríbenos directo por WhatsApp.' using errcode = 'P0001';
    end if;
  end if;
  foreach p in array coalesce(new.fotos, '{}') loop
    if p !~ ('^' || new.id::text || '/[0-9]+\.(jpg|jpeg|png|webp)$') then
      raise exception 'Ruta de foto no válida' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
