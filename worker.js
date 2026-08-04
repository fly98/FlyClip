/**
 * clip_worker.js — "FlyClip": clipboard condivisa fra dispositivi
 * Worker: fly-clip.f-castiglioni.workers.dev
 *
 * Storage: Durable Object con backend SQLite (fortemente consistente:
 * quello che scrivi dall'iPhone è leggibile dall'iPad nell'istante dopo,
 * a differenza di KV che ha propagazione eventuale fino a ~60s).
 *
 * Auth: header X-API-Key oppure query ?k=  (la query serve per <img src>
 * e per la comodità in Comandi Rapidi).
 *
 * Endpoint principali:
 *   POST   /push            body raw (text/* o image/*) oppure JSON
 *   GET    /last            ultimo elemento, binario col suo content-type
 *   GET    /last?format=text  forza testo (per Copia negli appunti)
 *   GET    /last?format=json  metadati + testo
 *   GET    /ping            {id, ts, kind} — poll leggero per il Mac
 *   GET    /list?limit=50   elenco metadati (no blob)
 *   GET    /item/:id        elemento specifico, binario
 *   GET    /meta/:id        metadati JSON
 *   DELETE /item/:id        elimina
 *   POST   /pin/:id         toggle pin (i pinnati non scadono mai)
 *   POST   /bump/:id        riporta in cima: /last restituira questo
 *   POST   /clear           svuota (tiene i pinnati)
 */

const CHUNK = 192 * 1024;      // dimensione chunk blob (limite riga SQLite DO ~2MB)
const MAX_ITEMS = 300;                        // ritenzione per numero
const MAX_AGE_DAYS = 7;                       // ritenzione per eta
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;    // tetto complessivo dei recenti
const MAX_BYTES = 20 * 1024 * 1024;           // tetto del singolo elemento

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,X-Filename,X-Device',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/**
 * Comandi Rapidi non sa consegnare un URL come "File": lo risolve scaricando
 * la pagina, quindi al posto del link arriva l'HTML intero (successo con i
 * link di pagamento Amenitiz, 135 KB di sorgente al posto dell'indirizzo).
 * Qui si riconosce quel caso e si recupera il link canonico.
 *
 * Si interviene solo su un documento completo che dichiari il proprio
 * indirizzo: uno snippet di HTML copiato apposta resta testo.
 */
function htmlToUrl(t) {
  const head = t.slice(0, 400).toLowerCase();
  if (!head.includes('<!doctype html') && !head.includes('<html')) return t;

  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m && /^https?:\/\//i.test(m[1])) return m[1].trim();
  }
  return t;
}

const isBlob = (kind) => kind === 'image' || kind === 'file';

const EXT = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/csv': 'csv',
  'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/heic': 'heic', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/msword': 'doc', 'application/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** Estrae il nome da un header Content-Disposition, se presente. */
function dispositionName(cd) {
  if (!cd) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* niente */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : null;
}

