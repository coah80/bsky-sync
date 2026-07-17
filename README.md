# bsky-sync

mirrors your twitter/x account to bluesky so you can be active there without opening the app. reads your tweets through [emusks](https://emusks.tiago.zip/), posts them to bluesky, and keeps a sqlite db of tweet id → bluesky post mappings so threads and self quotes can sync up nicely with a little bow on top 🎀.

syncs tweets, media, self quotes, self replies, deletions, and profile changes. quotes of other people get attached as a screenshot card, or the video if thats what got quoted. retweets and replies to other people are skipped. no backfill, it starts at your newest tweet.

## setup

you need two credentials, both go in `.env`:

```
cp .env.example .env
```

**twitter auth token** — sign in at x.com, hit F12, Application tab, Cookies, `https://x.com`, copy the `auth_token` cookie value into `TWITTER_AUTH_TOKEN`. set `TWITTER_USERNAME` to your handle without the @. the syncer is read only on the twitter side. twitter invalidates this token on password changes, logouts, and sometimes for no visible reason, if login starts failing grab a fresh cookie.

**bluesky app password** — bluesky settings, Privacy and Security, App Passwords, make one, put it in `BSKY_APP_PASSWORD`. set `BSKY_HANDLE` to your full handle (like `you.bsky.social`). dont use your main password, app passwords are revokable.

optional: `POLL_INTERVAL_SECONDS` (default 180) and `BSKY_SERVICE` if youre not on bsky.social.

## run it (docker)

```
docker compose up -d --build
```

state lives in `./data/sync.db` on the host, so rebuilding or updating the image never loses the tweet mappings. logs:

```
docker logs -f bsky-sync
```

it restarts unless you stop it, and comes back up with the docker daemon after a reboot.

### verify it works before letting it loose

```
docker compose run --rm bsky-sync node src/index.js --once --dry-run
```

logs into both sides, fetches, builds the posts, uploads NOTHING and doesnt move the checkpoint. if that looks right, `docker compose up -d`.

theres also an offline render test that needs zero credentials, good for checking chromium works:

```
docker compose run --rm bsky-sync node src/index.js --render-test
```

## run it (bare node)

needs node 24+.

```
npm install
npx playwright install chromium
npm start
```

same flags apply, `node src/index.js --once` for a single poll, `--dry-run` to not post.

## tests

```
npm test
```

or in docker: `docker compose run --rm bsky-sync npm test`
