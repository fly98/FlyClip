# FlyClip

Appunti condivisi tra iPhone, iPad e Mac. Sostituisce l'app Paste.

- **Pagina**: https://fly98.github.io/FlyClip/
- **Worker**: `fly-clip.f-castiglioni.workers.dev`

## Perché un Durable Object e non KV

KV propaga in modo eventuale (~60 s): stesso difetto di Paste, che è il
motivo per cui questo progetto esiste. Il Durable Object è a istanza
singola (`idFromName("main")`) e fortemente consistente: quello che copi
sull'iPhone è leggibile dal Mac nello stesso istante.

Le immagini stanno dentro il DO stesso, spezzate in chunk da 192 KB
(il limite per riga SQLite è ~2 MB). Niente R2: stessa consistenza,
zero configurazione da dashboard.

## Autenticazione

Header `X-API-Key`, oppure `?k=` in query string per i casi in cui
l'header non è passabile (tag `<img>`, alcune azioni di Shortcuts).
Il valore sta nel secret Cloudflare `CLIP_KEY`.

## API

| Metodo | Endpoint | Note |
|---|---|---|
| GET | `/health` | pubblico |
| POST | `/push` | body raw `text/*` o `image/*`, oppure JSON |
| GET | `/last` | binario col Content-Type reale |
| GET | `/last?format=text` | forza testo |
| GET | `/ping` | solo metadati, per il polling del Mac |
| GET | `/list?saved=0\|1` | recenti / archivio |
| GET | `/item/:id` | elemento specifico |
| DELETE | `/item/:id` | elimina |
| POST | `/pin/:id` | sposta in archivio (non scade mai) |
| POST | `/label/:id` | body = etichetta, max 120 caratteri |
| POST | `/clear` | svuota tranne l'archivio |

Ritenzione automatica a ogni push: 300 elementi non archiviati, 60 giorni.

## Deploy

Push di `worker.js` o `wrangler.toml` su `main` → GitHub Actions → Cloudflare.
Servono i secret di repo `CF_API_TOKEN` e `CF_ACCOUNT_ID`.
La pagina è servita da GitHub Pages dalla root di `main`.
