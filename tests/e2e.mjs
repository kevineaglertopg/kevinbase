// Pruebas de integración contra un Supabase LOCAL (npx supabase start).
// 1) Políticas RLS y Storage, directamente contra la API, con 3 actores:
//    visitante anónimo, usuario autenticado SIN permisos y administrador.
// 2) Recorrido completo en navegador (Playwright) sobre dist/.
// Uso:  npx supabase start && npm run test
// Nunca ejecutar contra producción: crea y borra usuarios y datos.
import {execSync} from "node:child_process";
import {createServer} from "node:http";
import {readFileSync, existsSync, statSync} from "node:fs";
import {join, extname, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {createClient} from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const st = JSON.parse(execSync("npx supabase status -o json", {cwd: root, stdio: ["ignore", "pipe", "ignore"]}).toString());
if (!/127\.0\.0\.1|localhost/.test(st.API_URL)) throw new Error("Las pruebas solo corren contra Supabase local");
const URL_ = st.API_URL, ANON = st.ANON_KEY, SERVICE = st.SERVICE_ROLE_KEY, MAIL = st.MAILPIT_URL || "http://127.0.0.1:54324";

let pass = 0, failN = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { failN++; console.log("  ✖ " + name + "\n      " + (e && e.message)); } };
const assert = (c, m) => { if (!c) throw new Error(m || "assert"); };
const denied = r => assert(r.error || (Array.isArray(r.data) && r.data.length === 0) || r.data == null, "debió ser rechazado: " + JSON.stringify(r.data).slice(0, 120));

const svc = createClient(URL_, SERVICE, {auth: {persistSession: false}});
const anon = () => createClient(URL_, ANON, {auth: {persistSession: false}});
const sql = q => execSync(`psql "${st.DB_URL}" -v ON_ERROR_STOP=1 -tAc ${JSON.stringify(q)}`).toString().trim();

// ---------- preparación ----------
console.log("Preparando datos de prueba…");
sql("truncate public.cars, public.requests, public.admins cascade");
await svc.storage.from("car-photos").list("", {limit: 1000}).then(async ({data}) => { for (const d of data || []) { const {data: f} = await svc.storage.from("car-photos").list(d.name); if (f?.length) await svc.storage.from("car-photos").remove(f.map(x => d.name + "/" + x.name)); } });
const {data: users} = await svc.auth.admin.listUsers();
for (const u of users.users) await svc.auth.admin.deleteUser(u.id);
const ADMIN = {email: "admin@prueba.local", password: "Admin-12345"}, OTHER = {email: "otro@prueba.local", password: "Otro-12345"};
const a = await svc.auth.admin.createUser({...ADMIN, email_confirm: true});
await svc.auth.admin.createUser({...OTHER, email_confirm: true});
sql(`insert into public.admins (user_id) values ('${a.data.user.id}')`);
const login = async u => { const c = anon(); const r = await c.auth.signInWithPassword(u); if (r.error) throw r.error; return c; };
const adm = await login(ADMIN), oth = await login(OTHER), pub = anon();
const jpg = new Blob([readFileSync(join(root, "img/auto-1.jpg"))], {type: "image/jpeg"});

