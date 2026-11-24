# Puzzle format

`puzzles/<size>.json` = `{ size, count, puzzles: [Puzzle] }`.

```jsonc
{
  "id": "R1a2b3c4d",          // size letter + hash of the solution grid (uniqueness key)
  "size": "regular",          // regular 9×9 · large 11×12 · xl 13×15 (max word length 7 / 6 / 6, plus long anchors)
  "w": 9, "h": 9,
  "rows": ["#H#G#B#G#", "CAMERA#OD", ...],   // '#' = clue square, letters = solution
  "clues": [{
    "id": 0, "at": [0,0],      // clue square
    "arrow": "downRight",      // right | down | downRight | rightDown
    "dir": "across", "start": [1,0], "len": 6,
    "answer": "CAMERA", "text": "Photographic equipment",
    "options": ["Photographic equipment", "Snapper", "Lens"],  // every hand-written clue; one is picked per game
    "anchor": true             // only on the long anchor words
  }],
  "revealed": [[3,4], ...],   // starter letters shown at the beginning
  "stats": { "words": 31, "tiles": 48, "bag": {"A": 6, ...}, "seed": 1000 }
}
```

Players never receive `answer` or the solution letters during a game (see `viewFor` in `public/js/engine.js`).

## Long anchor words

Each puzzle is built around long words (8 to 10 letters) placed before the rest of the grid:
Regular 2, Large 4, ExtraLarge 5. Anchors never run parallel on neighbouring lines, and at most one
pair of anchors crosses in a Large or ExtraLarge grid, because crossings between long words choke the
fill. ExtraLarge was asked for 12; tests on a 13×15 arrowword showed 5 fills reliably (about 10 s per
puzzle), 6 fills only about half the time even with three crossings allowed, and 8 or more never
fills. More hand-clued long words would raise that ceiling a little, not to 12.

## Clue rotation

`options` holds every hand-written clue for the answer (3 to 5). At the start of a game
`pickClues` in `public/js/engine.js` chooses one per clue, preferring options this player has not met:
the browser keeps hashes of clue texts it has shown (`cc.seenClues`, last 2,000). In rooms both
players send their hashes and the server avoids clues either has seen.

## Special puzzles

`public/puzzles/special-<theme>.json` holds one solo puzzle built from `generator/data/themes/<theme>.txt`:

    node generator/cli.mjs --theme thanksgiving --size large --title "Thanksgiving special" --max-gaps 10
    # add themed clues for any gap words it lists to the theme file, then
    node generator/cli.mjs --retheme thanksgiving

Long words always come from the theme. Short gap words may come from the main word list, and
`--retheme` gives them the themed clues you wrote, so every clue in the puzzle is on theme.
