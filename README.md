# roadsignmath.xyz

Road Sign Math is a road trip game. Find a road sign whose numbers make a true
equation, photograph it, write the math, and post it. Driving + Math = Fun.

This repo is the website and the server behind it. The server keeps the signs,
their photos and the players' accounts. The website shows every sign without
an app: the map, a page for each sign and a page for each player. There is no
sign-in on the website; playing happens in the
[iPhone app](https://github.com/jthingelstad/roadsignmath-ios).

Being built. roadsignmath.xyz still serves the 2021-2025 micro.blog until the
first deploy. It will run on AWS: a Lambda Web Function behind CloudFront, with
DynamoDB, S3 for photos and SES for sign-in mail, released on every merge to
main ([`docs/DEPLOY.md`](docs/DEPLOY.md)).

## What's here so far

- The data model: signs, the ways people found to make them true, and players.
  No scores.
- The equation checker. A way counts when the math is true and its numbers come
  from the sign. `contracts/equation-vectors.json` holds the cases the server and
  the app both pass.
- An API at `/api/v1`: the latest signs, signs near a point, one sign
  and its ways, the map, and the players. It's described in OpenAPI 3.1 at
  [`contracts/api-surface.json`](contracts/api-surface.json) and served at
  `/api/v1/openapi.json`.
- Sign-in for the app: anyone can sign in with an email address, by tapping the
  link in the email or typing its 6-digit code. Players can set their name,
  bio and a profile photo (Claude looks at it first), and delete their account
  with everything they posted.
- Posting from the app: upload photos, post a sign with its numbers and its
  first way (or unsolved), add more ways to anyone's sign, delete your own,
  report a sign, block a player, see the ways and hearts others leave on your
  signs, and send feedback (it's emailed to us). Claude moderates: it holds a post only when
  it is clearly objectionable, looks again when someone reports one, and writes
  each photo's alt text.
- Badges: little road signs a player collects (first sign, states, a ×
  in a way, all four seasons, and five secret ones), shown on their player page
  and in the app. No counts and no ranks; they're worked out from the signs
  each time, so a badge follows its sign.
- Hearts: a ❤️ on every sign, from the website (Tinylytics' kudos button, no
  account) and from the app (signed in, one per player per sign), counted
  together in [Tinylytics](https://tinylytics.app). The app's screen views are
  counted there too, as the app's, with nothing about who.

- Feeds and open data, for anyone who wants to follow the signs or build
  something with them: Atom and JSON Feed of new signs (`/feed.xml`,
  `/feed.json`, and the same per player), `/signs.json`, `/players.json` and
  `/signs.geojson` (open to any web page), `/llms.txt` and `/llms-full.txt`.
  Every field is documented on the site at [`/data`](https://roadsignmath.xyz/data).

## Running it

Node 24.

```sh
npm ci
npm run seed -- --export <micro.blog export> --to local   # the 16 launch signs, into .data/
npm run dev      # http://localhost:8787/api/v1; sign-in emails land in .data/mail/ (.txt and .html)
                 # posts aren't moderated unless ANTHROPIC_API_KEY is set; hearts are off
npm run verify   # format, lint, types and tests
```

## License

MIT. See [`LICENSE`](LICENSE).