// ---------- 1. RLS ----------
console.log("\n1) Políticas de seguridad (RLS + Storage)");
let carId, hiddenId;
await t("admin sube foto a car-photos", async () => { const r = await adm.storage.from("car-photos").upload("t/1.jpg", jpg, {contentType: "image/jpeg"}); assert(!r.error, r.error?.message); });
await t("admin crea autos (visible y oculto)", async () => {
  const r = await adm.from("cars").insert([{name: "Prueba Visible", image_path: "t/1.jpg", hidden: false, sort_order: 0}, {name: "Prueba Oculto", image_path: "t/1.jpg", hidden: true, sort_order: 1}]).select();
  assert(!r.error, r.error?.message); carId = r.data[0].id; hiddenId = r.data[1].id;
});
await t("visitante ve solo autos visibles", async () => { const r = await pub.from("cars").select("id"); assert(!r.error && r.data.length === 1 && r.data[0].id === carId, JSON.stringify(r)); });
await t("visitante NO puede crear autos", async () => denied(await pub.from("cars").insert({name: "x", image_path: "x"}).select()));
await t("visitante NO puede editar autos", async () => denied(await pub.from("cars").update({price: 1}).eq("id", carId).select()));
await t("visitante NO puede borrar autos", async () => { await pub.from("cars").delete().eq("id", carId); assert(sql(`select count(*) from cars where id='${carId}'`) === "1"); });
await t("usuario sin permisos NO ve autos ocultos ni puede editar", async () => {
  const r = await oth.from("cars").select("id"); assert(r.data.length === 1);
  denied(await oth.from("cars").update({price: 1}).eq("id", carId).select());
});
await t("usuario sin permisos NO puede hacerse admin", async () => { const me = (await oth.auth.getUser()).data.user.id; const r = await oth.from("admins").insert({user_id: me}); assert(r.error, "debió fallar"); });
await t("visitante NO puede reordenar (RPC)", async () => assert((await pub.rpc("set_car_order", {ids: [carId]})).error));
await t("usuario sin permisos NO puede reordenar (RPC)", async () => assert((await oth.rpc("set_car_order", {ids: [carId]})).error));
await t("admin reordena (RPC)", async () => { const r = await adm.rpc("set_car_order", {ids: [hiddenId, carId]}); assert(!r.error, r.error?.message); assert(sql(`select sort_order from cars where id='${carId}'`) === "1"); });
await t("solo un auto Recomendado", async () => {
  assert(!(await adm.from("cars").update({recommended: true}).eq("id", carId)).error);
  assert((await adm.from("cars").update({recommended: true}).eq("id", hiddenId)).error?.code === "23505");
});
await t("restricciones de datos (año inválido)", async () => assert((await adm.from("cars").update({year: 1800}).eq("id", carId)).error?.code === "23514"));
await t("visitante NO puede subir a car-photos", async () => assert((await pub.storage.from("car-photos").upload("hack/1.jpg", jpg, {contentType: "image/jpeg"})).error));
await t("usuario sin permisos NO puede subir a car-photos", async () => assert((await oth.storage.from("car-photos").upload("hack/2.jpg", jpg, {contentType: "image/jpeg"})).error));

const rid = crypto.randomUUID();
await t("visitante sube foto de solicitud en su carpeta", async () => { const r = await pub.storage.from("request-photos").upload(`${rid}/0.jpg`, jpg, {contentType: "image/jpeg"}); assert(!r.error, r.error?.message); });
await t("visitante NO puede subir fuera de patrón ni sobrescribir", async () => {
  assert((await pub.storage.from("request-photos").upload(`otra/0.jpg`, jpg, {contentType: "image/jpeg"})).error);
  assert((await pub.storage.from("request-photos").upload(`${rid}/0.jpg`, jpg, {contentType: "image/jpeg", upsert: true})).error);
});
await t("visitante NO puede subir archivos que no son imagen", async () => assert((await pub.storage.from("request-photos").upload(`${crypto.randomUUID()}/1.jpg`, new Blob(["<script>"], {type: "text/html"}), {contentType: "text/html"})).error));
await t("visitante crea solicitud", async () => {
  const r = await pub.from("requests").insert({id: rid, servicio: "Quiero vender mi auto", nombre: "Cliente Prueba", marca: "Mazda", modelo: "6", fotos: [`${rid}/0.jpg`]});
  assert(!r.error, r.error?.message);
});
await t("visitante NO puede fijar estado (el servidor lo fuerza a 'nueva') ni rutas de foto ajenas", async () => {
  assert(!(await pub.from("requests").insert({servicio: "Quiero vender mi auto", nombre: "Intento", marca: "x", modelo: "x", estado: "cerrado"})).error);
  assert(sql("select estado from requests where nombre='Intento'") === "nueva", "estado no forzado");
  assert((await pub.from("requests").insert({servicio: "Quiero vender mi auto", nombre: "x", marca: "x", modelo: "x", fotos: [`${rid}/0.jpg`]})).error);
});
await t("límite anti-spam: máx. 3 solicitudes por día del mismo WhatsApp", async () => {
  const row = n => ({servicio: "Quiero vender mi auto", nombre: "Spam " + n, marca: "x", modelo: "x", whatsapp: "+56 9 5555 0000"});
  for (let n = 0; n < 3; n++) assert(!(await pub.from("requests").insert(row(n))).error, "la " + n + " debió pasar");
  const r = await pub.from("requests").insert(row(9)); assert(r.error && /Demasiadas/.test(r.error.message), JSON.stringify(r.error));
  sql("delete from requests where nombre like 'Spam %'");
});
await t("servicio inválido rechazado", async () => assert((await pub.from("requests").insert({servicio: "otra cosa", nombre: "x", marca: "x", modelo: "x"})).error));
await t("visitante NO puede leer solicitudes", async () => denied(await pub.from("requests").select("*")));
await t("usuario sin permisos NO puede leer/editar/borrar solicitudes", async () => {
  denied(await oth.from("requests").select("*"));
  denied(await oth.from("requests").update({estado: "cerrado"}).eq("id", rid).select());
  await oth.from("requests").delete().eq("id", rid); assert(sql(`select count(*) from requests where id='${rid}'`) === "1");
});
await t("visitante y usuario sin permisos NO pueden ver fotos de solicitudes", async () => {
  assert((await pub.storage.from("request-photos").download(`${rid}/0.jpg`)).error);
  assert((await oth.storage.from("request-photos").createSignedUrl(`${rid}/0.jpg`, 60)).error);
});
await t("admin lee solicitud, ve su foto y cambia estado", async () => {
  const r = await adm.from("requests").select("*").eq("id", rid).single(); assert(!r.error && r.data.estado === "nueva");
  assert(!(await adm.storage.from("request-photos").createSignedUrl(`${rid}/0.jpg`, 60)).error);
  assert(!(await adm.from("requests").update({estado: "contactado"}).eq("id", rid)).error);
});
await t("estado inválido rechazado", async () => assert((await adm.from("requests").update({estado: "xx"}).eq("id", rid)).error));

