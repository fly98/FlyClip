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
 *   POST   /clear           svuota (tiene i pinnati)
 */

const CHUNK = 192 * 1024;      // dimensione chunk blob (limite riga SQLite DO ~2MB)
const MAX_ITEMS = 300;         // ritenzione per numero
const MAX_AGE_DAYS = 60;       // ritenzione per età
const MAX_BYTES = 20 * 1024 * 1024;

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

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function guessKind(mime, text) {
  if (mime && mime.startsWith('image/')) return 'image';
  if (text && /^https?:\/\/\S+$/i.test(text.trim())) return 'url';
  return 'text';
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

  prune() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const old = this.rows(
      `SELECT id FROM items WHERE pinned = 0 AND ts < ?`, cutoff
    ).map(r => r.id);
    const extra = this.rows(
      `SELECT id FROM items WHERE pinned = 0 ORDER BY ts DESC LIMIT -1 OFFSET ?`, MAX_ITEMS
    ).map(r => r.id);
    for (const id of new Set([...old, ...extra])) this.remove(id);
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

    if (row.kind === 'image' && format !== 'text') {
      const bytes = this.blob(row.id);
      if (!bytes) return json({ ok: false, error: 'blob mancante' }, 404);
      return new Response(bytes, {
        headers: {
          'Content-Type': row.mime || 'image/png',
          'Content-Disposition': `inline; filename="${row.name || 'clip.png'}"`,
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
        const nameHdr = request.headers.get('X-Filename') || url.searchParams.get('name') || null;

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
            const text = String(b.text ?? '');
            payload = { kind: b.kind || guessKind(null, text), text, device: b.device || device, name: b.name || nameHdr };
          }
        } else if (ct.startsWith('image/') || ct.startsWith('application/octet-stream')) {
          const buf = await request.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'troppo grande' }, 413);
          payload = { kind: 'image', bytes: buf, mime: ct.split(';')[0], name: nameHdr, device };
        } else {
          const text = await request.text();
          payload = { kind: guessKind(null, text), text, device, name: nameHdr };
        }

        if (payload.kind !== 'image' && !String(payload.text || '').trim()) {
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
                  CASE WHEN kind = 'image' THEN NULL ELSE substr(text, 1, 400) END AS preview`;
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
        return json({ ok: true, count: items.length, items: items.map(i => ({ ...i, pinned: !!i.pinned })) });
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
