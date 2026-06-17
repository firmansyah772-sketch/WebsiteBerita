// api/artikel.js
//
// Fungsi ini jalan di SERVER Vercel, SEBELUM halaman artikel dikirim ke
// browser/bot. Tugasnya:
//   1. Baca ?slug=... dari URL
//   2. Ambil data (judul, isi, gambar) dari Firestore
//   3. Suntikkan data itu ke meta tag Open Graph & Twitter Card di HTML
//   4. Kirim HTML yang sudah lengkap itu ke siapapun yang minta
//
// Karena bot WhatsApp/Facebook/Telegram TIDAK menjalankan JavaScript,
// mereka hanya akan melihat HTML hasil fungsi ini -- yang sudah berisi
// judul artikel yang benar di tag <title> dan <meta property="og:title">.

const FIREBASE_PROJECT_ID = "webberita-8af66";
const FIREBASE_API_KEY = "AIzaSyCCOOmXPfLhbDdSoil1UHfld5731689HVw";
const DEFAULT_IMAGE = "https://res.cloudinary.com/dc7guxgnm/image/upload/q_auto/f_auto/v1780978628/1000305972_ynq9xo.png";

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Ganti isi content="..." dari sebuah <meta id="...">
function setMetaContent(html, id, value) {
  const marker = `id="${id}" content="`;
  const start = html.indexOf(marker);
  if (start === -1) return html;
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf('"', valueStart);
  if (valueEnd === -1) return html;
  return html.slice(0, valueStart) + escapeHtml(value) + html.slice(valueEnd);
}

// Ganti isi href="..." dari sebuah <link id="...">
function setLinkHref(html, id, value) {
  const marker = `id="${id}" href="`;
  const start = html.indexOf(marker);
  if (start === -1) return html;
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf('"', valueStart);
  if (valueEnd === -1) return html;
  return html.slice(0, valueStart) + escapeHtml(value) + html.slice(valueEnd);
}

function setTitleTag(html, value) {
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(value)}</title>`);
}

function parseFirestoreFields(fields = {}) {
  const getStr = (key) => fields[key]?.stringValue ?? "";
  return {
    judul: getStr("judul"),
    isi: getStr("isi"),
    gambar: getStr("gambar"),
  };
}

// Coba ambil dokumen langsung berdasarkan Document ID.
// (Ini jalur utama karena admin.html saat ini belum membuat field "slug",
// jadi index.html memakai Document ID sebagai "slug" di URL.)
async function ambilByDocId(id) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/berita/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  if (!json.fields) return null;
  return parseFirestoreFields(json.fields);
}

// Fallback: cari berdasarkan field "slug" (untuk jaga-jaga jika nanti field
// slug ditambahkan di admin panel).
async function ambilBySlugField(slug) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "berita" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "slug" },
            op: "EQUAL",
            value: { stringValue: slug },
          },
        },
        limit: 1,
      },
    }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  const row = Array.isArray(rows) ? rows.find((r) => r.document) : null;
  if (!row) return null;
  return parseFirestoreFields(row.document.fields);
}

async function ambilArtikel(slug) {
  const lewatId = await ambilByDocId(slug);
  if (lewatId && lewatId.judul) return lewatId;

  const lewatSlug = await ambilBySlugField(slug);
  if (lewatSlug && lewatSlug.judul) return lewatSlug;

  return null;
}

module.exports = async (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const appUrl = `${proto}://${host}/artikel-app.html`;
  const fullUrl = `${proto}://${host}${req.url}`;

  try {
    const slug = (req.query && req.query.slug) || "";

    const templateResp = await fetch(appUrl);
    let html = await templateResp.text();

    if (slug) {
      const artikel = await ambilArtikel(slug);
      if (artikel && artikel.judul) {
        const judulLengkap = `${artikel.judul} - KJNI`;
        const isiBersih = (artikel.isi || "").replace(/\s+/g, " ").trim();
        const deskripsi = isiBersih.length > 160 ? isiBersih.slice(0, 157) + "..." : isiBersih;
        const gambar = artikel.gambar || DEFAULT_IMAGE;

        html = setTitleTag(html, judulLengkap);
        html = setMetaContent(html, "metaDescription", deskripsi);
        html = setLinkHref(html, "metaCanonical", fullUrl);
        html = setMetaContent(html, "metaOgUrl", fullUrl);
        html = setMetaContent(html, "metaOgTitle", artikel.judul);
        html = setMetaContent(html, "metaOgDesc", deskripsi);
        html = setMetaContent(html, "metaOgImage", gambar);
        html = setMetaContent(html, "metaTwTitle", artikel.judul);
        html = setMetaContent(html, "metaTwDesc", deskripsi);
        html = setMetaContent(html, "metaTwImage", gambar);
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=600, stale-while-revalidate=86400");
    res.status(200).send(html);
  } catch (err) {
    console.error("Gagal render SSR artikel:", err);
    try {
      const fallback = await fetch(appUrl);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(await fallback.text());
    } catch (e2) {
      res.status(500).send("Internal Server Error");
    }
  }
};