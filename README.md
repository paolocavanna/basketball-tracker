# basketball-tracker

## Local development

```sh
npm install
npm ci --prefix frontend
npm run dev
```

`/api/*` is served by the Cloudflare Pages Functions in production, and Vite has
no Functions runtime. The dev server therefore mounts those same Functions
locally (see `frontend/dev/localApi.js`) against a libSQL file in
`frontend/.dev-data/api.db`, which `db/schema.sql` creates on first run. Games
played locally survive a restart; delete that directory to start from scratch.

`npm run preview` does the same against a production build. Nothing in
`frontend/dev/` is deployed or bundled, and Turso is never contacted locally.
