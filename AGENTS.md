# AGENTS.md

## Development

Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

The dev server runs in the foreground; press Ctrl+C to stop it.

Scripts:

- `npm run build` — static build plus the Pagefind search index
- `npm run preview` — serve the built output
- `npm run check` — Astro and TypeScript diagnostics
- `npm run sync:eat` — regenerate `public/eat/` from the source PWA project (see below)

Commit hooks use [prek](https://prek.j178.dev/installation/): `prek install`, then `prek run --all-files`.
They flag merge-conflict markers and added files over 10 MiB.

## Content

Posts live in `src/content/blog/**/*.md`; the schema is in `src/content.config.ts`.

- **Frontmatter must be fenced with `---`.** Without the fences the build fails with
  `InvalidContentEntryDataError` listing `title`/`slug`/`pubDate` as required.
- **`slug` is required and used verbatim** — no slugify, no case folding. Convention: the slug
  equals the path under `src/content/blog/` without the extension, so a post's filename and slug
  must stay in sync (`src/content/blog/software/Obsidian.md` → slug `software/Obsidian`).
- **Dates carry an explicit `+08:00` offset** so local and CI builds agree on the date, and
  therefore on the `/YYYY/MM/DD/<slug>/` URL.
- **`software/` posts use `categories: []` and `tags: [软件]`.**

## URL contract

The site uses `build.format: 'directory'` and `trailingSlash: 'always'`; both are load-bearing
for the static paths. `urls-baseline.txt` holds 56 legacy addresses that must survive. After a
build:

```bash
find dist -name index.html | sed 's|^dist||; s|index.html$||' | sort > /tmp/new.txt
comm -23 urls-baseline.txt /tmp/new.txt
```

No output means every legacy URL is still served. New pages may exceed the baseline.

## Navigation and Swup

Nav entries come from `navBarConfig.links` in `src/config.ts`. Desktop (`src/components/Navbar.astro`)
and mobile (`src/components/widget/NavMenuPanel.astro`) share that one array, so any per-link
attribute must be added in both.

The site uses `@swup/astro`, which swaps `main` (and `#toc`) on link clicks. To force a real
full-page navigation for one link, set `data-no-swup` on the anchor — that is the only supported
mechanism, and it also stops the preload plugin.

**Render it with a ternary:** `data-no-swup={l.noSwup ? '' : undefined}`. `data-no-swup` is not in
Astro's `htmlBooleanAttributes` list, so a plain `data-no-swup={false}` renders the attribute as
`data-no-swup="false"` — still present, so `closest('[data-no-swup]')` matches and every nav link
becomes a full load. Put the attribute on the anchor itself, never on an ancestor.

## Search indexing (Pagefind)

Indexing is opt-in: only pages carrying `data-pagefind-body` are indexed. That attribute is on
`src/components/misc/Markdown.astro` and the post route, so archive, tag, and `public/` pages are
excluded automatically. A new page that should be searchable needs the attribute.

## Standalone sub-app: `public/eat/`

`public/eat/` is the built 「今天吃什么」 PWA, served at `/eat/` as a self-contained static app.

- **Never hand-edit it.** Regenerate with `npm run sync:eat`
  (`node scripts/sync-eat.mjs`, options `--source`, `--output`, `--check`).
- The script reads the source project (default `/home/mzhu/Desktop/what-should-we-eat`, override
  with `--source` or `EAT_SOURCE`), calls its own `tools/prepare_pwa.py`, verifies the 18-file
  whitelist, and swaps the result in atomically. The source project is read-only.
- The output is committed, so the GitHub Pages build never needs the source project. Its paths and
  service-worker scope are all relative, which is what makes the `/eat/` subpath work without edits.
- The nav entry for it uses `noSwup: true`; see the Swup section above.

## Documentation

Full documentation: <https://docs.astro.build>

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
