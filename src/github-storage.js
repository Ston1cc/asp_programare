// Citire/scriere a state/users.json prin GitHub Contents API -- folosit DOAR de webhook
// (api/telegram-webhook.js). Webhook-ul, spre deosebire de src/index.js, nu ruleaza pe un
// checkout de git persistent (functie serverless efemera pe Vercel), deci nu poate citi/scrie
// fisierul local si apoi "git commit && git push" ca in check.yml -- singura cale de a
// persista o inregistrare venita live, chiar in momentul in care userul scrie botului, e prin
// API-ul GitHub direct.

const GITHUB_API = 'https://api.github.com';
const USERS_PATH = 'state/users.json';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Intoarce { users, sha }. `sha` e null daca fisierul nu exista inca (prima inregistrare). */
export async function readUsers({ token, repo, branch }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${USERS_PATH}?ref=${branch}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return { users: {}, sha: null };
  if (!res.ok) throw new Error(`GitHub Contents API (get) a esuat: HTTP ${res.status}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { users: JSON.parse(content), sha: data.sha };
}

async function writeUsersOnce({ token, repo, branch, users, sha, message }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${USERS_PATH}`;
  const body = {
    message,
    branch,
    content: Buffer.from(JSON.stringify(users, null, 2) + '\n', 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  return fetch(url, { method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body) });
}

/**
 * Scrie state/users.json cu rezultatul lui `mutate(currentUsers) -> newUsers`. Citeste sha-ul
 * curent chiar inainte de scriere (optimistic locking al Contents API) -- daca doi useri se
 * inregistreaza suficient de aproape incat sha-ul s-a schimbat intre citire si scriere, GitHub
 * raspunde 409, caz in care reincercam o singura data cu sha-ul proaspat. Suficient la scara
 * asta (inregistrari ocazionale, nu trafic concurent real).
 */
export async function updateUsers({ token, repo, branch }, mutate, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { users, sha } = await readUsers({ token, repo, branch });
    const nextUsers = mutate(users);
    const res = await writeUsersOnce({ token, repo, branch, users: nextUsers, sha, message });
    if (res.ok) return nextUsers;
    if (res.status !== 409 || attempt === 1) {
      const body = await res.text();
      throw new Error(`GitHub Contents API (put) a esuat: HTTP ${res.status} — ${body}`);
    }
  }
}
