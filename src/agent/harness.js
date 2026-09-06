'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PROMPT_VERSION, buildPrompt, resourceHashes } = require('./prompts.js');
const { claimsCover, carryClaims } = require('./claims.js');
const { deterministicRepair } = require('./scene-repair.js');
const { consistentPost, postMarkdown } = require('./post.js');
const { validateAndInspect, stableErrors } = require('./scene-inspect.js');
const { renderAgentScene, assertQualityGate, verifyRenderArtifacts, restorePromotedArtifacts } = require('./render.js');
const { critic, createCriticImages } = require('./critic.js');
const { AgentUsageError, AgentSchemaError, AgentSceneRepairExhausted, AgentBudgetExhausted,
  AgentRenderError, AgentResumeMismatch, toSafeJson } = require('./errors.js');

const SCHEMAS = { research: 'fact-sheet', brief: 'brief', scene: 'scene-proposal', critic: 'critic-verdict', scout: 'scout-result' };
const relative = (root, file) => {
  const value = path.relative(root, file).replace(/\\/g, '/');
  if (!value || value.startsWith('../') || path.isAbsolute(value)) throw new AgentSchemaError('Artifact escaped the run directory');
  return value;
};
const sourceProjection = source => Object.fromEntries(['id', 'url', 'title', 'provider', 'publishedAt', 'engagement'].map(k => [k, source[k]]));

// Dependencies are ports, so Job D tests do not load parallel A/B implementations.
// Production loading is deliberately lazy: --help, --version and parse errors need none of them.
function defaultDependencies() {
  const config = require('./config.js'), runs = require('./run-store.js'), brains = require('./brains/index.js');
  const research = require('./research/index.js');
  return { ...config, ...runs,
    selectBrain: brains.selectBrain,
    createCompleter: ({ brain, ...context }) => brains.createBrainRunner(brain, context).complete,
    selectResearch: (mode, config) => ({ collect: (topic, options) => research.collectResearch(topic, {
      config, mode, fresh: options.fresh, deadlineMs: options.deadlineMs, purpose: options.scout ? 'scout' : 'research'
    }) }),
    assertGrounded: (sheet, collected) => {
      const known = new Map(collected.sources.map(s => [s.id, s]));
      for (const source of sheet.sources) if (!known.has(source.id) || runs.hash(sourceProjection(source)) !== runs.hash(sourceProjection(known.get(source.id)))) {
        throw new (require('./errors.js').AgentResearchInsufficient)('Fact-sheet source metadata differs from collected evidence');
      }
      return research.validateFactSheet(sheet, collected.extracts);
    },
    rankCandidates: require('./virality.js').rankCandidates,
    schema: step => require('./schemas/' + SCHEMAS[step] + '.schema.json'),
    resourceHashes, buildPrompt, inspect: validateAndInspect, repair: deterministicRepair,
    render: renderAgentScene, assertQuality: assertQualityGate, verifyRenderArtifacts, restorePromotedArtifacts, critic, createCriticImages,
    redact: require('./redact.js').redact,
    browserIdentity: async () => {
      const { chromium } = require('playwright');
      // The executable version is part of the resume key. No probe subprocess is needed.
      const executable = chromium.executablePath(), stat = await fs.stat(executable);
      return { browserVersion: runs.hashFile(executable), playwrightVersion: require('playwright/package.json').version,
        browserSize: stat.size };
    }
  };
}

