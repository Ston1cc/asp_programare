#!/usr/bin/env bash
# Bucla de verificare din CI: un singur job ruleaza `node src/index.js` + notificarile
# invitatilor la fiecare INTERVAL_SECONDS (implicit 600 = 10 min) timp de LOOP_MINUTES, apoi
# iese (pasul urmator din workflow porneste succesorul). De ce nu `schedule`: GitHub il executa
# doar de 4-6 ori pe zi chiar si setat mai des (masurat 29.09-17.10.2026).
#
# De ce era 65 min (acum 10, la cererea proprietarului): ASP limiteaza cererile pe IDNP, zilnic. 18.10.2026 limita a inceput sa respinga la
# a 182-a cerere a zilei (181 acceptate), cu verificari la 15 min (768 cereri/zi). La 65 min erau
# 22 rulari x 8 = 176 cereri/zi.
#
# Cadenta adaptiva: dupa fiecare rulare, src/index.js poate scrie `nextIntervalSeconds` in
# state/slots.json (mai des in orele in care apar de obicei locuri, vezi src/stats.js); fara el
# (sau cu ADAPTIVE_CADENCE=off) se foloseste INTERVAL_SECONDS.
#
# Variabile: LOOP_MINUTES (cat tine bucla), INTERVAL_SECONDS, NOTIFY_SECRET, plus cele ale lui
# src/index.js (ASP_*, TELEGRAM_*). Intoarce codul ultimei verificari, ca run-ul sa apara rosu
# daca ultima iteratie a esuat (toate categoriile au picat).

set -u

LOOP_SECONDS=$(( ${LOOP_MINUTES:-320} * 60 ))
INTERVAL=${INTERVAL_SECONDS:-600}
COMMIT_EVERY=3600
NOTIFY_URL="https://asp-programare-webhook.vercel.app/api/notify-guests"

START=$SECONDS
LAST_COMMIT=$SECONDS
LAST_RC=0

git config user.name "asp-programare-bot"
git config user.email "actions@users.noreply.github.com"

commit_state() {
  git add state/slots.json
  git diff --staged --quiet && return 0
  git commit -q -m "state: update [skip ci]"
  # --autostash: codul se reia din git la fiecare iteratie (vezi mai jos), nu vrem sa blocheze un pull.
  if git pull --rebase --autostash -q origin master && git push -q origin master; then
    return 0
  fi
  echo "WARN: nu am putut trimite commit-ul de state; se reincearca la urmatoarea salvare."
}

notify_guests() {
  local body=state/slots.json
  if [ ! -f "$body" ]; then
    echo '{}' > "${RUNNER_TEMP:-/tmp}/empty.json"
    body="${RUNNER_TEMP:-/tmp}/empty.json"
  fi
  # Un esec aici nu opreste bucla: proprietarul si-a primit deja verificarea.
  curl -sS --fail-with-body --max-time 150 -X POST \
    -H "Authorization: Bearer ${NOTIFY_SECRET:-}" \
    -H "Content-Type: application/json" \
    --data-binary "@$body" \
    "$NOTIFY_URL" || echo "WARN: notify-guests a esuat."
  echo
}

# Secunde de asteptat inainte de prima iteratie: daca job-ul precedent a rulat acum mai putin de
# INTERVAL (predare intre doua joburi, sau un `schedule` care cade imediat dupa), nu facem o a doua
# verificare in aceeasi fereastra -- ar irosi 8 cereri din cota zilnica. `lastRun` din state/slots.json
# e fresh: job-ul precedent il comite la final, inainte ca acesta sa faca checkout.
# Intervalul scris de ultima rulare in state/slots.json (60..7200 s), sau nimic.
next_interval() {
  node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('state/slots.json', 'utf8'));
      const v = Number(s.nextIntervalSeconds);
      if (Number.isFinite(v) && v >= 60 && v <= 7200) console.log(Math.round(v));
    } catch {}
  "
}

initial_wait() {
  node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync('state/slots.json', 'utf8'));
      const last = s.lastRun ? Date.parse(s.lastRun) : NaN;
      if (Number.isNaN(last)) process.exit(0);
      const v = Number(s.nextIntervalSeconds);
      const iv = Number.isFinite(v) && v >= 60 && v <= 7200 ? v : ${INTERVAL};
      const wait = Math.ceil((last + iv * 1000 - Date.now()) / 1000);
      console.log(Math.max(0, Math.min(wait, iv)));
    } catch { process.exit(0); }
  "
}

WAIT0=$(initial_wait)
if [ -n "${WAIT0:-}" ] && [ "$WAIT0" -gt 0 ]; then
  echo "Ultima verificare e recenta -- astept ${WAIT0}s inainte de prima iteratie."
  sleep "$WAIT0"
fi

while true; do
  ITER_START=$(date +%s)
  echo "=== iteratie $(date -u +%H:%M:%SZ) ==="

  # Codul se reia din git la fiecare iteratie: un push nou intra in vigoare la urmatoarea
  # verificare, nu abia dupa ~5 ore, cand porneste urmatorul job.
  git pull --rebase --autostash -q origin master || echo "WARN: pull esuat, continui cu codul curent."

  node src/index.js
  LAST_RC=$?
  notify_guests

  # State-ul se comite cel mult o data pe ora (altfel un commit la fiecare iteratie). Un job
  # intrerupt pierde cel mult o ora de state, iar urmatorul reia de la ultimul commit.
  if (( SECONDS - LAST_COMMIT >= COMMIT_EVERY )); then
    commit_state
    LAST_COMMIT=$SECONDS
  fi

  # Urmatoarea iteratie la NEXT secunde dupa inceputul acesteia (adaptiv sau INTERVAL); daca nu mai
  # incape in fereastra, iesim.
  NEXT=$(next_interval)
  NEXT=${NEXT:-$INTERVAL}
  WAIT=$(( NEXT - ($(date +%s) - ITER_START) ))
  (( WAIT < 0 )) && WAIT=0
  if (( SECONDS - START + WAIT >= LOOP_SECONDS )); then
    break
  fi
  sleep "$WAIT"
done

commit_state
exit "$LAST_RC"
