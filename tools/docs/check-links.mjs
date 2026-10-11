// Checks the internal links of the built documentation: every link to a
// page of the site leads to a page, and every anchor to a heading of that
// page. Usage: node tools/docs/check-links.mjs [apps/docs/dist]
// Exits with 1 when a link is broken. The pages of the API reference,
// generated, are checked as targets only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'apps/docs/dist';
const base = '/fdw-engine/';

const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (path.endsWith('.html')) {
      pages.push(path);
    }
  }
};
walk(root);

// The file of a link to the site, or undefined.
const fileOf = (href) => {
  const path = join(root, decodeURI(href.slice(base.length)));
  if (existsSync(path) && statSync(path).isFile()) {
    return path;
  }
  const index = join(path, 'index.html');
  return existsSync(index) ? index : undefined;
};

// The ids of a page, read once.
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = readFileSync(file, 'utf8');
    ids.set(
      file,
      new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
    );
  }
  return ids.get(file);
};

const broken = [];
for (const page of pages) {
  if (page.includes('/api/')) {
    continue;
  }
  const html = readFileSync(page, 'utf8');
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (!href.startsWith(base)) {
      continue;
    }
    const [path, anchor] = href.split('?')[0].split('#');
    const file = fileOf(path);
    const where = page.slice(root.length);
    if (!file) {
      broken.push(`${href} in ${where}: no such page`);
    } else if (anchor && !idsOf(file).has(decodeURIComponent(anchor))) {
      broken.push(`${href} in ${where}: no such anchor`);
    }
  }
}

console.log(`${pages.length} pages, ${broken.length} broken links`);
for (const line of broken) {
  console.log(`  ${line}`);
}
process.exit(broken.length > 0 ? 1 : 0);
