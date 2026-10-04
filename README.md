# Basketball tracker

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

## Free throws

`+1` on the live tracker records one made free throw. It adds one point and
leaves the possession open. `+2`, `+3`, `EMPTY`, and `TOV` still end the
possession, and any `+1` taps since the previous ending button belong to the
possession those buttons close.

| What happened                             | What you tap                                                                | Result                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Both missed, other team has the ball      | `EMPTY`                                                                     | 0 points, 1 possession                     |
| One made, other team has the ball         | `+1`, then `EMPTY`                                                          | 1 point, 1 possession                      |
| Two made                                  | `+1`, `+1`, then `EMPTY`                                                    | 2 points, 1 possession                     |
| Three made                                | `+1` three times, then `EMPTY`                                              | 3 points, 1 possession                     |
| Makes, then Campus rebounds the last miss | `+1` for each make, `OFF REB`, then the later `+2`, `+3`, `EMPTY`, or `TOV` | those points plus the finish, 1 possession |
| And-1, free throw made                    | `+1`, then `+2` or `+3`                                                     | basket plus 1, 1 possession                |
| And-1, free throw missed                  | `+2` or `+3` only                                                           | the basket, 1 possession                   |

Tap `EMPTY` after made free throws when that possession is over and the other
team will have the ball. The points already tapped stay on that possession.
Tap `EMPTY` on its own when nothing went in.

If Campus rebounds the last miss, tap `OFF REB` instead of `EMPTY`. The
possession stays open until a later `+2`, `+3`, `EMPTY`, or `TOV`.

For an and-1, tap `+1` if the free throw scores, then tap `+2` or `+3` so the
basket closes the possession. If the free throw misses, tap only the basket.
If the basket was tapped before the free throw, undo it and tap in that order.

The live score goes up on `+1`. The possession count and points per possession
go up when the possession is closed. A `+1` that is never closed stays in the
score and is left out of the possession count.

`+1` is stored as event type `FT` with 1 point. It is not a record of a
missed shot. A trip that produces no points is still `EMPTY`.
