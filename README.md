# asp_programare

Monitorizează disponibilitatea locurilor pentru examenul auto la ASP (Chișinău) pentru
8 targeturi — teoretic/practic × obișnuit/urgent, practic pe 3 filiale — și trimite
notificări pe Telegram. Include și o comandă la cerere (`/acum`) cu răspuns aproape
instant, prin webhook, plus `/setari` ca să alegi ce categorii/dată-țintă contează pentru
tine.

## Cum funcționează

Interoghează direct API-ul public al portalului `eservicii.gov.md/asp/dimtcca` (descoperit
prin inspecția fluxului de programare APO01). Nu folosește browser headless — trei cereri
HTTP simple per categorie:

1. `GET /apo-request/get-service/{tip}/{urgent}[/{categorie}]` → service ID
2. `GET /qmatic/locations/{serviceId}` → id-ul locației
3. `POST /qmatic/dates` → zilele libere (± ~3 luni), cu numărul de locuri pe zi

Proiectul are **două funcții Vercel**, cu roluri diferite, ambele declanșate din afara
Vercel (nu de programatorul lui intern — vezi mai jos de ce):

### 1. Verificarea periodică (`api/cron-check.js`, declanșată de un cron extern)

Ține minte cea mai devreme zi liberă per categorie (state în Redis, nu mai e comis în
repo) și trimite:

- **alertă imediată** când apare o zi *mai devreme* decât minimul cunoscut (evenimentul
  important — semnalează că poți programa mai repede), cu un buton „📝 Programează-te”
- alertă normală pentru zile noi mai târzii
- **rezumat zilnic** la 07:30 (Europe/Chisinau) cu situația completă (cele mai apropiate
  date per categorie + toate zilele + tabel comparativ pe filiale pentru proba practică)

