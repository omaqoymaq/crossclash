import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, generatePuzzle, validatePuzzle, publicView, SIZES } from '../generator/arrowword.mjs';

const lexicon = JSON.parse(fs.readFileSync(new URL('../generator/data/lexicon.json', import.meta.url))).words;
const index = buildIndex(lexicon);

for (const size of Object.keys(SIZES)) {
  test(`generates a valid ${size} puzzle deterministically`, () => {
    const a = generatePuzzle({ size, index, seed: 99 });
    const b = generatePuzzle({ size, index, seed: 99 });
    assert.ok(a, 'puzzle generated');
    assert.deepEqual(validatePuzzle(a, lexicon), []);
    assert.equal(a.id, b.id);
    assert.equal(a.w, SIZES[size].w);
    assert.ok(a.revealed.length >= 3);
    const pub = publicView(a);
    assert.ok(pub.clues.every((c) => !c.answer));
  });
}

test('shipped packs are valid and unique', () => {
  for (const size of Object.keys(SIZES)) {
    const pack = JSON.parse(fs.readFileSync(new URL(`../puzzles/${size}.json`, import.meta.url)));
    const ids = new Set();
    for (const p of pack.puzzles) {
      assert.deepEqual(validatePuzzle(p, lexicon), [], p.id);
      assert.ok(!ids.has(p.id));
      ids.add(p.id);
    }
  }
});