// limpieza de la fase 1
sql("truncate public.cars, public.requests cascade");
await svc.storage.from("car-photos").remove(["t/1.jpg"]);
await svc.storage.from("request-photos").remove([`${rid}/0.jpg`]);

// ---------- 2. Navegador ----------
console.log("\n2) Recorrido en navegador (dist/)");
const dist = join(root, "dist");
assert(existsSync(join(dist, "config.js")), "Compila primero con las variables locales");
const MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json"};
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {"content-type": MIME[extname(f)] || "application/octet-stream"}); res.end(readFileSync(f));
}).listen(3000, "127.0.0.1");
const SITE = "http://127.0.0.1:3000/";

const {chromium} = require("playwright");
const browser = await chromium.launch();
const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
const page = await ctx.newPage();
const jsErrors = [];
page.on("pageerror", e => jsErrors.push(e.message));
page.on("dialog", d => d.accept());
const toast = async re => { await page.waitForFunction(r => new RegExp(r).test(document.querySelector("#admToast").textContent) && document.querySelector("#admToast").classList.contains("show"), re, {timeout: 10000}); return true; };
const until = async (q, want) => { let v; for (let i = 0; i < 40; i++) { v = sql(q); if (v === want) return true; await new Promise(r => setTimeout(r, 250)); } throw new Error(`${q} → ${v} (esperaba ${want})`); };

