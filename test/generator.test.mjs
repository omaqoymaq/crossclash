import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, generatePuzzle, validatePuzzle, publicView, SIZES } from '../generator/arrowword.mjs';

const lexicon = JSON.parse(fs.readFileSync(new URL('../generator/data/lexicon.json', import.meta.url))).words;
const index = buildIndex(lexicon, { handOnly: true });

for (const size of Object.keys(SIZES)) {
  test(`generates a valid ${size} puzzle deterministically`, () => {
    // a seed can occasionally fail (the CLI just moves on); find one that works
    let seed = 99, a = null;
    while (!a && seed < 110) a = generatePuzzle({ size, index, seed: seed++ });
    const b = generatePuzzle({ size, index, seed: seed - 1 });
    assert.ok(a, 'puzzle generated');
    assert.deepEqual(validatePuzzle(a, lexicon), []);
    assert.equal(a.id, b.id);
    assert.equal(a.w, SIZES[size].w);
    assert.ok(a.revealed.length >= 3);
    const pub = publicView(a);
    assert.ok(pub.clues.every((c) => !c.answer));
  });
}

test('shipped packs are valid, unique and fully hand-clued', () => {
  for (const size of Object.keys(SIZES)) {
    const pack = JSON.parse(fs.readFileSync(new URL(`../puzzles/${size}.json`, import.meta.url)));
    const ids = new Set();
    for (const p of pack.puzzles) {
      assert.deepEqual(validatePuzzle(p, lexicon), [], p.id);
      for (const c of p.clues) assert.ok(lexicon[c.answer].hand, `${c.answer} needs a hand-written clue`);
      assert.ok(!ids.has(p.id));
      ids.add(p.id);
    }
  }
});
