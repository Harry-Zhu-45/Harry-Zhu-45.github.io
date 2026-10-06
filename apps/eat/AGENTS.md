# Eat web maintenance

Source paths and `npm test` are relative to `apps/eat/`. Publishing paths
(`public/eat/`) and `npm run sync:eat` are relative to the repository root.

- Edit source here and regenerate `public/eat/` with the root `npm run sync:eat`; keep generated output out of manual edits.
- `index.html` is a template. Its legacy script anchor is replaced by `tools/prepare_pwa.py`; validate the generated page rather than opening the template directly.
- Preserve relative asset URLs and service-worker scope for hosting at `/eat/`.
- Cache only the app shell. User records belong to IndexedDB; preserve the schemaVersion=2 JSON import/export contract.
- Keep SW activation under the existing user update flow to avoid interrupting unsaved edits.
- Regenerate `pwa/casefold.js` using `tools/generate_casefold.py` when changing the Unicode table.
- Run `npm test` in this directory after web changes, then regenerate the committed output. Root blog checks follow the parent instructions.
- Keep private SQLite databases and migration backups outside `public/` and Git.