await t("sitio carga los autos de ejemplo cuando la base está vacía", async () => {
  await page.goto(SITE); await page.waitForSelector("#cars .car");
  assert(await page.locator("#cars .car").count() === 9);
});
await t("login con contraseña incorrecta muestra error claro", async () => {
  await page.goto(SITE + "#admin"); await page.fill("#aEm", ADMIN.email); await page.fill("#aPw", "mala-clave");
  await page.click("#aLogin button[type=submit]"); await page.waitForFunction(() => document.querySelector("#aErr").textContent.length > 0);
  assert((await page.textContent("#aErr")).includes("Correo o contraseña incorrectos"));
});
await t("cuenta sin permisos de admin es rechazada", async () => {
  await page.fill("#aEm", OTHER.email); await page.fill("#aPw", OTHER.password); await page.click("#aLogin button[type=submit]");
  await page.waitForFunction(() => /permisos/.test(document.querySelector("#aErr").textContent));
  assert(await page.locator("#aLogin").count() === 1);
});
await t("login de admin funciona", async () => {
  await page.fill("#aEm", ADMIN.email); await page.fill("#aPw", ADMIN.password); await page.click("#aLogin button[type=submit]");
  await page.waitForSelector(".a-tabs"); assert((await page.textContent(".a-brand small")).includes("conectado"));
});
await t("cargar autos de ejemplo los sube a Storage y la base", async () => {
  await page.click("#aSeed"); await page.waitForFunction(() => document.querySelectorAll(".arow").length === 9, null, {timeout: 30000});
  assert(sql("select count(*) from cars") === "9"); assert(sql("select count(*) from storage.objects where bucket_id='car-photos'") === "9");
  assert(sql("select count(*) from cars where recommended") === "1");
});
await t("editar precio se guarda en la base", async () => {
  const inp = page.locator(".arow").first().locator("[data-price]"); await inp.fill("12500000"); await inp.press("Enter");
  await toast("Precio guardado"); await until("select price from cars order by sort_order limit 1", "12500000");
});
await t("ocultar un auto se guarda", async () => {
  await page.locator(".arow").nth(1).locator('[data-a="hide"]').click(); await page.waitForSelector(".arow.hid");
  assert(sql("select count(*) from cars where hidden") === "1");
});
await t("reordenar con flechas se guarda", async () => {
  const before = sql("select name from cars order by sort_order limit 1");
  await page.locator(".arow").first().locator('[data-a="down"]').click(); await toast("Orden guardado");
  await until("select name from cars where sort_order=1", before);
});
await t("agregar auto nuevo con foto (Storage)", async () => {
  await page.click("#aAdd"); await page.setInputFiles("#eFile", join(root, "img/auto-2.jpg"));
  await page.waitForFunction(() => document.querySelector("#eImg").src.startsWith("data:"));
  await page.fill("#eName", "Toyota Prueba"); await page.fill("#eYear", "2018"); await page.fill("#eKm", "45000"); await page.fill("#ePrice", "9990000");
  await page.click(".a-form button[type=submit]"); await toast("Auto agregado");
  assert(sql("select year||'-'||km||'-'||price from cars where name='Toyota Prueba'") === "2018-45000-9990000");
});
await t("editar foto reemplaza el archivo anterior en Storage", async () => {
  const oldPath = sql("select image_path from cars where name='Toyota Prueba'");
  await page.locator(".arow", {hasText: "Toyota Prueba"}).locator('[data-a="edit"]').click();
  await page.setInputFiles("#eFile", join(root, "img/auto-3.jpg")); await page.waitForFunction(() => document.querySelector("#eImg").src.startsWith("data:"));
  await page.click(".a-form button[type=submit]"); await toast("Cambios guardados");
  const newPath = sql("select image_path from cars where name='Toyota Prueba'");
  assert(newPath !== oldPath && sql(`select count(*) from storage.objects where name='${oldPath}'`) === "0");
});
await t("eliminar auto borra fila y foto", async () => {
  const path = sql("select image_path from cars where name='Toyota Prueba'");
  await page.locator(".arow", {hasText: "Toyota Prueba"}).locator('[data-a="del"]').click(); await toast("Auto eliminado");
  assert(sql("select count(*) from cars where name='Toyota Prueba'") === "0" && sql(`select count(*) from storage.objects where name='${path}'`) === "0");
});
await t("cerrar sesión", async () => { await page.click("#aOut"); await page.waitForSelector("#aLogin"); });

// sitio público con datos reales
const visitor = await (await browser.newContext()).newPage();
visitor.on("pageerror", e => jsErrors.push(e.message));
await visitor.context().route(/wa\.me|whatsapp\.com/, r => r.fulfill({status: 200, contentType: "text/html", body: "<p>WhatsApp (simulado en la prueba)</p>"}));
await t("sitio público muestra los autos desde Supabase (sin el oculto)", async () => {
  await visitor.goto(SITE); await visitor.waitForSelector("#cars .car");
  assert(await visitor.locator("#cars .car").count() === 8, "esperaba 8");
  const src = await visitor.locator("#cars .car img").first().getAttribute("src"); assert(src.includes("/storage/v1/object/public/car-photos/"), src);
  assert((await visitor.textContent("#cars")).includes("12.500.000") || (await visitor.textContent("body")).includes("12.500.000"));
});
await t("formulario: validación de datos faltantes", async () => {
  await visitor.click("#waSend"); assert((await visitor.textContent("#formNote")).includes("Faltan datos"));
});
await t("formulario: año inválido es rechazado en el navegador", async () => {
  await visitor.fill("#f-nom", "Ana Pérez"); await visitor.fill("#f-marca", "Kia"); await visitor.fill("#f-mod", "Rio"); await visitor.fill("#f-ano", "20");
  await visitor.click("#waSend"); assert((await visitor.textContent("#formNote")).includes("año"));
});
await t("formulario: solicitud con foto se guarda en Supabase", async () => {
  await visitor.fill("#f-ano", "2016"); await visitor.fill("#f-wsp", "+56 9 1234 5678"); await visitor.fill("#f-km", "80000"); await visitor.fill("#f-pre", "6500000");
  await visitor.setInputFiles("#f-fotos", [join(root, "img/auto-4.jpg")]);
  const [wa] = await Promise.all([visitor.context().waitForEvent("page"), visitor.click("#waSend")]);
  assert(wa.url().includes("wa.me") || wa.url().includes("whatsapp"), wa.url()); await wa.close();
  await visitor.waitForFunction(() => /registrada|No pudimos/.test(document.querySelector("#formNote").textContent), null, {timeout: 15000});
  assert((await visitor.textContent("#formNote")).includes("registrada"), await visitor.textContent("#formNote"));
  assert(sql("select nombre||'|'||ano||'|'||km||'|'||precio||'|'||cardinality(fotos) from requests") === "Ana Pérez|2016|80000|6500000|1");
});
await t("formulario: bots que llenan el campo trampa no guardan nada", async () => {
  const bot = await (await browser.newContext()).newPage();
  await bot.context().route(/wa\.me|whatsapp\.com/, r => r.fulfill({status: 200, contentType: "text/html", body: "ok"}));
  await bot.goto(SITE); await bot.fill("#f-nom", "Bot"); await bot.fill("#f-marca", "x"); await bot.fill("#f-mod", "x");
  await bot.evaluate(() => { document.querySelector("#f-web").value = "http://spam"; });
  const [wa] = await Promise.all([bot.context().waitForEvent("page"), bot.click("#waSend")]); await wa.close();
  await bot.waitForTimeout(1500); assert(sql("select count(*) from requests where nombre='Bot'") === "0"); await bot.close();
});
await t("formulario: doble clic no duplica la solicitud", async () => {
  const [wa] = await Promise.all([visitor.context().waitForEvent("page"), visitor.click("#waSend")]); await wa.close();
  await visitor.waitForTimeout(800); assert(sql("select count(*) from requests") === "1");
});

