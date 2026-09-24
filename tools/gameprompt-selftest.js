'use strict';
// Exercises buildGamePrompt() from presenter.js against a fake room.
//   node tools/gameprompt-selftest.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'presenter.js'), 'utf8');
function extract(name) {
  const start = src.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const roleStart = src.indexOf('  const SLOT_ROLE = {');
const roleEnd = src.indexOf('};', roleStart) + 2;
const sb = {
  PROMPT_SLOTS: ['SETTING', 'COMPANION', 'THREAT', 'ARTIFACT', 'TWIST'],
  S: {
    deck: { title: 'Beyond the Prompt' },
    pinPending: {},
    promptPins: { SETTING: null, COMPANION: 'c2', THREAT: null, ARTIFACT: null, TWIST: null },
    promptPieces: {
      SETTING: [{ id: 's1', text: 'a flooded mall food court', votes: 3, ts: 1 }, { id: 's2', text: 'the moon, but zoned residential', votes: 5, ts: 2 }, { id: 's3', text: 'a Blockbuster at 3am', votes: 0, ts: 3 }],
      COMPANION: [{ id: 'c1', text: 'a drone with anxiety', votes: 9, ts: 1 }, { id: 'c2', text: 'your ex, as a Roomba', votes: 1, ts: 2, handle: 'jess' }],
      THREAT: [{ id: 't1', text: 'an HOA with root access', votes: 0, ts: 1 }, { id: 't2', text: 'polite bees', votes: 0, ts: 5 }],
      ARTIFACT: [],
      TWIST: [{ id: 'w1', text: 'gravity is a subscription', votes: 2, ts: 1 }],
    },
  },
};
vm.createContext(sb);
vm.runInContext(src.slice(roleStart, roleEnd).replace('const SLOT_ROLE', 'var SLOT_ROLE') + '\n' +
  ['pinnedIdFor', 'slotRanking', 'buildGamePrompt'].map(extract).join('\n'), sb);
const { text, filled } = sb.buildGamePrompt();
let fails = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails++; };
check('4 of 5 blanks filled', filled === 4);
check('SETTING winner = most voted', /SETTING[^\n]*\n  WINNER: "the moon, but zoned residential"  \[5 votes\]/.test(text));
check('COMPANION pin beats 9 votes', /WINNER: "your ex, as a Roomba"  \[pinned by the presenter, from jess\]/.test(text));
check('COMPANION runner-up listed', /also:   "a drone with anxiety"  \[9 votes\]/.test(text));
check('THREAT no votes -> latest', /WINNER: "polite bees"  \[latest submission\]/.test(text));
check('ARTIFACT empty handled', /ARTIFACT[^\n]*\n  WINNER: \(the room left this blank/.test(text));
check('at most 2 runners-up', (text.split('SETTING')[1].split('COMPANION')[0].match(/also:/g) || []).length === 2);
check('five studio roles', ['CREATIVE DIRECTOR', 'DESIGNER / WRITER', 'PIXEL / ASCII ARTIST', 'PROGRAMMER', 'QA / PLAYTESTER'].every((r) => text.includes(r)));
check('80s-90s studio framing', /1987-1995/.test(text));
check('deck title carried', text.includes('"Beyond the Prompt"'));
if (process.argv.includes('--print')) console.log('\n' + text);
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
