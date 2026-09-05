'use strict';
const { parse, input, options } = require('./capture.js');
const { debugFrame } = require('../capture/capture-frames.js');
async function run(argv) {
  const { values, positionals } = parse(argv, { fixture: { type: 'string' }, time: { type: 'string', default: '0' }, out: { type: 'string', short: 'o' } });
  const { scene, svgString } = input(positionals, values.fixture);
  const result = await debugFrame(scene, { ...options(values), svgString, timeMs: Number(values.time), outPath: values.out });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
module.exports = { run };
