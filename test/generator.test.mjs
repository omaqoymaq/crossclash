import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, generatePuzzle, validatePuzzle, publicView, SIZES } from '../generator/arrowword.mjs';

const lexicon = JSON.parse(fs.readFileSync(new URL('../generator/data/lexicon.json', import.meta.url))).words;
const index = buildIndex(lexicon, { handOnly: true });

for (const size of Object.keys(SIZES)) {
  test(`generates a valid ${size} puzzle deterministically`, () => {
    // a seed can occasionally fail (the CLI just moves on); find one that works
    // ExtraLarge uses fewer anchors here to keep the test quick; the packs test checks the real count
    const opts = { size, index, maxTemplates: 2500, maxNodes: 3000, anchors: size === 'xl' ? 2 : undefined };
    let seed = 99, a = null;
    while (!a && seed < 110) a = generatePuzzle({ ...opts, seed: seed++ });
    const b = generatePuzzle({ ...opts, seed: seed - 1 });
    assert.ok(a, 'puzzle generated');
    assert.deepEqual(validatePuzzle(a, lexicon), []);
    assert.equal(a.id, b.id);
    assert.equal(a.w, SIZES[size].w);
    assert.ok(a.revealed.length >= 3);
    const anchors = a.clues.filter((c) => c.anchor);
    assert.equal(anchors.length, opts.anchors ?? SIZES[size].anchors, 'long anchor words');
    assert.ok(anchors.every((c) => c.len >= 8 && c.len <= 10));
    assert.ok(a.clues.every((c) => c.options.length >= 3 && c.options.includes(c.text)), 'every clue carries 3+ options');
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
      for (const c of p.clues) {
        assert.ok(lexicon[c.answer].hand, `${c.answer} needs a hand-written clue`);
        assert.ok(c.options.length >= 3, `${c.answer} needs 3+ clue options`);
      }
      assert.equal(p.clues.filter((c) => c.anchor && c.len >= 8).length, SIZES[size].anchors, `${p.id} anchors`);
      assert.ok(!ids.has(p.id));
      ids.add(p.id);
    }
  }
});

test('Thanksgiving special: every clue is themed', () => {
  const theme = new Set(fs.readFileSync(new URL('../generator/data/themes/thanksgiving.txt', import.meta.url), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|')[0]));
  const pack = JSON.parse(fs.readFileSync(new URL('../public/puzzles/special-thanksgiving.json', import.meta.url)));
  const [p] = pack.puzzles;
  assert.equal(p.size, 'large');
  for (const c of p.clues) assert.ok(theme.has(c.answer), `${c.answer} has a themed clue`);
  assert.equal(p.clues.filter((c) => c.anchor).length, SIZES.large.anchors);
});
