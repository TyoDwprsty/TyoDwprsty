/**
 * Generate branded GitHub stats cards as static SVG files.
 *
 * Runs inside GitHub Actions (.github/workflows/stats.yml) and writes:
 *   assets/stats/stats.svg
 *   assets/stats/languages.svg
 *
 * Local usage:
 *   GITHUB_TOKEN=xxx GH_USERNAME=yourname node scripts/generate-stats.mjs
 *   node scripts/generate-stats.mjs --mock         (sample data, no API call)
 *   node scripts/generate-stats.mjs --placeholder  (cards before the first run)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// [EDIT-S] KONFIGURASI KARTU STATISTIK
// ---------------------------------------------------------------------------
const CONFIG = {
  statsTitle: "GitHub Activity",
  languagesTitle: "Most Used Languages",
  maxLanguages: 6,
  // Bahasa yang tidak ingin ditampilkan, contoh: ["HTML", "CSS", "Dockerfile"]
  excludeLanguages: [],
  colors: {
    brand: "#CB2957",
    background: "#000000",
    text: "#FFFFFF",
    muted: "#BDBDBD",
    // Gradasi brand untuk bar bahasa, dari yang paling banyak dipakai
    languageShades: ["#CB2957", "#E3557D", "#9E1F43", "#F08DAA", "#73152F", "#F8C2D2"],
  },
};
// ---------------------------------------------------------------------------

const FONT =
  "'JetBrains Mono','Fira Code','Cascadia Code',Consolas,'SFMono-Regular',Menlo,'Liberation Mono',monospace";
const W = 440;
const H = 210;

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const formatNumber = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
};

// ---------------------------------------------------------------- data -----

const QUERY = `
query ($login: String!, $after: String) {
  user(login: $login) {
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
    }
    pullRequests { totalCount }
    issues { totalCount }
    repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        stargazerCount
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

async function graphql(token, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-stats" },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data?.user) throw new Error(`User "${variables.login}" not found`);
  return json.data.user;
}

async function fetchStats(token, login) {
  let after = null;
  let first = null;
  let stars = 0;
  const languageBytes = new Map();

  for (let page = 0; page < 20; page++) {
    const user = await graphql(token, { login, after });
    first ??= user;
    for (const repo of user.repositories.nodes) {
      stars += repo.stargazerCount;
      for (const { size, node } of repo.languages.edges) {
        languageBytes.set(node.name, (languageBytes.get(node.name) ?? 0) + size);
      }
    }
    if (!user.repositories.pageInfo.hasNextPage) break;
    after = user.repositories.pageInfo.endCursor;
  }

  const c = first.contributionsCollection;
  return {
    commits: c.totalCommitContributions + c.restrictedContributionsCount,
    pullRequests: first.pullRequests.totalCount,
    issues: first.issues.totalCount,
    repositories: first.repositories.totalCount,
    stars,
    contributedTo: first.repositoriesContributedTo.totalCount,
    languages: summarizeLanguages(languageBytes),
  };
}

function summarizeLanguages(bytes) {
  const excluded = new Set(CONFIG.excludeLanguages.map((l) => l.toLowerCase()));
  const entries = [...bytes].filter(([name]) => !excluded.has(name.toLowerCase())).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return [];
  // Percentages are relative to all non-excluded code, so the top list may sum to less than 100%.
  return entries.slice(0, CONFIG.maxLanguages).map(([name, v]) => ({ name, percent: (v / total) * 100 }));
}

const MOCK = {
  commits: 842,
  pullRequests: 57,
  issues: 23,
  repositories: 18,
  stars: 41,
  contributedTo: 9,
  languages: [
    { name: "TypeScript", percent: 46.2 },
    { name: "JavaScript", percent: 21.4 },
    { name: "PHP", percent: 12.8 },
    { name: "CSS", percent: 9.1 },
    { name: "Python", percent: 6.3 },
    { name: "Dockerfile", percent: 4.2 },
  ],
};

// -------------------------------------------------------------- render -----

let topo;
const icons = new Map();

async function loadAssets() {
  topo = JSON.parse(await readFile(path.join(ROOT, "scripts/topo-card.json"), "utf8"));
  for (const name of ["code", "stack", "bug", "layers", "star", "users-group"]) {
    const svg = await readFile(path.join(ROOT, `assets/icons/${name}.svg`), "utf8");
    icons.set(name, svg.replace(/<!--[\s\S]*?-->/g, "").trim());
  }
}

function icon(name, x, y, size = 16) {
  return icons
    .get(name)
    .replace(/\swidth="[^"]*"/, ` x="${x}" y="${y}" width="${size}"`)
    .replace(/\sheight="[^"]*"/, ` height="${size}"`)
    .replace(/\sstyle="[^"]*"/, "");
}

function frame(kind, title, body) {
  const { brand, background, text } = CONFIG.colors;
  const lines = topo[kind]
    .map((p) => `<path d="${p.d}" stroke-opacity="${p.bold ? 0.85 : 0.45}" stroke-width="${p.bold ? 1.4 : 0.8}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <clipPath id="clip"><rect width="${W}" height="${H}" rx="12"/></clipPath>
    <linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${background}" stop-opacity="0.7"/>
      <stop offset="1" stop-color="${background}" stop-opacity="0.85"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="${W}" height="${H}" fill="${background}"/>
    <g fill="none" stroke="${brand}" stroke-linejoin="round" opacity="0.5">${lines}</g>
    <rect width="${W}" height="${H}" fill="url(#fade)"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${brand}" stroke-opacity="0.45"/>
  <g font-family="${FONT}">
    <text x="24" y="40" font-size="17" font-weight="700" fill="${text}" letter-spacing="0.5">${escapeXml(title)}</text>
    <rect x="24" y="52" width="40" height="2" fill="${brand}"/>
    ${body}
  </g>
</svg>
`;
}

function renderStats(s) {
  const { text, muted } = CONFIG.colors;
  const rows = [
    ["code", "Commits (1y)", s.commits],
    ["stack", "Pull requests", s.pullRequests],
    ["bug", "Issues", s.issues],
    ["layers", "Repositories", s.repositories],
    ["star", "Stars earned", s.stars],
    ["users-group", "Contributed to", s.contributedTo],
  ];
  const body = rows
    .map(([ic, label, value], i) => {
      const x = i < 3 ? 24 : 232;
      const y = 86 + (i % 3) * 40;
      return `${icon(ic, x, y - 13)}
    <text x="${x + 26}" y="${y}" font-size="13" fill="${muted}">${label}</text>
    <text x="${x + 184}" y="${y}" font-size="15" font-weight="700" fill="${text}" text-anchor="end">${escapeXml(
      typeof value === "number" ? formatNumber(value) : value,
    )}</text>`;
    })
    .join("\n    ");
  return frame("stats", CONFIG.statsTitle, body);
}

function renderLanguages(langs) {
  const { text, muted, languageShades } = CONFIG.colors;
  if (!langs.length) {
    return frame("languages", CONFIG.languagesTitle, `<text x="24" y="110" font-size="13" fill="${muted}">No public code yet.</text>`);
  }
  const barX = 24;
  const barW = W - 48;
  let cursor = barX;
  const total = langs.reduce((sum, l) => sum + l.percent, 0);
  const segments = langs
    .map((l, i) => {
      const w = (l.percent / total) * barW;
      const seg = `<rect x="${cursor.toFixed(2)}" y="74" width="${Math.max(w, 0.5).toFixed(2)}" height="10" fill="${languageShades[i % languageShades.length]}"/>`;
      cursor += w;
      return seg;
    })
    .join("");
  const legend = langs
    .map((l, i) => {
      const x = i < 3 ? 24 : 232;
      const y = 122 + (i % 3) * 30;
      return `<rect x="${x}" y="${y - 10}" width="10" height="10" rx="2" fill="${languageShades[i % languageShades.length]}"/>
    <text x="${x + 18}" y="${y}" font-size="13" fill="${text}">${escapeXml(l.name)}</text>
    <text x="${x + 184}" y="${y}" font-size="13" fill="${muted}" text-anchor="end">${l.percent.toFixed(1)}%</text>`;
    })
    .join("\n    ");
  const body = `<defs><clipPath id="bar"><rect x="${barX}" y="74" width="${barW}" height="10" rx="5"/></clipPath></defs>
    <g clip-path="url(#bar)">${segments}</g>
    ${legend}`;
  return frame("languages", CONFIG.languagesTitle, body);
}

function renderPlaceholder(kind, title) {
  const { muted } = CONFIG.colors;
  return frame(
    kind,
    title,
    `<text x="24" y="112" font-size="13" fill="${muted}">Generated by GitHub Actions.</text>
    <text x="24" y="134" font-size="13" fill="${muted}">Run the "Update stats cards" workflow once.</text>`,
  );
}

// ---------------------------------------------------------------- main -----

async function main() {
  await loadAssets();
  const outDir = path.join(ROOT, "assets/stats");
  await mkdir(outDir, { recursive: true });
  const args = new Set(process.argv.slice(2));

  let statsSvg;
  let langSvg;
  if (args.has("--placeholder")) {
    statsSvg = renderPlaceholder("stats", CONFIG.statsTitle);
    langSvg = renderPlaceholder("languages", CONFIG.languagesTitle);
  } else {
    let data = MOCK;
    if (!args.has("--mock")) {
      const token = process.env.GITHUB_TOKEN;
      const login = process.env.GH_USERNAME;
      if (!token || !login) throw new Error("GITHUB_TOKEN and GH_USERNAME must be set");
      data = await fetchStats(token, login);
      console.log("Fetched stats:", JSON.stringify({ ...data, languages: data.languages.length }));
    }
    statsSvg = renderStats(data);
    langSvg = renderLanguages(data.languages);
  }

  await writeFile(path.join(outDir, "stats.svg"), statsSvg);
  await writeFile(path.join(outDir, "languages.svg"), langSvg);
  console.log("Wrote assets/stats/stats.svg and assets/stats/languages.svg");
}

main().catch((err) => {
  // Fail the job without touching existing cards, so the README never shows a broken image.
  console.error(err.message);
  process.exit(1);
});
