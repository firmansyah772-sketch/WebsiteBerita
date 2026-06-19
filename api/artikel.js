// api/artikel.js — Vercel Serverless Function
// Membaca artikel-app.html LANGSUNG dari disk (bukan lewat HTTP),
// lalu menyuntikkan judul/gambar/deskripsi ke meta tag sebelum
// dikirim ke browser/bot WhatsApp/Facebook/Telegram.

const fs   = require("fs");
const path = require("path");

const FIREBASE_PROJECT_ID = "webberita-8af66";
const FIREBASE_API_KEY    = "AIzaSyCCOOmXPfLhbDdSoil1UHfld5731689HVw";
const DEFAULT_IMAGE       = "https://res.cloudinary.com/dc7guxgnm/image/upload/q_auto/f_auto/v1780978628/1000305972_ynq9xo.png";

// ─── Helper: escape HTML entities ────────────────────────────────────────────
function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── Helper: ganti content="..." pada <meta id="ID" ...> ─────────────────────
function setMetaContent(html, id, value) {
  const marker    = `id="${id}" content="`;
  const start     = html.indexOf(marker);
  if (start === -1) return html;
  const valStart  = start + marker.length;
  const valEnd    = html.indexOf('"', valStart);
  if (valEnd === -1) return html;
  return html.slice(0, valStart) + esc(value) + html.slice(valEnd);
}

// ─── Helper: ganti href="..." pada <link id="ID" ...> ────────────────────────
function setLinkHref(html, id, value) {
  const marker    = `id="${id}" href="`;
  const start     = html.indexOf(marker);
  if (start === -1) return html;
  const valStart  = start + marker.length;
  const valEnd    = html.indexOf('"', valStart);
  if (valEnd === -1) return html;
  return html.slice(0, valStart) + esc(value) + html.slice(valEnd);
}

// ─── Helper: ganti <title>...</title> ────────────────────────────────────────
function setTitle(html, value) {
  return html.replace(/<title>[^<]*<\/title>/, `<title>${esc(value)}</title>`);
}

// ─── Ambil data artikel dari Firestore REST API ───────────────────────────────
function parseFields(fields = {}) {
  const s = (k) => fields[k]?.stringValue ?? "";
  return { judul: s("judul"), isi: s("isi"), gambar: s("gambar") };
}

async function ambilByDocId(id) {
  const url  = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/berita/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  if (!json.fields) return null;
  return parseFields(json.fields);
}

async function ambilBySlugField(slug) {
  const url  = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      structuredQuery: {
        from:  [{ collectionId: "berita" }],
        where: { fieldFilter: { field: { fieldPath: "slug" }, op: "EQUAL", value: { stringValue: slug } } },
        limit: 1,
      },
    }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  const row  = Array.isArray(rows) ? rows.find((r) => r.document) : null;
  if (!row) return null;
  return parseFields(row.document.fields);
}

async function ambilArtikel(slug) {
  // Coba Document ID dulu (ini yang dipakai index.html saat ini)
  const byId = await ambilByDocId(slug);
  if (byId && byId.judul) return byId;
  // Fallback: cari berdasarkan field "slug"
  const bySlug = await ambilBySlugField(slug);
  if (bySlug && bySlug.judul) return bySlug;
  return null;
}

// ─── Handler utama ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const proto   = req.headers["x-forwarded-proto"] || "https";
  const host    = req.headers["x-forwarded-host"]  || req.headers.host;
  const fullUrl = `${proto}://${host}${req.url}`;

  // Baca template LANGSUNG dari disk — tidak perlu HTTP request ke diri sendiri
  const templatePath = path.join(process.cwd(), "artikel-app.html");
  let html;
  try {
    html = fs.readFileSync(templatePath, "utf-8");
  } catch (e) {
    console.error("Gagal baca artikel-app.html:", e.message);
    res.status(500).send("Template tidak ditemukan. Pastikan artikel-app.html ada di root project.");
    return;
  }

  // ID Firestore selalu diprioritaskan untuk mengambil data artikel.
  // Param ?slug=... yang menyertai ?id=... (dari link baru index.html) HANYA kosmetik di URL
  // dan TIDAK dipakai untuk query — supaya tidak salah ambil data jika ada slug yang bentrok.
  // Fallback ambilBySlugField hanya dipakai kalau benar-benar tidak ada ?id= sama sekali
  // (misalnya link lama yang murni berbasis slug, kalau pernah ada).
  const idParam   = (req.query && req.query.id) || "";
  const slugParam = (req.query && req.query.slug) || "";
  const key = idParam || slugParam;

  if (key) {
    try {
      const artikel = idParam ? await ambilByDocId(idParam) : await ambilArtikel(key);
      if (artikel && artikel.judul) {
        const judulLengkap = `${artikel.judul} - KJNI`;
        const isiBersih    = (artikel.isi || "").replace(/\s+/g, " ").trim();
        const deskripsi    = isiBersih.length > 160 ? isiBersih.slice(0, 157) + "..." : isiBersih;
        const gambar       = artikel.gambar || DEFAULT_IMAGE;

        html = setTitle(html, judulLengkap);
        html = setMetaContent(html, "metaDescription", deskripsi);
        html = setLinkHref(html, "metaCanonical", fullUrl);
        html = setMetaContent(html, "metaOgUrl",    fullUrl);
        html = setMetaContent(html, "metaOgTitle",  artikel.judul);
        html = setMetaContent(html, "metaOgDesc",   deskripsi);
        html = setMetaContent(html, "metaOgImage",  gambar);
        html = setMetaContent(html, "metaTwTitle",  artikel.judul);
        html = setMetaContent(html, "metaTwDesc",   deskripsi);
        html = setMetaContent(html, "metaTwImage",  gambar);
      }
    } catch (e) {
      console.error("Gagal ambil data Firestore:", e.message);
      // Tetap kirim HTML template (tanpa meta artikel) daripada error 500
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Cache 10 menit di CDN Vercel, stale-while-revalidate 1 hari
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=600, stale-while-revalidate=86400");
  res.status(200).send(html);
};
