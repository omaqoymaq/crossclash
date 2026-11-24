# Puzzle format

`puzzles/<size>.json` = `{ size, count, puzzles: [Puzzle] }`.

```jsonc
{
  "id": "R1a2b3c4d",          // size letter + hash of the solution grid (uniqueness key)
  "size": "regular",          // regular 9×9 · large 11×12 · xl 13×15
  "w": 9, "h": 9,
  "rows": ["#H#G#B#G#", "CAMERA#OD", ...],   // '#' = clue square, letters = solution
  "clues": [{
    "id": 0, "at": [0,0],      // clue square
    "arrow": "downRight",      // right | down | downRight | rightDown
    "dir": "across", "start": [1,0], "len": 6,
    "answer": "CAMERA", "text": "Photographic equipment"
  }],
  "revealed": [[3,4], ...],   // starter letters shown at the beginning
  "stats": { "words": 31, "tiles": 48, "bag": {"A": 6, ...}, "seed": 1000 }
}
```

Players never receive `answer` or the solution letters during a game (see `viewFor` in `public/js/engine.js`).
