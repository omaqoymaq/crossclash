# CrossClash

A free, ad-free, browser-based **arrowword duel**. Two players race to fill the same pre-clued grid with letter tiles, either against a friend in a private 1v1 room (code or link) or against a clearly labelled bot. Grid sizes: Regular (9×9), Large (11×12), ExtraLarge (13×15). Rules: [docs/RULES.md](docs/RULES.md).

## What's in here

| Path | What it is |
|---|---|
| `generator/` | **Standalone puzzle generator.** No dependencies; runs in Node or a browser. `build-lexicon.mjs` builds the answer list (common words only) and attaches the hand-written clues in `generator/data/clues/*.txt`; `arrowword.mjs` builds and fills arrowword grids; `cli.mjs` makes puzzle packs. |
| `puzzles/` | Generated packs (full answers). Bundled into the server for rooms; never served publicly. |
| `public/` | The game (plain HTML/CSS/JS modules, no build step). `public/puzzles/solo-*.json` is the bot-mode subset. |
| `public/js/engine.js` | Game rules, shared by browser and server. |
| `public/js/bot.js` | The bot. |
| `worker/index.js` | Cloudflare Worker + Durable Object for private rooms. |
| `test/` | `npm test` (engine, bot, generator, pack validation). |

## Run locally

```bash
npm install
npm test
npm run dev          # http://localhost:8787  (bot mode + rooms, all local)
```

## Make more puzzles

```bash
npm run generate -- --size regular --count 100     # or large | xl | all
npm run generate -- --print --size xl              # preview one as text
```
New puzzles are appended; duplicates are skipped and words already common in the pack are avoided. Every 4th puzzle is copied to the public solo pack and excluded from rooms, so a room's answers never sit on the public site.

**Word and clue quality.** Answers come only from the ~12,000 most common English words (ranked by wordfreq, checked against WordNet so names and abbreviations drop out). By default the generator only uses answers that have a **hand-written clue** (about 4,800 today, each with 3 to 5 clues that rotate between games, in `generator/data/clues/*.txt`, one `WORD|Clue|Another clue` per line; lines for the same word merge). To improve or add clues: edit those files (or `blocklist.txt` to ban a word), run `npm run lexicon`, then `npm run generate -- --reclue` to refresh clue text in existing packs, or regenerate. `npm run generate -- --report` lists any answers still lacking a hand-written clue, and `node generator/tools/check-clues.mjs` flags clues that give their own answer away. Long anchor words, clue rotation and themed specials: [docs/PUZZLE-FORMAT.md](docs/PUZZLE-FORMAT.md).

## Deploy (free)

Hosting is one Cloudflare Worker on the **Workers Free plan**: static files are served free, and each room is a SQLite-backed Durable Object (available on the free plan) using WebSocket hibernation, so idle rooms cost nothing. Free limits (100k requests/day, Durable Object duration allowance) cover thousands of games a day; if exceeded, Cloudflare stops serving for the rest of the day rather than billing you.

```bash
npx wrangler login
npm run deploy        # prints https://crossclash.<your-subdomain>.workers.dev
```
Optional: attach your own domain in the Cloudflare dashboard (Workers → crossclash → Domains).

### Why Cloudflare
- Rooms need a small trusted server to hold the answers and check moves; peer-to-peer would let either player read the solution, and WebRTC still needs a signalling server.
- One provider for static site + realtime, no database to run, no servers to patch, and a free tier that doesn't expire. (PartyKit now runs on the same Durable Objects underneath.)

## Credits & licences
Clues are hand-written for CrossClash. The common-word ranking comes from **wordfreq** (data CC BY-SA 4.0, `generator/data/common-words.txt`), and **WordNet 3.0** © Princeton University (permissive licence, `generator/data/WORDNET-LICENSE`) is used to check that answers are real dictionary words. Game code: yours.
