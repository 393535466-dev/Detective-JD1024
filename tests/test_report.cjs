const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('static/app.js', 'utf8');
const sandbox = {URL};
vm.createContext(sandbox);
vm.runInContext(script.slice(script.indexOf('function statusLabel'), script.indexOf('function render')), sandbox);
assert.equal(sandbox.diagnosticSteps({configuration: {image_search: true}, steps: [
  {name: 'lens_crop', status: 'no_results'}, {name: 'regional_search_plan', status: 'no_results'},
]}), '');
assert.equal(sandbox.diagnosticSteps({steps: [{name: 'vision', status: 'complete'}]}), '');
const sources = [
  {id: 'S1', kind: 'web_search', title: 'GENIUSES LINK Podcast', url: 'https://example.com/podcast'},
  {id: 'S2', kind: 'visual_match', title: '商业街全景', url: 'https://example.com/street'},
];
const selected = sandbox.selectHighlights({sources, clues: [{search_text: 'GENIUSES LINK'}]}).selected;
assert.equal(selected[0].id, 'S2');
console.log('Report regression checks passed');