await t("admin ve la solicitud con su foto privada y cambia el estado", async () => {
  await page.fill("#aEm", ADMIN.email); await page.fill("#aPw", ADMIN.password); await page.click("#aLogin button[type=submit]");
  await page.waitForSelector(".a-tabs"); await page.click('[data-t="sol"]'); await page.waitForSelector(".rq");
  assert((await page.textContent(".rq")).includes("Ana Pérez"));
  const img = page.locator(".rq-ph img").first(); await img.waitFor();
  assert(await img.evaluate(i => i.complete && i.naturalWidth > 0 || new Promise(r => { i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); })), "la foto firmada no cargó");
  await page.selectOption(".rq select", "contactado"); await toast("Estado guardado");
  assert(sql("select estado from requests") === "contactado");
});
await t("admin elimina la solicitud y sus fotos", async () => {
  await page.click(".rq [data-del]"); await page.waitForSelector(".rq", {state: "detached"});
  assert(sql("select count(*) from requests") === "0" && sql("select count(*) from storage.objects where bucket_id='request-photos'") === "0");
});
await t("la sesión persiste al recargar", async () => { await page.reload(); await page.waitForSelector(".a-tabs"); });
await t("pestaña Ajustes muestra Supabase conectado", async () => { await page.click('[data-t="aj"]'); assert((await page.textContent("#aMain")).includes("Supabase conectado")); });

// recuperación de contraseña con el correo real (Mailpit local)
await t("recuperación de contraseña por correo", async () => {
  await page.click("#aOut"); await page.waitForSelector("#aLogin");
  await fetch(MAIL + "/api/v1/messages", {method: "DELETE"});
  await page.fill("#aEm", ADMIN.email); await page.click("#aForgot");
  await page.waitForFunction(() => /te enviamos/.test(document.querySelector("#aErr").textContent), null, {timeout: 10000});
  let msg; for (let i = 0; i < 20 && !msg; i++) { const l = await (await fetch(MAIL + "/api/v1/messages")).json(); msg = l.messages?.[0]; if (!msg) await page.waitForTimeout(500); }
  assert(msg, "no llegó el correo");
  const body = await (await fetch(MAIL + "/api/v1/message/" + msg.ID)).json();
  const link = (body.HTML || body.Text).match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") || (body.Text.match(/https?:\/\/\S+/) || [])[0];
  assert(link, "sin enlace"); await page.goto(link);
  await page.waitForSelector("#aNew", {timeout: 15000});
  await page.fill("#aP1", "Nueva-12345"); await page.fill("#aP2", "Nueva-12345"); await page.click("#aNew button[type=submit]");
  await page.waitForSelector(".a-tabs");
  assert(!(await anon().auth.signInWithPassword({email: ADMIN.email, password: "Nueva-12345"})).error, "la nueva contraseña no funciona");
});
await t("sin errores de JavaScript en las páginas", async () => assert(!jsErrors.length, jsErrors.join(" | ")));

await browser.close(); server.close();
console.log(`\n${pass} pruebas OK, ${failN} fallidas`);
process.exit(failN ? 1 : 0);