Declanșată de un serviciu de cron **extern** (recomandat: [cron-job.org](https://cron-job.org),
gratuit) la fiecare ~10 minute, autentificat cu un secret trimis ca
`Authorization: Bearer <CRON_SECRET>`. **Nu Vercel Cron** — pe planul Hobby rulează cel
mult o dată pe zi, insuficient aici. Varianta inițială rula ca `src/index.js` pe GitHub
Actions, la fiecare 30 min prin `schedule` — înlocuită pentru că `schedule`-ul GH Actions
e doar best-effort (rulările reale au ajuns să sară 3-9 ore în vârf de trafic), ceea ce
întârzia exact semnalul pentru care există monitorul.

### 2. Comanda la cerere (`/acum`, `api/telegram-webhook.js`)

Scrii `/acum` (sau `/live`, `/status`, `/check`) botului și primești răspuns **instant**
(1-2 secunde), cu cele mai apropiate date la fiecare categorie, citite live, nu din cache.
`/setari` deschide o tastatură inline cu care activezi/dezactivezi teoretic/practic,
obișnuit/urgent, fiecare filială practică, sau setezi o dată-țintă („Până la”) — ce alegi
acolo filtrează atât `/acum` cât și alertele automate, dar **nu** oprește citirea acelor
categorii: sunt mereu citite, doar excluse din mesaje, ca reactivarea uneia mai târziu să
nu pară un fals „record”. O tastatură persistentă cu butoane e atașată la fiecare mesaj
trimis de bot (adaptată stării chatului — vezi mai jos), plus `/help` listează toate
comenzile disponibile. Comenzile mai apar și în meniul nativ Telegram (butonul „Menu” de
lângă câmpul de text, cu autocomplete la `/`) — setat o singură dată cu
`npm run set-commands`.

Arhitectural, asta e un webhook Telegram — nu polling. `api/telegram-webhook.js`, deployat
ca funcție serverless pe Vercel, e înregistrat direct la Telegram prin `setWebhook`, deci
Telegram trimite mesajul direct acolo de îndată ce-l scrii, fără nicio verificare
periodică. (Varianta inițială, cu polling la 5 minute prin GitHub Actions, a fost
înlocuită — un ciclu de verificare avea un plafon fizic de ~5 minute, uneori mai mult.)

**Alte persoane decât proprietarul** pot folosi același bot, dar în numele lor, nu al
proprietarului — însă doar dupã ce proprietarul le aprobă manual accesul. Prima dată
când scriu botului, primesc un mesaj că cererea a fost trimisă proprietarului; acesta
primește o notificare cu nume/@username/chat_id și două butoane, ✅ Aprobă / ❌ Respinge.
Abia după aprobare pot folosi `/inregistrare` ca să introducă pas cu pas propriul IDNP,
seria buletinului, data eliberării și **categoria de vehicul** (cutie manuală sau
automată la proba practică), printr-o conversație scurtă (`src/registration.js`) —
mesajele cu aceste date sunt șterse din chat imediat după ce botul le citește, ca să nu
rămână la vedere în istoric. Datele sunt salvate per `chat_id` în Redis, **criptate**
(AES-256-GCM, cheie separată de conexiunea la Redis — vezi `USER_DATA_KEY` mai jos), cu
TTL — 90 zile pentru date confirmate (reînnoit automat la fiecare `/acum` folosit, cât
timp chatul rămâne activ), 10 minute pentru o înregistrare abandonată la jumătate.
`/sterge` șterge datele salvate ale oricui le cere, oricând. Proprietarul poate oricând
vedea cine are acces (`/utilizatori`) sau revoca accesul cuiva (`/revoca <chat_id>`).
Botul iese singur din orice grup în care e adăugat — e gândit doar pentru chat privat,
ca nimeni altcineva să nu vadă datele scrise de altcineva.

Monitorul **doar citește**. Nu plătește, nu rezervă, nu depune nicio cerere.

## Configurare locală

```bash
cp .env.example .env
# completează .env cu IDNP, seria buletinului, data emiterii, token + chat id Telegram
node --env-file=.env src/index.js   # rulare locală a checkerului (npm run check)
npm test                            # rulează testele (node --test, zero dependențe suplimentare)
```

`src/index.js` e un runner local complementar checkerului real de pe Vercel — util pentru
o verificare manuală sau un Task Scheduler local (de ex. dacă ASP ajunge vreodată să
blocheze IP-urile de datacenter ale Vercel), nu mai e declanșat automat de nimic. State-ul
lui local (`state/slots.json`) e ignorat de git.

## Configurare Vercel (ambele funcții)

Repo-ul trebuie să fie **privat**. Ambele funcții au nevoie de aceleași variabile de bază:

| Env var | Descriere |
|---|---|
| `ASP_IDNP` | IDNP-ul persoanei care dă examenul (proprietarul) |
| `ASP_DOC_SERIES` | seria + numărul buletinului, fără spații |
| `ASP_DOC_ISSUE_DATE` | data emiterii buletinului, format `YYYY-MM-DDTHH:mm:ss` |
| `TELEGRAM_BOT_TOKEN` | token de la [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | id-ul chatului proprietarului |

Plus, pentru `api/cron-check.js` (verificarea periodică):

| Env var | Descriere |
|---|---|
| `CRON_SECRET` | șir random; cronul extern îl trimite ca `Authorization: Bearer <CRON_SECRET>` |
| `REDIS_URL` | **obligatoriu** aici — ține state-ul checkerului (`checker:state`) și lock-ul împotriva rulărilor suprapuse (`checker:lock`) |

Și, pentru `api/telegram-webhook.js`:

| Env var | Descriere |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | șir random; Telegram îl trimite înapoi pe fiecare cerere ca să dovedească faptul că e chiar el, nu oricine a ghicit URL-ul |
| `REDIS_URL` | opțional aici — doar dacă vrei ca *alte persoane* (nu proprietarul) să poată folosi botul, vezi mai jos |
| `USER_DATA_KEY` | obligatoriu împreună cu `REDIS_URL` — cheia cu care sunt criptate datele altor persoane înainte să ajungă în Redis |

`REDIS_URL` e un connection string standard (`redis://default:PAROLA@host:port`) — orice
provider merge (Redis Cloud, Upstash în mod TCP, self-hosted); preferă `rediss://` (TLS)
dacă provider-ul îl oferă. **Aceeași instanță Redis poate fi partajată** între cele două
funcții (chei diferite: `checker:*` vs `person:*`/`access:*`/`prefs:*`/`rl:*`).

`USER_DATA_KEY` trebuie să fie 32 bytes random, codați base64:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Dacă o schimbi ulterior, datele deja salvate în Redis devin ilizibile (tratate ca
inexistente) — persoanele afectate ar trebui să se reînregistreze.

`CRON_SECRET` poate fi orice șir random suficient de lung:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Pași de configurare (o singură dată)

1. Creează (sau conectează) proiectul Vercel `asp-programare-webhook`, cu **git
   auto-deploy** activat pe branch-ul `master` al acestui repo — spre deosebire de
   configurația inițială, nu mai e nevoie de redeploy manual la fiecare push.
   `api/telegram-webhook.js` și `api/cron-check.js` sunt amândouă funcții serverless în
   același proiect, fără build.
2. Setează toate variabilele de mediu de mai sus în proiect.
3. Dezactivează SSO/Vercel Authentication protection pe proiect — altfel Telegram (și
   cronul extern) nu pot ajunge la funcții (primesc 401 de la Vercel, nu de la codul
   nostru).
4. `POST https://api.telegram.org/bot<TOKEN>/setWebhook` cu `url` = URL-ul funcției
   `api/telegram-webhook` și `secret_token` = valoarea din `TELEGRAM_WEBHOOK_SECRET`.
5. Configurează un job pe [cron-job.org](https://cron-job.org) (sau alt serviciu de cron
   extern): URL = `https://<domeniul-tau>/api/cron-check`, metodă GET sau POST, header
   `Authorization: Bearer <CRON_SECRET>`, interval ~10 minute, timeout maxim disponibil.
6. `npm run set-commands` (o singură dată, sau de câte ori se schimbă lista de comenzi) —
   înregistrează comenzile în meniul nativ Telegram.
7. La [@BotFather](https://t.me/BotFather) → `/setjoingroups` → **Disable** — botul nu e
   gândit pentru grupuri (vezi mai sus); fără acest pas, botul tot iese singur din orice
   grup în care ajunge, dar dezactivarea din BotFather împiedică să fie adăugat deloc.

## Structură

```
src/
├─ index.js     runner local pentru verificarea periodică (folosește check.js + state.js)
├─ check.js     nucleul fetch+diff+heartbeat, partajat de index.js și cron-check.js
├─ live.js      interogare live + mesaj de răspuns, folosit de webhook ("/acum")
├─ prefs.js     filtrele /setari (ce apare în alerte/heartbeat, nu ce se citește)
├─ asp.js       client API ASP (service id → locație → zile)
├─ config.js    categorii+locații monitorizate (per vehicul) + validare env
├─ state.js     persistență + diff (inclusiv logica de "cea mai devreme zi")
├─ format.js    mesaje Telegram + utilitare de dată (fus Europe/Chisinau)
├─ telegram.js  client Telegram Bot API + tastaturi persistente/inline + setMyCommands
├─ secret.js    comparare de secrete in timp constant (webhook + cron)
├─ registration.js  flux conversațional (IDNP/serie/dată/vehicul) + mesajul /help
└─ userStore.js     persistență per chat_id (Redis): person/access/prefs/checker state
api/
├─ telegram-webhook.js   funcție serverless (Vercel) — răspunde la "/acum", "/setari" etc.
└─ cron-check.js         funcție serverless (Vercel) — verificarea periodică, cron extern
scripts/
└─ set-commands.mjs      înregistrează comenzile în meniul nativ Telegram (o singură dată)
test/                    node --test -- logică pură, fără rețea/Redis
state/slots.json         stare locală (npm run check) — gitignored, nu mai e sursa de adevăr
```

## Note

- Categoria practică e aleasă per persoană (cutie **manuală**/`BMechanical` sau
  **automată**/`BAutomatic`), implicit manuală — vezi `/inregistrare` pentru guests,
  `src/config.js`'s `buildCategories` pentru detalii.
- Dacă ASP blochează IP-urile de datacenter ale Vercel, verificarea periodică rulează
  identic local (`src/index.js`, Task Scheduler / cron); doar trigger-ul se schimbă.