/** Nome di salvataggio: quello originale se c'e, altrimenti dedotto dal MIME. */
function fileName(row) {
  if (row.name) return row.name;
  const ext = EXT[row.mime] || (row.mime || '').split('/')[1] || 'bin';
  return `flyclip-${row.id}.${ext}`;
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function guessKind(mime, text) {
  if (mime && mime.startsWith('image/')) return 'image';
  if (text && /^https?:\/\/\S+$/i.test(text.trim())) return 'url';
  return 'text';
}

/**
 * Gli appunti di iOS e macOS contengono spesso la versione RTF di un testo
 * copiato da una pagina web. Comandi Rapidi spedisce quella, non il testo
 * semplice, quindi la si riduce qui: cosi vale per qualunque sorgente senza
 * dover toccare i comandi sul dispositivo.
 */
function rtfToText(s) {
  if (!/^\s*{\\rtf/.test(s)) return s;

  // L'RTF codifica i byte alti in Windows-1252, non in Latin-1: senza questa
  // mappa apostrofi tipografici e trattini lunghi diventano caratteri di
  // controllo invisibili (l'92accordo -> laccordo).
  const CP1252 = {
    0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
    0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
    0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
    0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
    0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
    0x9E: '\u017E', 0x9F: '\u0178',
  };

  // via le tabelle di intestazione (font, colori, stili): sono solo metadati
  let t = s.replace(/{\\(?:fonttbl|colortbl|stylesheet|\*\\expandedcolortbl|\*\\[a-z]+)[^{}]*(?:{[^{}]*}[^{}]*)*}/gi, '');

  t = t
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => {
      const c = parseInt(h, 16);
      return CP1252[c] || String.fromCharCode(c);
    })
    .replace(/\\u(-?\d+)\s?\??/g, (_, n) => String.fromCharCode(((+n) + 65536) % 65536))
    .replace(/\\(par|line)\b\s?/g, '\n')
    .replace(/\\tab\b\s?/g, '\t')
    .replace(/\\([{}\\])/g, '$1')          // graffe e backslash veri
    .replace(/\\[a-z]+-?\d*\s?/gi, '')     // ogni altra parola di controllo
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

// ─────────────────────────────────────────────────────────────
// Durable Object
// ─────────────────────────────────────────────────────────────
export class Clip {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      mime TEXT,
      name TEXT,
      size INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      device TEXT,
      label TEXT,
      saved_at INTEGER
    )`);
    // migrazione idempotente: aggiunge le colonne solo se davvero mancanti.
    // In un Durable Object un'eccezione SQL nel costruttore rompe l'oggetto,
    // quindi si controlla prima invece di affidarsi al try/catch.
    const have = new Set(
      this.sql.exec(`PRAGMA table_info(items)`).toArray().map(r => r.name)
    );
    if (!have.has('label')) this.sql.exec(`ALTER TABLE items ADD COLUMN label TEXT`);
    if (!have.has('saved_at')) this.sql.exec(`ALTER TABLE items ADD COLUMN saved_at INTEGER`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS blobs (
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB,
      PRIMARY KEY (id, seq)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_items_ts ON items(ts DESC)`);
  }

  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }

  // ---- scrittura ----
  insert({ kind, text, mime, name, device, bytes }) {
    const id = newId();
    const ts = Date.now();
    const size = bytes ? bytes.byteLength : (text ? new TextEncoder().encode(text).length : 0);
    this.sql.exec(
      `INSERT INTO items (id, ts, kind, text, mime, name, size, pinned, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      id, ts, kind, text ?? null, mime ?? null, name ?? null, size, device ?? null
    );
    if (bytes) {
      const u8 = new Uint8Array(bytes);
      let seq = 0;
      for (let off = 0; off < u8.length; off += CHUNK) {
        const slice = u8.slice(off, off + CHUNK);
        this.sql.exec(`INSERT INTO blobs (id, seq, data) VALUES (?, ?, ?)`, id, seq, slice);
        seq++;
      }
    }
    this.prune();
    return { id, ts, kind, size };
  }

  /**
   * Ritenzione dei soli elementi recenti: l'Archivio non scade mai, altrimenti
   * salvare non avrebbe senso. Tre limiti, applicati in quest'ordine: eta,
   * numero, peso complessivo. Sul peso si eliminano i piu vecchi finche si
   * rientra sotto il tetto.
   */
  prune() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;

    const scaduti = this.rows(
      `SELECT id FROM items WHERE pinned = 0 AND ts < ?`, cutoff
    ).map(r => r.id);

    const eccedenti = this.rows(
      `SELECT id FROM items WHERE pinned = 0 ORDER BY ts DESC LIMIT -1 OFFSET ?`, MAX_ITEMS
    ).map(r => r.id);

    const via = new Set([...scaduti, ...eccedenti]);

    // peso: si scorre dal piu recente e si taglia quando si sfora
    let totale = 0;
    for (const r of this.rows(
      `SELECT id, size FROM items WHERE pinned = 0 ORDER BY ts DESC`
    )) {
      if (via.has(r.id)) continue;
      totale += r.size || 0;
      if (totale > MAX_TOTAL_BYTES) via.add(r.id);
    }

    for (const id of via) this.remove(id);
  }

  remove(id) {
    this.sql.exec(`DELETE FROM blobs WHERE id = ?`, id);
    this.sql.exec(`DELETE FROM items WHERE id = ?`, id);
  }

  // ---- lettura ----
  meta(id) {
    const r = this.rows(`SELECT * FROM items WHERE id = ?`, id);
    return r[0] || null;
  }

  latest() {
    const r = this.rows(`SELECT * FROM items ORDER BY ts DESC LIMIT 1`);
    return r[0] || null;
  }

  blob(id) {
    const parts = this.rows(`SELECT data FROM blobs WHERE id = ? ORDER BY seq ASC`, id);
    if (!parts.length) return null;
    const chunks = parts.map(p => new Uint8Array(p.data));
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Risposta "auto": binario per immagini, testo puro per il resto.
  serve(row, format) {
    if (!row) return json({ ok: false, error: 'vuoto' }, 404);

    if (format === 'json') {
      return json({ ok: true, ...row, pinned: !!row.pinned });
    }

    if (isBlob(row.kind) && format !== 'text') {
      const bytes = this.blob(row.id);
      if (!bytes) return json({ ok: false, error: 'blob mancante' }, 404);
      return new Response(bytes, {
        headers: {
          'Content-Type': row.mime || 'application/octet-stream',
          'Content-Disposition':
            `${row.kind === 'image' ? 'inline' : 'attachment'}; filename="${fileName(row)}"`,
          'X-Clip-Id': row.id,
          'X-Clip-Kind': row.kind,
          'Cache-Control': 'no-store',
          ...CORS,
        },
      });
    }

    return new Response(row.text ?? '', {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Clip-Id': row.id,
        'X-Clip-Kind': row.kind,
        'Cache-Control': 'no-store',
        ...CORS,
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const seg = path.split('/').filter(Boolean);
    const method = request.method;
    const format = url.searchParams.get('format') || 'auto';

    try {
      // POST /push
      if (method === 'POST' && seg[0] === 'push') {
        const ct = (request.headers.get('Content-Type') || '').toLowerCase();
        const device = request.headers.get('X-Device') || url.searchParams.get('device') || null;
        const nameHdr =
          request.headers.get('X-Filename') ||
          url.searchParams.get('name') ||
          dispositionName(request.headers.get('Content-Disposition')) ||
          null;

        let payload;
        if (ct.includes('application/json')) {
          const b = await request.json();
          if (b.data) {
            const bin = Uint8Array.from(atob(b.data), c => c.charCodeAt(0));
            payload = {
              kind: 'image', bytes: bin.buffer,
              mime: b.mime || 'image/png', name: b.name || nameHdr, device: b.device || device,
            };
          } else {
            const text = htmlToUrl(rtfToText(String(b.text ?? '')));
            payload = { kind: b.kind || guessKind(null, text), text, device: b.device || device, name: b.name || nameHdr };
          }
        } else if (ct && !ct.startsWith('text/')) {
          // qualunque cosa non sia testo viaggia come binario: immagini,
          // PDF, documenti, archivi. Solo le immagini si mostrano in anteprima.
          const buf = await request.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'troppo grande' }, 413);
          const mime = ct.split(';')[0].trim();
          payload = {
            kind: mime.startsWith('image/') ? 'image' : 'file',
            bytes: buf, mime, name: nameHdr, device,
          };
        } else {
          const text = htmlToUrl(rtfToText(await request.text()));
          payload = { kind: guessKind(null, text), text, device, name: nameHdr };
        }

        if (!isBlob(payload.kind) && !String(payload.text || '').trim()) {
          return json({ ok: false, error: 'contenuto vuoto' }, 400);
        }
        const res = this.insert(payload);
        return json({ ok: true, ...res });
      }

      // GET /last
      if (method === 'GET' && seg[0] === 'last') {
        return this.serve(this.latest(), format);
      }

      // GET /ping
      if (method === 'GET' && seg[0] === 'ping') {
        const r = this.latest();
        return json({
          ok: true,
          id: r ? r.id : null,
          ts: r ? r.ts : 0,
          kind: r ? r.kind : null,
          size: r ? r.size : 0,
        });
      }

      // GET /list
      if (method === 'GET' && seg[0] === 'list') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10), 500);
        const saved = url.searchParams.get('saved');
        const cols = `id, ts, kind, mime, name, size, pinned, device, label, saved_at,
                  CASE WHEN kind IN ('image','file') THEN NULL ELSE substr(text, 1, 400) END AS preview`;
        let items;
        if (saved === '1') {
          items = this.rows(
            `SELECT ${cols} FROM items WHERE pinned = 1
             ORDER BY COALESCE(saved_at, ts) DESC LIMIT ?`, limit);
        } else if (saved === '0') {
          items = this.rows(
            `SELECT ${cols} FROM items WHERE pinned = 0 ORDER BY ts DESC LIMIT ?`, limit);
        } else {
          items = this.rows(
            `SELECT ${cols} FROM items ORDER BY pinned DESC, ts DESC LIMIT ?`, limit);
        }
        return json({
          ok: true,
          count: items.length,
          items: items.map(i => ({
            ...i,
            pinned: !!i.pinned,
            // per i binari si espone comunque un nome: se manca quello
            // originale si usa lo stesso che verrebbe usato per il download
            name: isBlob(i.kind) ? fileName(i) : i.name,
          })),
        });
      }

      // /item/:id
      if (seg[0] === 'item' && seg[1]) {
        if (method === 'GET') return this.serve(this.meta(seg[1]), format);
        if (method === 'DELETE') {
          this.remove(seg[1]);
          return json({ ok: true, deleted: seg[1] });
        }
      }

      // GET /meta/:id
      if (method === 'GET' && seg[0] === 'meta' && seg[1]) {
        const r = this.meta(seg[1]);
        return r ? json({ ok: true, ...r, pinned: !!r.pinned }) : json({ ok: false, error: 'non trovato' }, 404);
      }

      // POST /pin/:id
      if (method === 'POST' && seg[0] === 'pin' && seg[1]) {
        const r = this.meta(seg[1]);
        if (!r) return json({ ok: false, error: 'non trovato' }, 404);
        const val = r.pinned ? 0 : 1;
        this.sql.exec(
          `UPDATE items SET pinned = ?, saved_at = ? WHERE id = ?`,
          val, val ? Date.now() : null, seg[1]
        );
        return json({ ok: true, id: seg[1], pinned: !!val });
      }

      // POST /bump/:id — riporta in cima, cosi /last restituisce questo.
      // Serve a scegliere dall'elenco cosa incollare sul telefono: si tocca
      // Copia sulla pagina e il comando rapido "Incolla" prende quello.
      if (method === 'POST' && seg[0] === 'bump' && seg[1]) {
        const r = this.meta(seg[1]);
        if (!r) return json({ ok: false, error: 'non trovato' }, 404);
        const ts = Date.now();
        this.sql.exec(`UPDATE items SET ts = ? WHERE id = ?`, ts, seg[1]);
        return json({ ok: true, id: seg[1], ts });
      }

      // POST /label/:id  — etichetta per lo storico permanente
      if (method === 'POST' && seg[0] === 'label' && seg[1]) {
        const r = this.meta(seg[1]);
        if (!r) return json({ ok: false, error: 'non trovato' }, 404);
        let label = null;
        const ct = (request.headers.get('Content-Type') || '').toLowerCase();
        if (ct.includes('application/json')) {
          const b = await request.json();
          label = b.label != null ? String(b.label).slice(0, 120) : null;
        } else {
          const t = (await request.text()).trim();
          label = t ? t.slice(0, 120) : null;
        }
        this.sql.exec(`UPDATE items SET label = ? WHERE id = ?`, label || null, seg[1]);
        return json({ ok: true, id: seg[1], label });
      }

      // POST /clear
      if (method === 'POST' && seg[0] === 'clear') {
        const ids = this.rows(`SELECT id FROM items WHERE pinned = 0`).map(r => r.id);
        for (const id of ids) this.remove(id);
        return json({ ok: true, removed: ids.length });
      }

      return json({ ok: false, error: 'endpoint sconosciuto', path }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Worker entry
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'fly-clip' });

    const key = request.headers.get('X-API-Key') || url.searchParams.get('k');
    if (!env.CLIP_KEY || key !== env.CLIP_KEY) {
      return json({ ok: false, error: 'non autorizzato' }, 401);
    }

    const id = env.CLIP.idFromName('main');
    return env.CLIP.get(id).fetch(request);
  },
};
