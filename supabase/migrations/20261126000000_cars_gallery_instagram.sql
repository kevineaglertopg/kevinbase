-- Galería de fotos por auto (además de la portada) y link al post de Instagram.
alter table public.cars
  add column gallery text[] not null default '{}'
    check (cardinality(gallery) <= 9),
  add column instagram_url text
    check (instagram_url is null or (char_length(instagram_url) <= 300 and instagram_url ~ '^https://(www\.)?instagram\.com/[A-Za-z0-9_./?=&%-]+$'));

comment on column public.cars.gallery is 'Fotos adicionales (rutas en el bucket car-photos), en el orden del carrusel. Máx. 9; la portada es image_path.';
comment on column public.cars.instagram_url is 'Link al post de Instagram del auto (opcional).';
