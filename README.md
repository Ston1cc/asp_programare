# asp_programare

Monitorizează disponibilitatea locurilor pentru examenul auto la ASP (DECA Chișinău,
str. Salcâmilor 28) pentru 4 categorii — teoretic/practic × obișnuit/urgent — și trimite
notificări pe Telegram.

## Cum funcționează

Interoghează direct API-ul public al portalului `eservicii.gov.md/asp/dimtcca` (descoperit
prin inspecția fluxului de programare APO01). Nu folosește browser headless — trei cereri
HTTP simple per categorie:

1. `GET /apo-request/get-service/{tip}/{urgent}[/{categorie}]` → service ID
2. `GET /qmatic/locations/{serviceId}` → id-ul locației DECA Chișinău
3. `POST /qmatic/dates` → zilele libere (± ~3 luni), cu numărul de locuri pe zi

Rulează la fiecare 2 ore prin GitHub Actions. Ține minte cea mai devreme zi liberă per
categorie și trimite:

- **alertă imediată** când apare o zi *mai devreme* decât minimul cunoscut (evenimentul
  important — semnalează că poți programa mai repede)
- alertă normală pentru zile noi mai târzii
- **rezumat zilnic** la 08:00 (Europe/Chisinau) cu situația completă

Monitorul **doar citește**. Nu plătește, nu rezervă, nu depune nicio cerere.

## Configurare locală

```bash
cp .env.example .env
# completează .env cu IDNP, seria buletinului, data emiterii, token + chat id Telegram
node --env-file=.env src/index.js
```

## Configurare CI (GitHub Actions)

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

## Structură

```
src/
├─ index.js     orchestrator
├─ asp.js       client API ASP (service id → locație → zile)
├─ config.js    categorii monitorizate + validare env
├─ state.js     persistență + diff (inclusiv logica de "cea mai devreme zi")
├─ format.js    mesaje Telegram + utilitare de dată (fus Europe/Chisinau)
└─ telegram.js  client Telegram Bot API
state/slots.json   stare persistată, comisă înapoi în repo de CI
```

## Note

- Categoria practică e fixată pe **B, cutie mecanică** (`BMechanical`) — se schimbă în
  `src/config.js` dacă e nevoie de altă categorie.
- Dacă ASP blochează IP-urile de datacenter ale GitHub Actions, același cod rulează
  identic local (Task Scheduler / cron), doar trigger-ul se schimbă.
