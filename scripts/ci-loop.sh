#!/usr/bin/env bash
# Bucla de verificare din CI: un singur job ruleaza `node src/index.js` + notificarile
# invitatilor la fiecare 15 minute, aliniat la :00/:15/:30/:45, timp de LOOP_MINUTES, apoi iese
# (pasul urmator din workflow porneste succesorul). De ce nu `schedule`: GitHub il executa doar
# de 4-6 ori pe zi chiar si setat mai des (masurat 29.09-17.10.2026).
#
# Variabile: LOOP_MINUTES (cat tine bucla), INTERVAL_SECONDS (implicit 900), NOTIFY_SECRET,
# plus cele ale lui src/index.js (ASP_*, TELEGRAM_*). Intoarce codul ultimei verificari, ca run-ul
# sa apara rosu daca ultima iteratie a esuat (toate categoriile au picat).

set -u

LOOP_SECONDS=$(( ${LOOP_MINUTES:-320} * 60 ))
INTERVAL=${INTERVAL_SECONDS:-900}
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

while true; do
  echo "=== iteratie $(date -u +%H:%M:%SZ) ==="

  # Codul se reia din git la fiecare iteratie: un push nou intra in vigoare la urmatoarea
  # verificare, nu abia dupa ~5 ore, cand porneste urmatorul job.
  git pull --rebase --autostash -q origin master || echo "WARN: pull esuat, continui cu codul curent."

  node src/index.js
  LAST_RC=$?
  notify_guests

  # State-ul se comite cel mult o data pe ora (altfel ~96 commit-uri/zi). Un job intrerupt
  # pierde cel mult o ora de state, iar urmatorul reia de la ultimul commit.
  if (( SECONDS - LAST_COMMIT >= COMMIT_EVERY )); then
    commit_state
    LAST_COMMIT=$SECONDS
  fi

  # Urmatoarea iteratie, aliniata la un multiplu de INTERVAL; daca nu mai incape in fereastra, iesim.
  WAIT=$(( INTERVAL - $(date +%s) % INTERVAL ))
  if (( SECONDS - START + WAIT >= LOOP_SECONDS )); then
    break
  fi
  sleep "$WAIT"
done

commit_state
exit "$LAST_RC"
