# roadsignmath.xyz

Road Sign Math is a road trip game. Find a road sign whose numbers make a true
equation, photograph it, write the math, and post it. Driving + Math = Fun.

This repo is the website and the server behind it. The server keeps the signs,
their photos and the players' accounts. The website shows every sign without
an app: the map, a page for each sign and a page for each player. There is no
sign-in on the website; playing happens in the
[iPhone app](https://github.com/jthingelstad/roadsignmath-ios).

Being built. roadsignmath.xyz still serves the 2021-2025 micro.blog until the
first deploy.

## What's here so far

- The data model: signs, the ways people found to make them true, and players.
  No scores.
- The equation checker. A way counts when the math is true and its numbers come
  from the sign. `contracts/equation-vectors.json` holds the cases the server and
  the app both pass.
- A read-only API at `/api/v1`: the latest signs, signs near a point, one sign
  and its ways, the map, and the players. It's described in OpenAPI 3.1 at
  [`contracts/api-surface.json`](contracts/api-surface.json) and served at
  `/api/v1/openapi.json`.

## Running it

Node 24.

```sh
npm ci
npm run dev      # http://localhost:8787/api/v1
npm run verify   # format, lint, types and tests
```

## License

MIT. See [`LICENSE`](LICENSE).
