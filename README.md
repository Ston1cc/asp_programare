# asp_programare

**Bot Telegram care te anunță când se eliberează o zi mai devreme la examenul auto ASP (Chișinău).**

*Telegram bot that watches the Moldovan Public Services Agency (ASP) driving-exam calendar in
Chișinău and alerts you as soon as an earlier exam date opens up.*

> Proiect neoficial, fără nicio legătură cu ASP sau cu Agenția de Guvernare Electronică. Doar
> citește calendarul public de programări: nu plătește, nu rezervă și nu depune nicio cerere.

## De ce

Locurile la examen se eliberează pe neașteptate (anulări, zile noi), iar cine verifică manual
portalul de mai multe ori pe zi le prinde primul. Botul face asta în locul tău și îți scrie doar
când contează: **când poți programa mai devreme decât înainte**.

## Ce face

- **Monitorizează 8 categorii:** examen teoretic și practic, programare obișnuită și urgentă,
  practicul pe 3 filiale din Chișinău (Rădăuțanu, Calea Ieșilor, Salcâmilor).
- **Alertă 🔥 doar pentru zile mai devreme** decât cea mai devreme dată cunoscută pe categorie.
  Zilele noi care apar după ea nu generează mesaje.
- **Rezumat zilnic la 07:30** cu cele mai apropiate date pe fiecare categorie.
- **`/acum`:** verificare live în 1-2 secunde, la cerere.
- **`/setari`:** alegi ce urmărești (teoretic/practic, obișnuit/urgent, filiale) și o dată-țintă
  („anunță-mă doar pentru date până la…”).
- **Mai mulți utilizatori:** alte persoane pot folosi botul pe propriile date, după aprobarea
  proprietarului, și primesc aceleași alerte automate (le pot opri cu `/notificari`).

## Comenzi

| Comandă | Cine | Ce face |
|---|---|---|
| `/acum` (`/live`, `/check`) | toți | cele mai apropiate date, citite live |
| `/setari` | toți | filtre: categorii, filiale, dată-țintă |
| `/help` | toți | lista comenzilor disponibile pentru tine |
| `/start`, `/inregistrare` | invitați | cerere de acces, apoi introducerea IDNP / serie / dată |
| `/notificari` | invitați | pornește/oprește alertele automate |
| `/sterge` | invitați | șterge datele salvate (cu confirmare) |
| `/status` | proprietar | starea checker-ului, cererile ASP de azi, invitații |
| `/utilizatori`, `/cereri` | proprietar | persoanele aprobate / toate cererile de acces |
| `/revoca <chat_id>` | proprietar | retrage accesul și șterge datele unei persoane |

## Cum funcționează

```
GitHub Actions (buclă la 65 min) ──► src/index.js ──► ASP API ──► alerte Telegram (proprietar)
              │
              └─► POST /api/notify-guests (Vercel) ──► alerte Telegram (invitați)

Telegram ──► /api/telegram-webhook (Vercel) ──► /acum, /setari, înregistrare, aprobări
```

Botul folosește direct API-ul JSON al portalului `eservicii.gov.md/asp/dimtcca` (cel folosit de
pagina de programare), fără browser headless. Pentru fiecare categorie:

1. `GET /apo-request/get-service/{tip}/False[/{categorie}]` → ID-ul serviciului
2. `GET /qmatic/locations/{serviceId}` → ID-ul filialei
3. `POST /qmatic/dates` → zilele libere (~3 luni înainte), cu numărul de locuri

Urgența nu e un parametru boolean, ci un tip de examen separat (`TheoreticalUrgentExam`,
`PracticalUrgentExam`); varianta „evidentă” (`TheoreticalExam/True`) răspunde fără eroare, dar cu
calendarul altui serviciu.

**Verificarea periodică** rulează pe GitHub Actions. Programarea `schedule` din GitHub e prea
nesigură (în practică 4-6 rulări pe zi), așa că un job rulează în buclă (`scripts/ci-loop.sh`) la
fiecare 65 de minute, ~5 ore, apoi își pornește singur succesorul. Starea (cea mai devreme dată pe
categorie) e salvată în `state/slots.json`, comis înapoi în repo.

**Comenzile** ajung printr-un webhook Telegram la o funcție serverless pe Vercel, deci răspunsul e
aproape instant.

## Limita zilnică ASP

ASP acceptă un număr limitat de cereri `qmatic/dates` pe zi **per IDNP** (observat: ~180-200),
apoi răspunde cu HTTP 429 până la 00:00 UTC (03:00 la Chișinău, ora de vară). O verificare
completă costă 8 cereri, de aici cadența de 65 de minute (176 de cereri pe zi), care lasă puțin loc
pentru `/acum` pe același IDNP.

La primul 429, botul nu mai reîncearcă: trimite un singur mesaj de pauză și nu mai face nicio
cerere pentru acel IDNP până la resetare. Fiecare utilizator are propria cotă, pe propriul IDNP.

## Confidențialitate și securitate

- Datele invitaților (IDNP, seria și data buletinului) sunt **criptate AES-256-GCM** înainte să
  ajungă în Redis, cu o cheie (`USER_DATA_KEY`) păstrată separat; au TTL și se pot șterge oricând
  cu `/sterge`.
- Mesajele în care cineva își scrie datele sunt șterse din chat imediat după citire.
- Accesul altor persoane se acordă doar manual, de proprietar (butoane Aprobă / Respinge).
- Webhook-ul și endpoint-urile interne verifică un secret, comparat în timp constant.
- Botul iese automat din orice grup: e gândit doar pentru chat privat.
- Datele proprietarului stau doar în secretele GitHub / Vercel, niciodată în repo.

