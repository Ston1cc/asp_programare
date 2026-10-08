# asp_programare

Monitorizează disponibilitatea locurilor pentru examenul auto la ASP (Chișinău), pe 8
categorii (teoretic/practic, obișnuit/urgent, practic pe 3 filiale), și trimite notificări
pe Telegram. Are și o comandă la cerere (`/acum`) cu răspuns aproape instant, prin webhook.

## Cum funcționează

Interoghează direct API-ul public al portalului `eservicii.gov.md/asp/dimtcca`, descoperit
prin inspecția fluxului de programare APO01. Nu folosește browser headless, doar 3 cereri
HTTP simple per categorie:

1. `GET /apo-request/get-service/{tip}/{urgent}[/{categorie}]` : service ID
2. `GET /qmatic/locations/{serviceId}` : id-ul locației
3. `POST /qmatic/dates` : zilele libere (± 3 luni), cu numărul de locuri pe zi

Monitorul doar citește. Nu plătește, nu rezervă, nu depune nicio cerere.

Proiectul are două componente:

### 1. Verificarea periodică (GitHub Actions, din oră în oră)

`src/index.js`, rulat de `.github/workflows/check.yml`. Ține minte cea mai devreme zi
liberă per categorie și trimite:

- alertă imediată când apare o zi mai devreme decât minimul cunoscut (semnalul principal)
- alertă normală pentru zile noi, dar mai târzii
- rezumat zilnic la 07:30 (Europe/Chisinau), cu situația completă

**Limita zilnică ASP.** ASP acceptă un număr limitat de cereri pe zi per IDNP (estimat
250-300), apoi răspunde cu HTTP 429 până la 00:00 UTC (03:00 Chișinău). La prima 429,
checker-ul se oprește: trimite un singur mesaj de avertizare și nu mai face nicio cerere
până la resetare. La fel pentru `/acum`. Numărul de cereri făcute azi apare în logul
fiecărei rulări.

### 2. Comanda la cerere (`/acum`, webhook pe Vercel)

Scrii `/acum` (sau `/live`, `/check`) botului și primești răspuns instant (1-2
secunde), citit live, nu din cache. `/help` listează toate comenzile disponibile; același
meniu apare și în Telegram (butonul "Menu" de lângă câmpul de text).

**`/setari`** (proprietar și invitați): butoane pentru ce urmărești. Teoretic / practic,
obișnuit / urgent, fiecare filială de la practic, plus „📅 Până la” (o dată-țintă: nu te
anunță decât pentru date până atunci). Se aplică și la `/acum` (se citesc doar categoriile
alese, deci mai puține cereri din cota ASP), și la alertele și rezumatul automat. Diff-ul
rulează mereu pe toate categoriile; setările filtrează doar ce vezi, deci reactivarea unei
categorii nu produce alerte false. Setările proprietarului ajung la checker-ul din CI prin
`api/owner-prefs.js`; dacă nu pot fi citite, alertele arată tot, ca înainte.

**`/status`** (doar proprietar): ultima rulare a checker-ului și cât de veche e (cu avertisment
peste 3 ore), cereri ASP azi, limita ASP, dacă `/acum` e blocat, câți invitați sunt
aprobați / înregistrați / cu notificările oprite / în așteptare, rezultatul ultimei rulări de
notificări și setările tale active.

Arhitectural, e un webhook Telegram, nu polling: `api/telegram-webhook.js`, funcție
serverless pe Vercel, înregistrată direct la Telegram prin `setWebhook`. Telegram trimite
mesajul direct acolo, fără nicio verificare periodică.

**Acces pentru alte persoane.** Oricine altcineva poate folosi botul, dar în numele lui,
nu al proprietarului, și doar după aprobare manuală. La primul mesaj primește confirmare
că cererea a fost trimisă proprietarului; proprietarul primește o notificare cu
nume/@username/chat_id și butoane Aprobă/Respinge. După aprobare, `/inregistrare` cere pas
cu pas IDNP, seria buletinului și data eliberării; mesajele cu aceste date sunt șterse din
chat imediat după citire. Datele sunt salvate per `chat_id` în Redis, criptate
(AES-256-GCM), cu TTL (90 zile pentru date confirmate, 10 minute pentru o înregistrare
abandonată). `/sterge` șterge oricând datele salvate ale oricui le cere, după o confirmare
cu butoane „Da, șterge” / „Anulează” (un tap greșit pe butonul din tastatură nu mai
distruge datele). Proprietarul poate
vedea cine are acces (`/utilizatori`) sau revoca accesul cuiva (`/revoca <chat_id>`). Botul
iese singur din orice grup: e gândit doar pentru chat privat.

**Notificări automate pentru invitați.** Un invitat aprobat și înregistrat primește, pe
datele lui, aceleași mesaje ca proprietarul: alertă când apare o zi mai devreme sau nouă +
rezumat zilnic la 07:30. Sunt pornite implicit și se opresc oricând cu `/notificari`
(buton în tastatură; apăsat din nou le repornește, `/acum` merge oricum). Fiecare mesaj
automat se termină cu "Nu mai vrei notificări automate? Apasă /notificari", iar primul
explică ce va primi. Fiecare invitat consumă cota ASP a propriului IDNP, nu pe a
proprietarului, iar la limita zilnică primește un singur mesaj de pauză. Rulează în
`api/notify-guests.js`, apelat din CI după verificarea proprietarului (vezi mai jos).

## Configurare locală

```bash
cp .env.example .env
# completează .env cu IDNP, seria buletinului, data emiterii, token + chat id Telegram
node --env-file=.env src/index.js
```

