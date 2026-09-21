# asp_programare

Monitorizează disponibilitatea locurilor pentru examenul auto la ASP (Chișinău) pentru
8 targeturi — teoretic/practic × obișnuit/urgent, practic pe 3 filiale — și trimite
notificări pe Telegram. Include și o comandă la cerere (`/acum`) cu răspuns aproape
instant, prin webhook.

## Cum funcționează

Interoghează direct API-ul public al portalului `eservicii.gov.md/asp/dimtcca` (descoperit
prin inspecția fluxului de programare APO01). Nu folosește browser headless — trei cereri
HTTP simple per categorie:

1. `GET /apo-request/get-service/{tip}/{urgent}[/{categorie}]` → service ID
2. `GET /qmatic/locations/{serviceId}` → id-ul locației
3. `POST /qmatic/dates` → zilele libere (± ~3 luni), cu numărul de locuri pe zi

Proiectul are **două componente**, cu roluri diferite:

### 1. Verificarea periodică (GitHub Actions, la 2 ore)

`src/index.js`, rulat de `.github/workflows/check.yml`. Ține minte cea mai devreme zi
liberă per categorie și trimite:

- **alertă imediată** când apare o zi *mai devreme* decât minimul cunoscut (evenimentul
  important — semnalează că poți programa mai repede)
- alertă normală pentru zile noi mai târzii
- **rezumat zilnic** la 08:00 (Europe/Chisinau) cu situația completă (cele mai apropiate
  date per categorie + toate zilele + tabel comparativ pe filiale pentru proba practică)

### 2. Comanda la cerere (`/acum`, webhook pe Vercel)

Scrii `/acum` (sau `/live`, `/status`, `/check`) botului și primești răspuns **instant**
(1-2 secunde), cu cele mai apropiate date la fiecare categorie, citite live, nu din cache.

Arhitectural, asta e un webhook Telegram — nu polling. `api/telegram-webhook.js`, deployat
ca funcție serverless pe Vercel, e înregistrat direct la Telegram prin `setWebhook`, deci
Telegram trimite mesajul direct acolo de îndată ce-l scrii, fără nicio verificare
periodică. (Varianta inițială, cu polling la 5 minute prin GitHub Actions, a fost
înlocuită — un ciclu de verificare avea un plafon fizic de ~5 minute, uneori mai mult.)

Monitorul **doar citește**. Nu plătește, nu rezervă, nu depune nicio cerere.

## Configurare locală

```bash
cp .env.example .env
# completează .env cu IDNP, seria buletinului, data emiterii, token + chat id Telegram
node --env-file=.env src/index.js
```

## Configurare CI (GitHub Actions — verificarea periodică)

Repo-ul trebuie să fie **privat**. Adaugă în Settings → Secrets and variables → Actions:

| Secret | Descriere |
|---|---|
| `ASP_IDNP` | IDNP-ul persoanei care dă examenul |
| `ASP_DOC_SERIES` | seria + numărul buletinului, fără spații |
| `ASP_DOC_ISSUE_DATE` | data emiterii buletinului, format `YYYY-MM-DDTHH:mm:ss` |
| `TELEGRAM_BOT_TOKEN` | token de la [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | id-ul chatului unde ajung notificările |

Workflow-ul (`.github/workflows/check.yml`) rulează la `0 */2 * * *` și poate fi declanșat
manual din tab-ul Actions (`workflow_dispatch`).

## Configurare webhook (Vercel — comanda `/acum`)

Proiect Vercel separat (`asp-programare-webhook`), cu propriile environment variables
(aceleași 5 de mai sus, plus una nouă):

| Env var | Descriere |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | șir random; Telegram îl trimite înapoi pe fiecare cerere ca să dovedească faptul că e chiar el, nu oricine a ghicit URL-ul |

Pași de configurare (o singură dată):
1. Deploy `api/telegram-webhook.js` + `src/*.js` pe Vercel (funcție serverless, fără build).
2. Dezactivează SSO/Vercel Authentication protection pe proiect — altfel Telegram nu poate
   ajunge la funcție (primește 401 de la Vercel, nu de la codul nostru).
3. `POST https://api.telegram.org/bot<TOKEN>/setWebhook` cu `url` = URL-ul funcției și
   `secret_token` = valoarea din `TELEGRAM_WEBHOOK_SECRET`.

Orice modificare la codul webhook-ului necesită un redeploy manual pe Vercel (nu e legat
de push-uri pe GitHub în configurația curentă).

## Structură

```
src/
├─ index.js     orchestrator pentru verificarea periodică (heartbeat + alerte + diff)
├─ live.js      interogare live + mesaj de răspuns, folosit de webhook
├─ asp.js       client API ASP (service id → locație → zile)
├─ config.js    categorii+locații monitorizate + validare env
├─ state.js     persistență + diff (inclusiv logica de "cea mai devreme zi")
├─ format.js    mesaje Telegram + utilitare de dată (fus Europe/Chisinau)
└─ telegram.js  client Telegram Bot API
api/
└─ telegram-webhook.js   funcție serverless (Vercel) — răspunde la "/acum"
state/slots.json   stare persistată de verificarea periodică, comisă înapoi în repo de CI
```

## Note

- Categoria practică e fixată pe **B, cutie mecanică** (`BMechanical`) — se schimbă în
  `src/config.js` dacă e nevoie de altă categorie (există și `BAutomatic`, verificat).
- Dacă ASP blochează IP-urile de datacenter ale GitHub Actions/Vercel, verificarea
  periodică rulează identic local (Task Scheduler / cron); doar trigger-ul se schimbă.
