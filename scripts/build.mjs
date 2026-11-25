// Compila el sitio estático en dist/ para Vercel.
//  - Copia index.html e img/
//  - Copia el cliente oficial de Supabase (versión fijada en package-lock.json) a dist/vendor/
//  - Genera dist/config.js con la URL y la clave PÚBLICA de Supabase desde variables de entorno
// Falla si faltan las variables o si alguien puso por error una clave secreta.
import {cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const env = process.env;

// Carga .env.local / .env si existen (solo para compilar en tu computador; Vercel usa sus propias variables)
for (const f of [".env.local", ".env"]) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const pick = (...names) => names.map(n => env[n]).find(v => v && v.trim())?.trim() || "";
const url = pick("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const key = pick("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const adminEmail = pick("ADMIN_EMAIL");
const demo = env.DEMO_BUILD === "1";

const fail = msg => { console.error("\n✖ " + msg + "\n"); process.exit(1); };

if (!demo) {
  if (!url || !key) fail("Faltan las variables SUPABASE_URL y/o SUPABASE_ANON_KEY. Configúralas en Vercel (Settings → Environment Variables) o en .env.local. Para compilar en modo demo usa DEMO_BUILD=1.");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url))
    fail(`SUPABASE_URL no parece válida: "${url}". Debe ser https://<tu-proyecto>.supabase.co`);
  // Seguridad: nunca publicar la clave secreta / service_role
  if (/^sb_secret_/.test(key)) fail("SUPABASE_ANON_KEY contiene una clave SECRETA (sb_secret_…). Usa la clave publishable/anon.");
  if (key.split(".").length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
      if (payload.role !== "anon") fail(`La clave tiene rol "${payload.role}". Solo se permite la clave anon/publishable en el navegador.`);
    } catch { fail("SUPABASE_ANON_KEY no tiene un formato válido."); }
  } else if (!/^sb_publishable_/.test(key)) fail("SUPABASE_ANON_KEY no tiene un formato reconocido (anon JWT o sb_publishable_…).");
} else {
  console.warn("⚠ DEMO_BUILD=1: se compila sin Supabase (los datos quedan solo en el navegador).");
}

rmSync(out, {recursive: true, force: true});
mkdirSync(join(out, "vendor"), {recursive: true});
cpSync(join(root, "index.html"), join(out, "index.html"));
cpSync(join(root, "img"), join(out, "img"), {recursive: true});

const require = createRequire(import.meta.url);
const sbPkg = dirname(require.resolve("@supabase/supabase-js/package.json"));
cpSync(join(sbPkg, "dist/umd/supabase.js"), join(out, "vendor/supabase.js"));

const cfg = demo ? {} : {supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: key, adminEmail};
writeFileSync(join(out, "config.js"), `/* generado por scripts/build.mjs, no editar */\nwindow.APP_CONFIG = ${JSON.stringify(cfg)};\n`);

const sbVersion = JSON.parse(readFileSync(join(sbPkg, "package.json"), "utf8")).version;
console.log(`✓ dist/ listo · supabase-js ${sbVersion} · ${demo ? "modo demo" : "Supabase: " + url}`);