## Configurare CI (GitHub Actions, verificarea periodică)

Repo-ul trebuie să fie privat. Adaugă în Settings > Secrets and variables > Actions:

| Secret | Descriere |
|---|---|
| `ASP_IDNP` | IDNP-ul persoanei care dă examenul |
| `ASP_DOC_SERIES` | seria + numărul buletinului, fără spații |
| `ASP_DOC_ISSUE_DATE` | data emiterii buletinului, format `YYYY-MM-DDTHH:mm:ss` |
| `TELEGRAM_BOT_TOKEN` | token de la [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | id-ul chatului unde ajung notificările |
| `NOTIFY_SECRET` | același șir ca `NOTIFY_SECRET` din Vercel; autentifică apelul către `/api/notify-guests` |

După verificarea proprietarului, workflow-ul face `POST /api/notify-guests` (pasul "Notifică
invitații", `continue-on-error`). Notificările invitaților rulează pe Vercel, nu în CI,
pentru că datele lor sunt criptate cu `USER_DATA_KEY`, care rămâne doar în Vercel.

Workflow-ul rulează la `30 * * * *` (GitHub `schedule` e best-effort, pot apărea întârzieri
de ore) și poate fi declanșat manual din tab-ul Actions (`workflow_dispatch`).

## Configurare webhook (Vercel, comanda `/acum`)

Proiect Vercel separat (`asp-programare-webhook`), cu aceleași 5 variabile de mai sus, plus:

| Env var | Descriere |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | șir random, Telegram îl trimite înapoi la fiecare cerere ca dovadă de identitate |
| `REDIS_URL` | necesar doar dacă vrei ca alte persoane (nu proprietarul) să poată folosi botul |
| `USER_DATA_KEY` | obligatoriu împreună cu `REDIS_URL`, cheia de criptare a datelor altor persoane |
| `NOTIFY_SECRET` | șir random (Bearer) pentru `/api/notify-guests`; aceeași valoare ca secretul GitHub cu același nume |

`REDIS_URL` e un connection string standard (`redis://default:PAROLA@host:port`); orice
provider merge (Redis Cloud, Upstash TCP, self-hosted). Preferă `rediss://` (TLS) dacă
providerul îl oferă. Fără `REDIS_URL`, doar proprietarul poate folosi botul.

`USER_DATA_KEY` trebuie să fie 32 bytes random, codați base64:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Dacă o schimbi ulterior, datele deja salvate în Redis devin ilizibile; persoanele afectate
trebuie să se reînregistreze.

Pași de configurare (o singură dată):
1. Deploy `api/telegram-webhook.js` + `src/*.js` pe Vercel (funcție serverless, fără build).
2. Dezactivează SSO/Vercel Authentication protection pe proiect, altfel Telegram primește
   401 de la Vercel în loc de la cod.
3. `POST https://api.telegram.org/bot<TOKEN>/setWebhook` cu `url` = URL-ul funcției și
   `secret_token` = valoarea din `TELEGRAM_WEBHOOK_SECRET`.
4. `npm run set-commands` (o singură dată, sau la fiecare schimbare a listei de comenzi).
5. La [@BotFather](https://t.me/BotFather), `/setjoingroups` > Disable.

Proiectul Vercel e conectat la repo și se redeployează la fiecare push pe `master`. Dacă un
deploy din git e blocat (autorul commit-ului trebuie să fie un email verificat pe contul
GitHub care deține repo-ul, altfel planul Hobby îl refuză), fallback: `vercel --prod --yes`.

## Structură

```
src/
├─ index.js         orchestrator pentru verificarea periodică (heartbeat + alerte + diff)
├─ live.js          interogare live + mesaj de răspuns, folosit de webhook
├─ asp.js           client API ASP (service id -> locație -> zile)
├─ config.js        categorii + locații monitorizate, validare env
├─ state.js         persistență + diff (inclusiv logica "cea mai devreme zi")
├─ format.js        mesaje Telegram + utilitare de dată (fus Europe/Chisinau)
├─ telegram.js      client Telegram Bot API + tastaturi persistente + setMyCommands
├─ registration.js  flux conversațional (IDNP/serie/dată) + mesajul /help
├─ userStore.js     persistență per chat_id (Redis) pentru datele altor persoane
├─ check.js         verificarea unei persoane (fetch + diff + alertă + rezumat), comună proprietar/invitați
├─ guests.js        bucla de notificări pentru invitații aprobați
├─ prefs.js         setările /setari (filtre categorii/filiale/dată-țintă) + tastatura inline
├─ status.js        mesajul /status (pur)
└─ secret.js        comparare de secrete în timp constant
api/
├─ telegram-webhook.js   funcție serverless (Vercel), răspunde la /acum etc.
├─ notify-guests.js      funcție serverless (Vercel), notificările invitaților; apelată din CI
└─ owner-prefs.js        funcție serverless (Vercel), setările proprietarului pentru CI
scripts/
└─ set-commands.mjs      înregistrează comenzile în meniul nativ Telegram (o singură dată)
state/slots.json   stare persistată de verificarea periodică, comisă înapoi în repo de CI
```

## Note

- Categoria practică e fixată pe B, cutie mecanică (`BMechanical`); se schimbă în
  `src/config.js` dacă e nevoie de altă categorie (există și `BAutomatic`, verificat).
- Dacă ASP blochează IP-urile de datacenter ale GitHub Actions/Vercel, verificarea
  periodică rulează identic local (Task Scheduler / cron); doar trigger-ul se schimbă.