function createHarness(dependencies) {
  const d = dependencies;
  const now = () => new Date().toISOString();
  async function setup(topic, options, command) {
    const cfg = await d.loadConfig(options.config, { cwd: options.cwd });
    if (options.maxModelCalls !== undefined) cfg.limits.maxModelCalls = options.maxModelCalls;
    if (options.allowHtmlSearch) cfg.research.allowHtmlSearch = true;
    const brain = await d.selectBrain(options.brain, cfg, options);
    const researchMode = options.research || ((brain.provider || brain.name || '').startsWith('mock') ? 'mock' : 'live');
    const research = await d.selectResearch(researchMode, cfg, brain);
    const outDir = path.resolve(cfg.configDir || options.cwd || process.cwd(), options.out || 'out');
    const resume = !!(options.resume || options.resumeSlug);
    const slug = resume ? await d.resolveResume(outDir, topic, options.resumeSlug) : await d.uniqueSlug(d.slugify(topic), outDir);
    const store = await d.createRunStore(path.join(outDir, slug));
    const run = resume ? await store.loadRun() : d.newRun({ config: cfg, brain, topic, slug, command, parentSlug: options.parentSlug, researchMode,
      maxModelCalls: options.maxModelCalls, maxTotalModelCalls: options.maxTotalModelCalls });
    if (run.command !== command) throw new AgentResumeMismatch('Resume command differs from the original run');
    const previous = resume ? structuredClone(run) : null;
    run.status = 'running'; delete run.error; delete run.completedAt;
    run.config = d.configProjection(cfg, brain, { researchMode });
    run.budget.maxModelCalls = cfg.limits.maxModelCalls;
    if (run.budget.modelCallsUsed > run.budget.maxModelCalls) throw new AgentBudgetExhausted('Existing run already exceeds the requested budget');
    const started = Date.now();
    const remaining = () => cfg.limits.runTimeoutMs - (Date.now() - started);
    const checkDeadline = () => { if (remaining() <= 0) throw new AgentRenderError('Whole-run deadline exceeded'); };
    const persist = async () => { await store.persist(run); };
    await persist();
    const aggregateBudget = options.aggregateBudget || (command === 'scout' ? {
      maxModelCalls: options.maxTotalModelCalls ?? (options.count ?? 5) * cfg.limits.maxModelCalls,
      modelCallsUsed: 0
    } : undefined);
    if (aggregateBudget && command === 'scout') run.budget.maxTotalModelCalls = aggregateBudget.maxModelCalls;
    const boundedBrain = typeof brain.complete === 'function' ? { ...brain, complete: request => {
      checkDeadline();
      return brain.complete({ ...request, timeoutMs: Math.min(request.timeoutMs, remaining()) });
    } } : brain;
    const complete = await d.createCompleter({ brain: boundedBrain, run, store, config: cfg, persist, aggregateBudget });
    let invalidated = !resume || !!options.fresh, active;
    const projection = { ...run.config }; delete projection.brandStyle;
    const providerKey = { 'codex-cli': 'codex', 'claude-cli': 'claudeCli' }[brain.provider] || brain.provider;
    projection.brainSettings = cfg.brain?.[providerKey];
    projection.mockScript = brain.script;
    // Brand enters only the scene hash; it must never invalidate research or brief.
    const schemaHash = step => d.hash(d.schema(step));
    async function request(step, context, promptStep = step, images = [], extra = {}) {
      checkDeadline();
      const prompt = d.buildPrompt(promptStep, { topic, ...context });
      const response = await complete({ step, ...prompt, schema: d.schema(step), images, ...extra,
        maxOutputTokens: cfg.limits.maxOutputTokens[step], timeoutMs: Math.min(cfg.limits.modelTimeoutMs[step], remaining()) });
      checkDeadline();
      return d.redact ? d.redact(response.value) : response.value;
    }
    async function step(name, inputHash, operation, { attempt = 1, accept, allowReuse = true, validateReuse } = {}) {
      checkDeadline();
      if (!invalidated && allowReuse) {
        const old = await store.reusableStep(previous, name, inputHash);
        if (old && (!validateReuse || await validateReuse(old.value))) {
          const { value, ...record } = old;
          run.steps.push({ ...record, status: 'reused' }); await persist();
          return { value, record };
        }
      }
      invalidated = true;
      active = { name, status: 'running', attempt, inputHash, outputPath: 'steps/' + name + '.json', startedAt: now() };
      run.steps.push(active); await persist();
      try {
        const value = await operation(); checkDeadline();
        const record = await store.persistStep(name, value, { attempt, inputHash, startedAt: active.startedAt, completedAt: now(),
          ...(accept ? { accepted: accept(value) } : {}) });
        Object.assign(active, record); await persist(); active = null;
        return { value, record };
      } catch (error) {
        Object.assign(active, { status: 'failed', completedAt: now(), error: toSafeJson(error) });
        await store.writeJson(active.outputPath, { error: toSafeJson(error) });
        await persist(); active = null; throw error;
      }
    }
    async function finish(status) { run.status = status; run.completedAt = now(); await persist(); return { run, runDir: store.root, slug, exitCode: 0 }; }
    async function fail(error) {
      run.status = 'failed'; run.completedAt = now(); run.error = toSafeJson(error);
      await persist(); error.run = run; error.runDir = store.root; throw error;
    }
    return { cfg, brain, research, researchMode, outDir, slug, store, run, previous, projection, aggregateBudget, remaining, checkDeadline, persist, schemaHash, request, step, finish, fail,
      canReuse: () => !invalidated, invalidate: () => { invalidated = true; } };
  }

  async function runMake(topic, options = {}) {
    if (typeof topic !== 'string' || !topic.trim() || topic.trim().length > 180) throw new AgentUsageError('Topic must be non-empty and at most 180 characters');
    topic = topic.trim();
    const command = options.command === 'mindmap' ? 'mindmap' : 'make';
    const c = await setup(topic, options, command);
    const { cfg, brain, store, run, request, step, persist } = c;
    try {
      // `mock:budget` is a diagnostic, not an alternate production workflow.
      // Each probe is a normal, durable model dispatch. The next probe is left
      // to the runner so its normal pre-dispatch cap proves that no 29th call
      // reaches a provider.
      if (brain.script === 'budget') {
        for (let probe = 1; ; probe++) {
          await step('00-budget-probe-a' + probe, d.hash(topic, probe, c.schemaHash('research')), () =>
            request('research', { sources: [], extracts: [], diagnostics: [], budgetProbe: true }));
        }
      }
      if (options.scoutContext) await step('00-scout', d.hash(options.scoutContext, options.fresh || false), () => options.scoutContext);
      c.checkDeadline();
      const collected = await c.research.collect(topic, { ...cfg, fresh: !!options.fresh, deadlineMs: Math.min(cfg.limits.researchDeadlineMs, c.remaining()) });
      c.checkDeadline();
      // The collection artifact retains provider diagnostics and extracts even on grounding failure.
      await store.writeJson('steps/01-research-sources.json', collected);
      const hashes = (collected.extracts || []).map(e => d.hash(e.sourceId, e.url || e.finalUrl, e.contentHash || d.hash(e.text))).sort();
      const researchHash = d.hash(topic, cfg.research.providers, c.researchMode, hashes, !!options.fresh, PROMPT_VERSION, c.schemaHash('research'), c.projection);
      const facts = await step('01-research', researchHash, async () => {
        let grounded;
        const sheet = await request('research', { sources: collected.sources, extracts: collected.extracts, diagnostics: collected.diagnostics }, 'research', [],
          { postValidate: async value => { grounded = await d.assertGrounded(value, collected); } });
        return grounded || sheet;
      });
      run.sources = facts.value.sources.map(sourceProjection); run.artifacts.factSheet = facts.record.outputPath; await persist();
      const brief = await step('02-brief', d.hash(facts.record.outputHash, PROMPT_VERSION, c.schemaHash('brief'), c.projection, command === 'mindmap' ? 'mindmap' : null), async () => {
        const known = new Set(facts.value.facts.map(f => f.id));
        const value = await request('brief', { factSheet: facts.value, forcedFormat: command === 'mindmap' ? 'mindmap' : null }, 'brief', [], {
          postValidate: value => { if (value.factIds.some(id => !known.has(id))) throw new AgentSchemaError('Brief references an unknown fact ID'); }
        });
        if (command === 'mindmap') value.format = 'mindmap';
        value.post = consistentPost(value.post);
        return value;
      });
      run.artifacts.brief = brief.record.outputPath;
      await store.writeText('post.md', postMarkdown(brief.value.post)); run.artifacts.postMd = 'post.md'; await persist();
      if (options.dryRun) return await c.finish('delivered');
      const resources = await d.resourceHashes(), browser = await d.browserIdentity();
      const sceneHash = d.hash(brief.record.outputHash, facts.record.outputHash, resources.exemplars, resources.sceneSchema,
        resources.contract, cfg.brand || { style: 'none' }, PROMPT_VERSION, c.schemaHash('scene'));
      const inspectionHash = d.hash(sceneHash, browser, resources.fonts, resources.defaults, resources.renderer);
      let errors = [], uncoveredSubstantiveTexts = [], previousProposal = null, candidate, candidateClaims, inspection, sceneRecord;
      const unique = values => [...new Map((values || []).map(value => [JSON.stringify(value), value])).values()];
      const retainSupportErrors = values => (values || []).filter(({ message }) => message === 'Claim requires support' || message.startsWith('Unknown supporting fact: '));
      async function recordCoverage(value) {
        run.warnings = unique([...(run.warnings || []), ...(value.warnings || [])]);
        run.autoAuthoringSlots = unique([...(run.autoAuthoringSlots || []), ...(value.autoAuthoringSlots || [])]);
        run.escalatedSlots = unique([...(run.escalatedSlots || []), ...(value.escalatedSlots || [])]);
        await persist();
      }
      async function propose(attempt, promptStep, verdict) {
        return step('03-scene-a' + attempt, d.hash(inspectionHash, attempt, verdict || null), async () => {
          let proposal;
          try { proposal = await request('scene', { factSheet: facts.value, brief: brief.value, errors, uncoveredSubstantiveTexts,
            ...(previousProposal ? { previousProposal } : {}), ...(candidate ? { candidate } : {}), ...(verdict ? { verdict } : {}) }, promptStep, [],
          { format: brief.value.format, deferSceneValidation: true }); }
          catch (error) {
            if (error.code !== 'SCHEMA') throw error;
            return { proposal: null, repairTrace: [], repairPenalties: [], warnings: [], autoAuthoringSlots: [], escalatedSlots: [], uncoveredSubstantiveTexts: [],
              validation: { ok: false, errors: [{ path: '/', message: error.message }] }, accepted: false };
          }
          const authored = structuredClone(proposal.scene), postErrors = [];
          if (Object.hasOwn(authored, 'brand')) postErrors.push({ path: '/brand', message: 'Proposal must omit brand' });
          const mindmap = command === 'mindmap';
          if (!mindmap && authored.layout?.kind === 'mindmap') postErrors.push({ path: '/layout/kind', message: 'Make proposals may not use layout.kind "mindmap"; use the brief format' });
          else if ((authored.layout?.kind === 'mindmap') !== mindmap) postErrors.push({ path: '/layout/kind', message: 'Layout must match the brief format' });
          if (mindmap && ((authored.nodes || []).length || (authored.edges || []).length || (authored.timeline?.animations || []).length || authored.layout?.mindmap?.placement)) {
            postErrors.push({ path: '/layout/mindmap', message: 'Mindmap must contain only its authored tree and empty generated arrays' });
          }
          const beforeRepair = structuredClone(authored);
          const originalClaims = claimsCover(authored, proposal.claims, facts.value);
          authored.brand = structuredClone(cfg.brand || { style: 'none' }); authored.id = c.slug;
          // Pin the palette when the operator has chosen one. Letting the model pick a theme
          // per scene produces a gallery in four different palettes, which reads as a grab bag
          // rather than a body of work. The model still chooses everything else.
          if (cfg.brand?.theme) authored.theme = cfg.brand.theme;
          const repairTrace = d.repair(authored);
          const claims = carryClaims(authored, originalClaims.claims, repairTrace, beforeRepair);
          const coverage = claimsCover(authored, claims, facts.value);
          const validation = await d.inspect(authored, { timeoutMs: Math.min(cfg.limits.inspectTimeoutMs, c.remaining()) });
          const allErrors = stableErrors(unique([...postErrors, ...retainSupportErrors(originalClaims.errors), ...coverage.errors, ...(validation.errors || [])]));
          const warnings = unique([...(originalClaims.warnings || []), ...(coverage.warnings || [])]);
          const carriedAutoAuthoringSlots = (originalClaims.autoAuthoringSlots || []).filter(slot =>
            (coverage.slots || []).some(current => current.path === slot.path && current.text === slot.text));
          return { proposal, authored, claims, repairTrace, repairPenalties: repairTrace.penalties || [], warnings,
            autoAuthoringSlots: unique([...carriedAutoAuthoringSlots, ...(coverage.autoAuthoringSlots || [])]), escalatedSlots: coverage.escalatedSlots || [],
            uncoveredSubstantiveTexts: coverage.uncoveredSubstantiveTexts || [], validation: { ...validation, ok: validation.ok && !allErrors.length, errors: allErrors },
            accepted: validation.ok && !allErrors.length };
        }, { attempt, accept: v => v.accepted });
      }
      // On resume skip retained rejected proposals and start at the accepted initial proposal.
      let startAttempt = 1;
      if (c.canReuse()) for (let k = 1; k <= 4; k++) {
        if (await store.reusableStep(c.previous, '03-scene-a' + k, d.hash(inspectionHash, k, null))) { startAttempt = k; break; }
      }
      for (let k = startAttempt; k <= 4; k++) {
        const result = await propose(k, k === 1 ? 'scene' : 'repair');
        await recordCoverage(result.value);
        if (result.value.accepted) {
          candidate = result.value.validation.scene || result.value.authored; candidateClaims = result.value.claims;
          inspection = result.value.validation; sceneRecord = result.record; break;
        }
        errors = result.value.validation.errors;
        uncoveredSubstantiveTexts = result.value.uncoveredSubstantiveTexts || [];
        if (result.value.proposal) previousProposal = structuredClone(result.value.proposal);
      }
      if (!candidate) throw new AgentSceneRepairExhausted('Four scene proposals failed validation or claims coverage', { details: errors });
      run.gates.schema = true; run.gates.browser = true; run.claims = candidateClaims; await persist();
      async function renderAndCritique(attempt) {
        const rendered = await step('04-render-a' + attempt, d.hash(sceneRecord.outputHash, browser, resources.fonts, resources.defaults, resources.renderer), async () => {
          const value = await d.render(candidate, store.root, attempt, { timeoutMs: Math.min(cfg.limits.renderTimeoutMs, c.remaining()) });
          d.assertQuality(value); return value;
        }, { attempt, validateReuse: d.verifyRenderArtifacts ? value => d.verifyRenderArtifacts(value, store.root) : undefined });
        d.assertQuality(rendered.value); run.gates.render = true; await persist();
        c.checkDeadline();
        const images = await d.createCriticImages(rendered.value, path.join(store.root, 'steps', '05-critic-a' + attempt + '-images'), { timeoutMs: Math.min(60000, c.remaining()) });
        for (const file of images) { const rel = relative(store.root, file); if (!run.criticImages.includes(rel)) run.criticImages.push(rel); }
        await persist();
        const imageHashes = await Promise.all(images.map(file => d.hashFile(file)));
        const verdict = await step('05-critic-a' + attempt, d.hash(rendered.record.outputHash, imageHashes, !!brain.capability?.vision, PROMPT_VERSION, c.schemaHash('critic')), () => d.critic({
          rendered: rendered.value, scene: candidate, brief: brief.value, inspection, brain, images,
          complete: ({ images: attached, measured }) => request('critic', { brief: brief.value, scene: candidate,
            measured, finalAudit: attempt === 2 }, 'critic', attached)
        }), { attempt });
        return { rendered: rendered.value, verdict: verdict.value };
      }
      let final = await renderAndCritique(1);
      if (final.verdict.verdict === 'repair') {
        const repaired = await propose(5, 'critic-repair', final.verdict);
        await recordCoverage(repaired.value);
        if (!repaired.value.accepted) throw new AgentSceneRepairExhausted('Critic repair failed validation or claims coverage', { details: repaired.value.validation.errors });
        candidate = repaired.value.validation.scene || repaired.value.authored; candidateClaims = repaired.value.claims;
        inspection = repaired.value.validation; sceneRecord = repaired.record;
        final = await renderAndCritique(2);
      }
      if (d.restorePromotedArtifacts) await d.restorePromotedArtifacts(final.rendered, store.root);
      await store.writeJson('scene.json', candidate);
      run.claims = candidateClaims; run.gates.critic = final.verdict.verdict;
      run.artifacts.sceneJson = 'scene.json';
      run.artifacts.gif = relative(store.root, final.rendered.gifPath);
      if (final.rendered.contactSheet) run.artifacts.contactSheet = relative(store.root, final.rendered.contactSheet);
      run.artifacts.manifest = relative(store.root, final.rendered.manifestPath);
      const status = final.verdict.verdict === 'pass' && !Object.values(final.verdict.checks).includes('unmeasured') ? 'delivered' : 'delivered-with-warnings';
      return await c.finish(status);
    } catch (error) { return c.fail(error); }
  }

  async function runScout(options = {}) {
    const topic = options.domain || 'software engineering', count = options.count ?? 5;
    const c = await setup(topic, options, 'scout');
    try {
      const collected = await c.research.collect(topic, { ...c.cfg, fresh: !!options.fresh, scout: true, deadlineMs: Math.min(c.cfg.limits.researchDeadlineMs, c.remaining()) });
      await c.store.writeJson('steps/00-scout-sources.json', collected);
      c.run.sources = (collected.sources || []).map(sourceProjection);
      const result = await c.step('00-scout', d.hash(topic, collected, PROMPT_VERSION, c.schemaHash('scout'), c.projection, !!options.fresh), async () => {
        const proposed = await c.request('scout', { domain: topic, sources: collected.sources });
        const sources = new Map(collected.sources.map(s => [s.id, s]));
        const candidates = proposed.candidates.map(candidate => {
          if (!candidate.sourceIds.length || candidate.sourceIds.some(id => !sources.has(id))) throw new AgentSchemaError('Scout candidate references an unknown source');
          const source = sources.get(candidate.sourceIds[0]);
          return { ...candidate, provider: source.provider, publishedAt: source.publishedAt, engagement: source.engagement, url: source.url };
        });
        return { ...proposed, candidates: d.rankCandidates(candidates, options.now ?? Date.now()).map(({ provider, publishedAt, engagement, url, ...candidate }) => candidate) };
      });
      c.run.artifacts.scoutJson = result.record.outputPath;
      const log = options.log || console.log;
      log('rank | heuristic virality | topic | source | age | engagement');
      for (const [i, candidate] of result.value.candidates.slice(0, count).entries()) {
        const source = collected.sources.find(s => s.id === candidate.sourceIds[0]);
        const age = source.publishedAt ? Math.max(0, Math.floor(((options.now ?? Date.now()) - Date.parse(source.publishedAt)) / 86400000)) + 'd' : 'unknown';
        log([i + 1, candidate.virality, candidate.topic, source.provider, age, source.engagement?.score || 0].join(' | '));
      }
      const children = [];
      if (options.make) {
        for (const candidate of result.value.candidates.slice(0, count)) {
          const remaining = c.aggregateBudget.maxModelCalls - c.aggregateBudget.modelCallsUsed;
          if (remaining < 1) throw new AgentBudgetExhausted('Scout aggregate model-call budget exhausted');
          const child = await runMake(candidate.topic, { ...options, command: 'make', resume: false, resumeSlug: undefined,
            out: c.outDir, parentSlug: c.slug, scoutContext: { domain: topic, generatedAt: result.value.generatedAt, candidates: [candidate] },
            maxModelCalls: Math.min(c.cfg.limits.maxModelCalls, remaining), aggregateBudget: c.aggregateBudget });
          children.push(child);
        }
      }
      return { ...await c.finish('delivered'), candidates: result.value.candidates, children };
    } catch (error) { return c.fail(error); }
  }

  return { runMake, runScout, runMindmap: (topic, options = {}) => runMake(topic, { ...options, command: 'mindmap' }) };
}

const runMake = (topic, options) => createHarness(defaultDependencies()).runMake(topic, options);
const runScout = options => createHarness(defaultDependencies()).runScout(options);
const runMindmap = (topic, options) => createHarness(defaultDependencies()).runMindmap(topic, options);
module.exports = { createHarness, defaultDependencies, runMake, runScout, runMindmap, postMarkdown };
