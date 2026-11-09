/* ComfyShop pipeline test harness (no Photoshop).
 *
 * Usage:
 *   node tools/test-pipeline.js            # analyse + build prompt only
 *   node tools/test-pipeline.js --run      # also queue one generation
 *   node tools/test-pipeline.js --run --count 2
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Convert = require('../plugin/js/convert.js');
const Comfy = require('../plugin/js/comfy.js');

const HOST = process.env.COMFY_HOST || 'http://127.0.0.1:7861';
const WORKFLOW = process.env.COMFY_WORKFLOW || 'F:\\AI\\ComfyUI\\workflows\\SD1.5.json';
const IMAGE = process.env.COMFY_IMAGE || path.join(__dirname, '..', 'testinput.jpg');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function has(name) {
  return process.argv.indexOf(name) >= 0;
}

(async function main() {
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8').replace(/^\uFEFF/, ''));
  const info = await Comfy.objectInfo(HOST);
  const model = Convert.buildModel(workflow, info);

  console.log('workflow:', path.basename(WORKFLOW));
  console.log('nodes:', model.nodeCount, 'exposed:', model.exposed.length,
    'images:', model.loadImages.length, 'outputs:', model.outputs.length);
  console.log('defaultOutputId:', model.defaultOutputId);
  console.log('errors:', model.errors);
  console.log('exposed parameters:');
  for (const n of model.exposed) {
    console.log('  #' + n.id, n.type, JSON.stringify(n.title),
      n.widgets.map(w => `${w.name}=${JSON.stringify(w.value)}${w.isSeed ? '[' + (w.seedControl || '') + ']' : ''}`).join(', '));
  }

  let uploaded = null;
  if (has('--run')) {
    const bytes = fs.readFileSync(IMAGE);
    uploaded = await Comfy.uploadImage(HOST, bytes, 'comfyshop_harness_' + Date.now() + path.extname(IMAGE), { overwrite: true });
    console.log('uploaded:', uploaded);
  }

  const overrides = {};
  if (uploaded) {
    const ref = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;
    for (const img of model.loadImages) {
      overrides[String(img.id)] = { image: ref };
    }
  }

  const promptOptions = { outputIds: model.defaultOutputId ? [model.defaultOutputId] : null };
  const built = Convert.buildPrompt(workflow, info, overrides, promptOptions);
  console.log('prompt nodes:', Object.keys(built.prompt).length, 'errors:', built.errors);
  if (built.warnings && built.warnings.length) console.log('warnings:', built.warnings);
  if (built.errors.length) process.exitCode = 1;

  if (has('--run')) {
    const count = Number(arg('--count', '1')) || 1;
    for (let i = 0; i < count; i++) {
      // Randomize seed when the workflow's seed control says randomize.
      for (const n of model.exposed) {
        for (const w of n.widgets) {
          if (w.isSeed && (w.seedControl === 'randomize')) {
            overrides[String(n.id)] = overrides[String(n.id)] || {};
            overrides[String(n.id)][w.name] = Math.floor(Math.random() * 0x7fffffff);
          }
        }
      }
      const run = Convert.buildPrompt(workflow, info, overrides, promptOptions);
      if (run.errors.length) throw new Error(run.errors.join('\n'));
      const started = Date.now();
      const res = await Comfy.runPrompt(HOST, run.prompt, Comfy.randomId(), {
        onProgress(pct) { if (pct !== null) process.stdout.write(`\r  ${i + 1}/${count} ${pct}%   `); }
      });
      const images = res.images;
      console.log(`\nrun ${i + 1}/${count}: prompt=${res.promptId} images=${images.map(x => x.filename).join(', ')} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!images.length) throw new Error('no images');
      const buf = await Comfy.fetchImage(HOST, images[0]);
      const out = path.join(__dirname, '..', 'out', `harness_${Date.now()}_${i + 1}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(buf));
      console.log('saved:', out, Buffer.from(buf).length, 'bytes');
    }
  }
})().catch(err => {
  console.error('\nFAILED:', err && (err.stack || err.message || err));
  if (err && err.details) console.error(JSON.stringify(err.details).slice(0, 2000));
  process.exitCode = 1;
});