## Instalare

Ai nevoie de Node.js ≥ 20.6, un bot Telegram (de la [@BotFather](https://t.me/BotFather)), un
cont GitHub și, pentru comenzi și invitați, un cont Vercel și o bază Redis (Redis Cloud, Upstash
etc.).

### 1. Local (o singură verificare)

```bash
cp .env.example .env    # IDNP, seria/numărul buletinului, data emiterii, token + chat id
npm run check           # = node --env-file=.env src/index.js
```

Checker-ul nu are dependențe; `npm install` e necesar doar pentru funcțiile Vercel (`redis`).

### 2. Verificarea periodică (GitHub Actions)

Settings → Secrets and variables → Actions:

| Secret | Descriere |
|---|---|
| `ASP_IDNP` | IDNP-ul persoanei care dă examenul |
| `ASP_DOC_SERIES` | seria + numărul buletinului, fără spații |
| `ASP_DOC_ISSUE_DATE` | data emiterii, format `YYYY-MM-DDTHH:mm:ss` |
| `TELEGRAM_BOT_TOKEN` | tokenul botului |
| `TELEGRAM_CHAT_ID` | chat-ul tău cu botul (destinatarul alertelor) |
| `NOTIFY_SECRET` | șir random; aceeași valoare ca în Vercel |

Workflow-ul `.github/workflows/check.yml` pornește singur (lanțul se reia și din cron-ul de
siguranță). Rulare manuală din tab-ul Actions, cu parametrii `loop_minutes`, `interval_seconds` și
`chain` (`false` = o singură buclă, pentru test).

### 3. Comenzi și invitați (Vercel)

Importă repo-ul ca proiect Vercel (fără build; funcțiile sunt în `api/`) și adaugă variabilele de
mai sus, plus:

| Variabilă | Descriere |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | șir random; Telegram îl trimite înapoi la fiecare cerere |
| `REDIS_URL` | connection string Redis (`rediss://` dacă providerul oferă TLS) |
| `USER_DATA_KEY` | 32 bytes random în base64, cheia de criptare a datelor invitaților |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # USER_DATA_KEY
```

Apoi, o singură dată:

1. Dezactivează Vercel Authentication / Deployment Protection pe proiect (altfel Telegram primește 401).
2. Înregistrează webhook-ul:
   `POST https://api.telegram.org/bot<TOKEN>/setWebhook` cu `url=https://<proiect>.vercel.app/api/telegram-webhook`
   și `secret_token=<TELEGRAM_WEBHOOK_SECRET>`.
3. `npm run set-commands` — meniul de comenzi din Telegram.
4. La @BotFather: `/setjoingroups` → Disable.

Fără `REDIS_URL`, botul merge doar pentru proprietar. Dacă schimbi `USER_DATA_KEY`, datele deja
salvate devin ilizibile și invitații trebuie să se reînregistreze.

## Structura proiectului

```
src/
├─ index.js         verificarea periodică a proprietarului (alertă, rezumat, limita ASP)
├─ check.js         verificarea unei persoane: fetch + diff + mesaje (comun proprietar/invitați)
├─ guests.js        notificările automate ale invitaților
├─ asp.js           clientul API ASP (cu retry, timeout, fără retry la 429)
├─ live.js          răspunsul la /acum
├─ state.js         starea și diff-ul „cea mai devreme zi”
├─ format.js        mesajele Telegram (MarkdownV2) și utilitarele de dată
├─ prefs.js         /setari
├─ status.js        /status
├─ registration.js  înregistrarea invitaților și textele de acces
├─ userStore.js     Redis: date criptate, acces, setări, limite
├─ telegram.js      clientul Telegram Bot API și tastaturile
├─ config.js        categoriile monitorizate și variabilele de mediu
└─ secret.js        comparare de secrete în timp constant
api/
├─ telegram-webhook.js   comenzile Telegram
├─ notify-guests.js      apelat din CI după fiecare verificare
└─ owner-prefs.js        setările proprietarului, pentru CI
scripts/
├─ ci-loop.sh            bucla de verificare din GitHub Actions
└─ set-commands.mjs      meniul de comenzi Telegram
state/slots.json         starea checker-ului, actualizată de CI
```

## Limitări

- Doar Chișinău și categoria B; practicul e fixat pe cutie manuală (`BMechanical` în
  `src/config.js`; `BAutomatic` există și a fost verificat).
- Cadența e limitată de cota zilnică ASP per IDNP, nu de infrastructură.
- API-ul ASP nu e public documentat: dacă portalul își schimbă structura, botul raportează eroarea
  (după 3 rulări eșuate la rând) în loc să spună „nu sunt locuri”.
- GitHub poate anula joburile; lanțul se reia din cron-ul de siguranță, cu o pauză de cel mult
  câteva ore.

## Depanare

- **Push-ul nu declanșează deploy pe Vercel** (plan Hobby, repo privat): autorul commit-ului
  trebuie să fie un email verificat pe contul GitHub care deține repo-ul. Alternativ:
  `vercel --prod --yes`.
- **„ASP a limitat cererile”**: cota zilnică a IDNP-ului e epuizată; botul reia singur după 03:00.
  Dacă se întâmplă des, crește `interval_seconds`.
- **Botul nu răspunde la comenzi**: verifică `TELEGRAM_WEBHOOK_SECRET` (aceeași valoare în Vercel
  și la `setWebhook`) și protecția de deployment din Vercel.

## Licență

[MIT](LICENSE). Folosește-l, copiază-l și adaptează-l liber; răspunderea pentru ce faci cu el, inclusiv
față de termenii portalului ASP, îți aparține.
