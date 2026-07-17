# bsky-sync

mirrors your twitter/x account to bluesky so you can be active there without ever opening the app. reads your tweets through [emusks](https://emusks.tiago.zip/) (no paid twitter api, just your own auth cookie), posts them to bluesky, and keeps a little sqlite db of tweet id → bluesky post mappings so threads and self quotes stay wired up correctly.

## what it syncs

- normal tweets, text goes over as is, long ones get split into a reply chain
- images (up to 4, same as bluesky's cap) and videos, gifs post as gifs
- quote tweets of YOURSELF become real bluesky quote posts, pointing at the already-mirrored post
- quote tweets of other people get rendered into a screenshot card (headless chromium) and attached as an image, and if the quoted tweet has a video it uploads the actual video instead
- replies to YOURSELF thread onto the mirrored parent on bluesky, replies to other people are skipped
- retweets are skipped
- deleting a tweet deletes the mirrored bluesky post on the next poll
- profile stuff: avatar, banner, bio, display name, and pinned tweet all follow twitter when they change

first run sets a baseline at your newest tweet and only syncs stuff after that, no backfill.

## setup

you need two credentials, both go in `.env`:

```
cp .env.example .env
```

**twitter auth token** — sign in at x.com, hit F12, Application tab, Cookies, `https://x.com`, copy the `auth_token` cookie value into `TWITTER_AUTH_TOKEN`. set `TWITTER_USERNAME` to your handle without the @. thats it, the syncer is read only on the twitter side.

**bluesky app password** — bluesky settings, Privacy and Security, App Passwords, make one, put it in `BSKY_APP_PASSWORD`. set `BSKY_HANDLE` to your full handle (like `you.bsky.social`). dont use your real password, app passwords are revokable.

optional: `POLL_INTERVAL_SECONDS` (default 180) and `BSKY_SERVICE` if youre not on bsky.social.

## run it (docker)

```
docker compose up -d --build
```

done. state lives in `./data/sync.db` on the host, so rebuilding or updating the image never loses the tweet mappings. logs:

```
docker logs -f bsky-sync
```

it restarts itself unless you stop it, and starts back up with the docker daemon after a reboot.

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

## behavior notes

- one tweet failing wont block the rest forever, it retries a tweet 3 times then loudly gives up and moves on
- polls are capped at 20 posts each so a weird api response cant flood your bluesky
- tweet timestamps are preserved, mirrored posts show the original tweet time
- if you reply to or quote a tweet from before the baseline, theres no mapping for it, replies post standalone and quotes fall back to the screenshot card
- twitter can invalidate your auth_token whenever it feels like it (password change, logout, mood), if the logs start failing on login just grab a fresh cookie
