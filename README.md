# Automotora Aguilar · Vercel + Supabase

Sitio público y panel de administración de Automotora Aguilar (Bulnes, Ñuble).
Mismo diseño y funciones del sitio original; ahora con datos reales en **Supabase**
(base de datos, autenticación y fotos) y listo para publicar en **Vercel**.

## Qué hace

| Parte | Antes | Ahora |
|---|---|---|
| Catálogo de autos | Fijo en el código o en `localStorage` | Tabla `cars` en Supabase; fotos en Storage (`car-photos`) |
| Panel `#admin` | Contraseña `demo1234` en el navegador | Login real con Supabase Auth; solo usuarios de la tabla `admins` |
| Formulario "Vende tu auto" | Se guardaba solo en el navegador; errores silenciados | Tabla `requests` + fotos privadas (`request-photos`); mensaje claro de éxito/error |
| Contraseña olvidada | — | Correo con enlace → pantalla "Nueva contraseña" |
| Fotos | Base64 dentro del HTML (1 MB por visita) | Archivos en `img/` y Storage (HTML de 170 KB) |

Si abres `index.html` directamente sin compilar, funciona en **modo demo** (igual que antes).

## Estructura

```
index.html                  Sitio + panel (HTML/CSS/JS, sin framework)
img/                        Fotos de los autos de ejemplo
scripts/build.mjs           Genera dist/ y dist/config.js desde variables de entorno
supabase/migrations/*.sql   Tablas, índices, restricciones, RLS y Storage
supabase/config.jsonc       Configuración para Supabase local (pruebas)
tests/e2e.mjs               49 pruebas: seguridad (RLS) + recorrido en navegador
vercel.json                 Build, carpeta de salida y cabeceras de seguridad
.env.example                Variables necesarias
```

## En producción

- **Sitio:** https://automotora-aguilar-kevintopg.vercel.app (panel en `/#admin`)
- **Vercel:** proyecto `automotora-aguilar`, conectado a este repositorio. Cada push a `main` se publica automáticamente.
- **Supabase:** proyecto `automotoraaguilar`. Las migraciones de `supabase/migrations/` ya están aplicadas.
  Para un cambio de base de datos nuevo, agrega una migración aquí y aplícala en Supabase antes de publicar el código que la usa.

## Seguridad

- **RLS activado en todas las tablas.** Visitantes: ven solo autos no ocultos y pueden *crear* solicitudes (no leerlas, editarlas ni borrarlas).
  Solo los administradores (tabla `admins`) pueden editar autos y ver o gestionar solicitudes.
- Nadie puede volverse admin desde el navegador: la tabla `admins` no tiene políticas de escritura.
- El servidor valida los datos con restricciones (largos, rangos de año, km y precio, valores permitidos) y un trigger
  fuerza `estado = 'nueva'` y la fecha en solicitudes públicas.
- Fotos de solicitudes en bucket **privado** (solo el admin las ve, con enlaces temporales). Solo se permiten imágenes de 3 MB como máximo.
- En el navegador solo va la clave **pública** (anon/publishable). El build **se detiene** si por error pones la `service_role` o una clave `sb_secret_…`.

---

## Paso a paso para publicar

### 1. Crear el proyecto en Supabase

1. Entra a <https://supabase.com/dashboard> → **New project**. Región sugerida: **South America (São Paulo)**.
2. Ve a **SQL Editor** → **New query**, pega **todo** el contenido de
   `supabase/migrations/20261125000000_init.sql` y pulsa **Run**. Debe terminar sin errores.
   *(Alternativa con la CLI: `npx supabase login`, `npx supabase link --project-ref TU_REF` y `npx supabase db push`.)*
3. Ve a **Authentication → Sign In / Providers**:
   - Desactiva **Allow new users to sign up** (solo tú creas cuentas de admin).
   - En **Email**, sube **Minimum password length** a 8.
4. Ve a **Authentication → Users → Add user → Create new user**: tu correo y una contraseña segura,
   con **Auto Confirm User** marcado.
5. Vuelve al **SQL Editor** y convierte ese usuario en administrador (cambia el correo):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'TU_CORREO@gmail.com';
   ```
6. Ve a **Project Settings → API** (o **API Keys**) y copia:
   - **Project URL** → será `SUPABASE_URL`
   - **anon public** o **publishable** key → será `SUPABASE_ANON_KEY`
   - ⚠️ **No** copies la `service_role` / secret key: no se necesita en ningún lado.

### 2. Subir el código a GitHub

Crea un repositorio (puede ser privado) y sube esta carpeta. `node_modules/` y `dist/` están en `.gitignore`.

### 3. Publicar en Vercel

1. <https://vercel.com/new> → importa el repositorio.
2. **Framework Preset:** *Other*. No cambies los comandos: `vercel.json` ya define
   `npm ci --omit=dev`, `npm run build` y la carpeta `dist`.
3. En **Environment Variables** agrega, para *Production* y *Preview*:
   - `SUPABASE_URL` = la Project URL
   - `SUPABASE_ANON_KEY` = la clave anon/publishable
   - `ADMIN_EMAIL` (opcional) = aparece pre-escrito en el login. Queda visible públicamente.
4. **Deploy.** Si falta una variable, el build falla con un mensaje que dice cuál.

> También funciona la integración oficial *Supabase ↔ Vercel* (Vercel → Integrations → Supabase):
> el build acepta `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### 4. Conectar el dominio de Vercel con Supabase (necesario para recuperar contraseña)

En Supabase → **Authentication → URL Configuration**:
- **Site URL:** `https://TU-SITIO.vercel.app` (o tu dominio propio)
- **Redirect URLs:** agrega `https://TU-SITIO.vercel.app/` y, si usarás vistas previas, `https://*-TU-USUARIO.vercel.app/**`

### 5. Primer uso

1. Abre `https://TU-SITIO.vercel.app/#admin` (o el botón **Ingresar**) e inicia sesión.
2. En **Autos**, pulsa **Cargar los autos de ejemplo**: sube las 9 fotos a Storage y crea los autos en la base.
   Después edita precios, años y kilometraje, o agrega autos nuevos.
3. Envía una solicitud de prueba desde "Vende tu auto" y revísala en **Solicitudes**.

### Recomendado antes de recibir mucho tráfico

- **Correo propio (SMTP):** el correo incluido en Supabase tiene un límite muy bajo de envíos por hora y es solo para pruebas.
  Configura uno en **Authentication → Emails → SMTP Settings** (por ejemplo Resend, Brevo o tu proveedor).
- **Anti-spam del formulario:** el formulario es público por diseño. Si recibes spam, se puede agregar
  CAPTCHA (Cloudflare Turnstile, compatible con Supabase).
- **Respaldos:** el plan gratuito no incluye restauración a un punto en el tiempo. Usa
  **Ajustes → Descargar respaldo** periódicamente.
- El plan gratuito de Supabase **pausa proyectos inactivos** por una semana; las visitas al sitio cuentan como actividad.

---

## Desarrollo y pruebas locales

Requisitos: Node 20+ y Docker.

```bash
npm install
```

```bash
npx supabase start
```

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon key que muestra supabase status> npm run build
```

```bash
npm test
```

`npm test` levanta el sitio en `http://127.0.0.1:3000`, crea usuarios de prueba **solo en el Supabase local** y verifica:
políticas RLS y Storage para visitante, usuario sin permisos y admin; login y logout; rechazo de cuentas sin permisos;
CRUD de autos con fotos; orden; formulario con fotos; gestión de solicitudes; persistencia de sesión y
recuperación de contraseña por correo (Mailpit local).
