'use strict';

const { AgentUsageError } = require('./errors.js');
const HELP = `Usage: diagif <command> [options]

  make <topic>       Research, author, render and inspect a technical GIF
  mindmap <topic>    Make an 800x1100 mind map
  scout             Rank topics by heuristic virality
  brand --url URL    Configure a LinkedIn URL footer
  brand --clear     Remove the configured brand
  doctor            Inspect providers and research configuration

Make / mindmap:
  --brain NAME --model NAME --config FILE --out DIR --dry-run
  --resume | --resume-slug SLUG --fresh --max-model-calls N (1..200)
  --research live|mock --allow-html-search
Scout:
  --domain NAME --count N (1..10) --make --max-total-model-calls N (1..2000)
  --brain NAME --config FILE --out DIR --fresh --max-model-calls N
  --research live|mock --allow-html-search
Brand / doctor: --config FILE
  --help, -h       Show help
  --version, -v    Show version
  --              End options; remaining arguments are the topic
`;
const common = ['brain', 'config', 'out', 'fresh', 'max-model-calls', 'research', 'allow-html-search'];
const allowed = {
  make: [...common, 'model', 'dry-run', 'resume', 'resume-slug'],
  mindmap: [...common, 'model', 'dry-run', 'resume', 'resume-slug'],
  scout: [...common, 'domain', 'count', 'make', 'max-total-model-calls'],
  brand: ['url', 'clear', 'config'], doctor: ['config']
};
const booleans = new Set(['fresh', 'allow-html-search', 'dry-run', 'resume', 'make', 'clear']);
const ranges = { count: [1, 10], 'max-model-calls': [1, 200], 'max-total-model-calls': [1, 2000] };
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new AgentUsageError('Arguments must be an array');
  if (!argv.length) return { command: 'help', options: {} };
  if (argv.length === 1 && ['--help', '-h', '--version', '-v'].includes(argv[0])) {
    return { command: ['--version', '-v'].includes(argv[0]) ? 'version' : 'help', options: {} };
  }
  const [command, ...args] = argv;
  if (!Object.hasOwn(allowed, command)) throw new AgentUsageError('Unknown command: ' + command);
  const options = {}, seen = new Set(), positional = [];
  let ended = false, help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (ended) { positional.push(arg); continue; }
    if (arg === '--') { ended = true; continue; }
    if (arg === '--help' || arg === '-h') { if (help) throw new AgentUsageError('Duplicate --help'); help = true; continue; }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!arg.startsWith('--') || !allowed[command].includes(name)) throw new AgentUsageError('Unknown ' + command + ' option: ' + arg);
    if (seen.has(name)) throw new AgentUsageError('Duplicate option: ' + arg);
    seen.add(name);
    let value = true;
    if (!booleans.has(name)) {
      value = args[++i];
      if (value === undefined || !value.trim() || value.startsWith('--')) throw new AgentUsageError('Missing value for ' + arg);
      if (ranges[name]) {
        const [min, max] = ranges[name];
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
          throw new AgentUsageError(arg + ' must be an integer in ' + min + '..' + max);
        }
        value = Number(value);
      }
    }
    options[camel(name)] = value;
  }
  if (help) return { command: 'help', options: {}, forCommand: command };
  if (options.research && !['live', 'mock'].includes(options.research)) throw new AgentUsageError('--research must be live or mock');
  if (options.resume && options.resumeSlug) throw new AgentUsageError('Use only one of --resume and --resume-slug');
  if (options.resumeSlug && !/^[a-z0-9][a-z0-9-]{0,119}$/.test(options.resumeSlug)) throw new AgentUsageError('Invalid resume slug');
  if (command === 'brand' && Number(!!options.url) + Number(!!options.clear) !== 1) throw new AgentUsageError('brand requires exactly one of --url and --clear');
  let topic;
  if (['make', 'mindmap'].includes(command)) {
    topic = positional.join(' ').trim();
    if (!topic || topic.length > 180) throw new AgentUsageError('Topic must be non-empty and at most 180 characters');
  } else if (positional.length) throw new AgentUsageError(command + ' does not accept positional arguments');
  return { command, ...(topic === undefined ? {} : { topic }), options };
}

module.exports = { parseArgs, HELP };
