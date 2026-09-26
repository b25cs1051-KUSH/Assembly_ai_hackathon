/* Checks VoiceAgent.findMentions, which picks the product the agent is talking about out of its
   spoken text so the matching card can be highlighted. Run: node scripts/test_mentions.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../frontend/js/voice_agent.js'), 'utf8');
const ctx = {
    location: { search: '' }, URLSearchParams, console, performance,
    document: { addEventListener() {}, querySelector() { return null; } },
};
vm.createContext(ctx);
vm.runInContext(`${src}\nglobalThis.VoiceAgent = VoiceAgent;`, ctx);
const { findMentions } = ctx.VoiceAgent;

const cards = [
    { id: '1', pos: 1, brand: 'TUMELLA' },
    { id: '7', pos: 2, brand: 'Repel' },
    { id: '4', pos: 3, brand: 'totes' },
];
const dupBrand = [
    { id: '1', pos: 1, brand: 'TUMELLA' },
    { id: '9', pos: 2, brand: 'TUMELLA' },
    { id: '4', pos: 3, brand: 'totes' },
];

const cases = [
    ['walkthrough by position and brand',
        'Three umbrellas matched. The first one, the TUMELLA, handles 100 mile per hour wind but is a bit heavy. '
        + 'The second one, the Repel, is light, though the canopy is small. The third one, the totes, opens automatically.',
        cards, ['1', '1', '7', '7', '4', '4']],
    ['brand alone', 'I would go with the Repel for your backpack.', cards, ['7']],
    ['number and option wording', 'Number two is lighter, while option three is cheaper.', cards, ['7', '4']],
    ['the last one', 'The last one is the cheapest.', cards, ['4']],
    ['no match on "first time" or "at first"', 'At first, for the first time, it rained.', cards, []],
    ['brand shared by two numbered cards is ignored, positions still work',
        'The TUMELLA models differ. The second one is lighter.', dupBrand, ['9']],
    ['case-insensitive brand', 'TOTES makes it.', cards, ['4']],
    ['no numbered cards', 'The first one is great.', [], []],
    ['brand as part of a longer word does not count', 'It repels water well.', cards, []],
];

let failed = 0;
for (const [name, text, cand, want] of cases) {
    const got = findMentions(text, cand).map(m => m.id);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`}`);
}
const offsets = findMentions(cases[0][1], cards).map(m => m.offset);
const sorted = offsets.every((o, i) => i === 0 || o >= offsets[i - 1]);
if (!sorted) failed++;
console.log(`${sorted ? 'PASS' : 'FAIL'}  mentions come back in spoken order`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
