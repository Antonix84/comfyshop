/*
 * ComfyShop - converter unit tests.  Run with:  node tests/convert.test.js
 * No dependencies: a 20 line assert harness and hand written fixtures.
 */
'use strict';

const Convert = require('../plugin/js/convert.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32mok\x1b[0m   ' + name);
  } catch (e) {
    failed++;
    failures.push(name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
    console.log('  \x1b[31mfail\x1b[0m ' + name + '\n      ' + (e && e.message ? e.message : e));
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'values') + ': got ' + a + ', expected ' + b);
}

function ok(value, what) {
  if (!value) throw new Error(what || 'expected a truthy value');
}

function has(haystack, needle, what) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  if (text.indexOf(needle) < 0) throw new Error((what || 'message') + ' does not contain "' + needle + '": ' + text);
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['sd15.safetensors', 'sdxl.safetensors'], { default: 'sd15.safetensors' }] } },
    output: ['MODEL', 'CLIP', 'VAE'],
    output_is_list: true,
    name: 'CheckpointLoaderSimple'
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
    name: 'CLIPTextEncode'
  },
  PrimitiveStringMultiline: {
    input: { required: { value: ['STRING', { multiline: true, default: '' }] } },
    output: ['STRING'],
    name: 'PrimitiveStringMultiline'
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512, min: 16, max: 8192, step: 8 }], height: ['INT', { default: 512, min: 16, max: 8192, step: 8 }], batch_size: ['INT', { default: 1, min: 1, max: 64 }] } },
    output: ['LATENT'],
    name: 'EmptyLatentImage'
  },
  KSampler: {
    input: {
      required: {
        seed: ['INT', { default: 0, min: 0, max: 0xffffffffffffffff, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 3.5, min: 0, max: 100, step: 0.1 }],
        sampler_name: [['euler', 'dpmpp_2m', 'euler_ancestral'], { default: 'euler' }],
        scheduler: [['normal', 'karras'], { default: 'karras' }],
        denoise: ['FLOAT', { default: 1.0, min: 0, max: 1, step: 0.01 }],
        model: ['MODEL'],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT']
      }
    },
    output: ['LATENT'],
    name: 'KSampler'
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    output: ['IMAGE'],
    name: 'VAEDecode'
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    output: [],
    output_is_list: false,
    output_node: true,
    name: 'SaveImage'
  },
  PreviewImage: {
    input: { required: { images: ['IMAGE'] } },
    output: [],
    output_node: true,
    name: 'PreviewImage'
  },
  LoadImage: {
    input: { required: { image: ['COMBO', { image_upload: true, options: ['a.png', 'b.png'], default: 'a.png' }] } },
    output: ['IMAGE', 'MASK'],
    name: 'LoadImage'
  },
  LoadImageMask: {
    input: {
      required: {
        channel: [['red', 'green', 'blue', 'alpha'], { default: 'red' }],
        image: ['COMBO', { image_upload: true, options: ['m.png'] }]
      }
    },
    output: ['MASK'],
    name: 'LoadImageMask'
  },
  ImageCompositeMasked: {
    input: {
      required: { destination: ['IMAGE'], source: ['IMAGE'], x: ['INT', { default: 0 }], y: ['INT', { default: 0 }], resize_source: ['BOOLEAN', { default: false }] },
      mask: ['MASK', { forceInput: true }]
    },
    output: ['IMAGE'],
    name: 'ImageCompositeMasked'
  },
  ImageScaleToTotalPixels: {
    input: {
      required: {
        image: ['IMAGE'],
        upscale_method: [['nearest-exact', 'bilinear', 'area', 'lanczos'], { default: 'lanczos' }],
        megapixels: ['FLOAT', { default: 1.0, min: 0.01, max: 120, step: 0.01 }]
      }
    },
    output: ['IMAGE'],
    name: 'ImageScaleToTotalPixels'
  }
};

function node(id, type, opts) {
  opts = opts || {};
  return {
    id: id,
    type: type,
    title: opts.title,
    mode: opts.mode === undefined ? 0 : opts.mode,
    inputs: opts.inputs || [],
    outputs: opts.outputs || [],
    widgets_values: opts.widgets || []
  };
}

function txt(id, name) { return { name: name, type: 'TEXT', link: id }; }
function out(id, name, type, links) { return { name: name, type: type, links: links || [] }; }
function link(id, from, fromSlot, to, toSlot, type) { return [id, from, fromSlot, to, toSlot, type || '*']; }

/* A small but realistic UI workflow:
 *  - rgthree dev.reroute between the checkpoint and the sampler
 *  - a muted "old" SaveImage branch that must be pruned
 *  - "#"-titled nodes for prompt / sampler / upscale
 *  - a LoadImage and a LoadImageMask fed from Photoshop
 */
function uiWorkflow() {
  return {
    last_node_id: 99,
    nodes: [
      node(1, 'CheckpointLoaderSimple', { title: '##Model/checkpoint', widgets: ['sdxl.safetensors'], outputs: [out(1, 'MODEL', 'MODEL', [10]), out(1, 'CLIP', 'CLIP', [11, 12]), out(1, 'VAE', 'VAE', [13])] }),
      node(2, 'dev.reroute', { inputs: [txt(10, 'flow')], outputs: [out(2, '*', '*', [14])] }),
      node(3, 'CLIPTextEncode', { title: '#01 Prompt', inputs: [txt(11, 'clip')], outputs: [out(3, 'CONDITIONING', 'CONDITIONING', [20])], widgets: ['a cat'] }),
      node(4, 'CLIPTextEncode', { title: '#02 Negative?', inputs: [txt(12, 'clip')], outputs: [out(4, 'CONDITIONING', 'CONDITIONING', [21])], widgets: ['blurry'] }),
      node(5, 'EmptyLatentImage', { title: '#Size::width,height', outputs: [out(5, 'LATENT', 'LATENT', [22])], widgets: [1024, 768, 1] }),
      node(6, 'KSampler', {
        title: '#Sampler',
        inputs: [txt(14, 'model'), txt(20, 'positive'), txt(21, 'negative'), txt(22, 'latent_image')],
        outputs: [out(6, 'LATENT', 'LATENT', [23, 24])],
        widgets: [1234, 'randomize', 30, 7.5, 'euler', 'karras', 0.9]
      }),
      node(7, 'VAEDecode', { inputs: [txt(23, 'samples'), txt(13, 'vae')], outputs: [out(7, 'IMAGE', 'IMAGE', [25])] }),
      node(8, 'LoadImage', { title: '#Input image', inputs: [], outputs: [out(8, 'IMAGE', 'IMAGE', [26]), out(8, 'MASK', 'MASK', [27])] , widgets: ['a.png'] }),
      node(15, 'LoadImageMask', { title: '#Input mask', outputs: [out(15, 'MASK', 'MASK', [28])], widgets: ['alpha', 'm.png'] }),
      node(9, 'ImageCompositeMasked', {
        title: '#Composite::!resize_source',
        inputs: [txt(25, 'destination'), txt(26, 'source'), txt(28, 'mask')],
        outputs: [out(9, 'IMAGE', 'IMAGE', [29])],
        widgets: [0, 0, true]
      }),
      node(16, 'ImageScaleToTotalPixels', {
        title: '#Upscale',
        inputs: [txt(29, 'image')],
        outputs: [out(16, 'IMAGE', 'IMAGE', [30, 31])],
        widgets: ['lanczos', 2.0]
      }),
      node(10, 'SaveImage', { title: 'Result', inputs: [txt(30, 'images')], outputs: [], widgets: ['ComfyShop'] }),
      node(11, 'PreviewImage', { title: 'old preview', mode: 2, inputs: [txt(24, 'images')], outputs: [], widgets: [] }),
      node(12, 'PreviewImage', { title: 'debug', inputs: [txt(31, 'images')], outputs: [], widgets: [] }),
      node(13, 'Note', { title: 'notes', widgets: ['hello'] }),
      node(14, 'MarkdownNote', { widgets: ['# hi'] })
    ],
    links: [
      link(10, 1, 0, 2, 0, 'MODEL'),
      link(11, 1, 1, 3, 0, 'CLIP'),
      link(12, 1, 1, 4, 0, 'CLIP'),
      link(13, 1, 2, 7, 1, 'VAE'),
      link(14, 2, 0, 6, 0, 'MODEL'),
      link(20, 3, 0, 6, 1, 'CONDITIONING'),
      link(21, 4, 0, 6, 2, 'CONDITIONING'),
      link(22, 5, 0, 6, 3, 'LATENT'),
      link(23, 6, 0, 7, 0, 'LATENT'),
      link(24, 6, 0, 11, 0, 'LATENT'),
      link(25, 7, 0, 9, 0, 'IMAGE'),
      link(26, 8, 0, 9, 1, 'IMAGE'),
      link(27, 8, 1, 99, 0, 'MASK'),
      link(28, 15, 0, 9, 2, 'MASK'),
      link(29, 9, 0, 16, 0, 'IMAGE'),
      link(30, 16, 0, 10, 0, 'IMAGE'),
      link(31, 16, 0, 12, 0, 'IMAGE')
    ],
    groups: [],
    config: {},
    extra: {}
  };
}

function subgraphWorkflow() {
  return {
    nodes: [
      node(1, 'CheckpointLoaderSimple', { title: '#Model', outputs: [out(1, 'MODEL', 'MODEL', [1]), out(1, 'CLIP', 'CLIP', []), out(1, 'VAE', 'VAE', [])] , widgets: ['sd15.safetensors'] }),
      node(2, 'CLIPTextEncode', { title: '#Prompt', inputs: [], outputs: [out(2, 'CONDITIONING', 'CONDITIONING', [2])], widgets: ['robot'] }),
      node(50, 'sg-sampler', {
        title: '#Run sampler',
        inputs: [txt(1, 'model'), txt(2, 'positive')],
        outputs: [out(50, 'IMAGE', 'IMAGE', [7])],
        widgets: []
      }),
      node(60, 'SaveImage', { inputs: [txt(7, 'images')], outputs: [], widgets: ['sg'] })
    ],
    links: [
      link(1, 1, 0, 50, 0, 'MODEL'),
      link(2, 2, 0, 50, 1, 'CONDITIONING'),
      link(7, 50, 0, 60, 0, 'IMAGE')
    ],
    definitions: {
      subgraphs: [{
        id: 'sg-sampler',
        name: 'sg-sampler',
        input_node: 900,
        inputs: [{ name: 'model', type: 'MODEL', link: 501 }, { name: 'positive', type: 'CONDITIONING', link: 502 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', link: 503 }],
        output_nodes: [{ id: 52, name: 'IMAGE', slot: 0 }],
        nodes: [
          { id: 900, type: 'PrimitiveNode', inputs: [], outputs: [{ name: '*', type: '*', links: [501, 502] }], widgets_values: [] },
          { id: 51, type: 'KSampler', title: 'inner sampler', inputs: [txt(501, 'model'), txt(502, 'positive')], outputs: [{ name: 'LATENT', type: 'LATENT', links: [503] }], widgets_values: [7, 'fixed', 12, 2.5, 'dpmpp_2m', 'karras', 1] },
          { id: 52, type: 'VAEDecode', inputs: [txt(503, 'samples')], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }], widgets_values: [] }
        ],
        links: [
          link(501, 900, 0, 51, 0, 'MODEL'),
          link(502, 900, 1, 51, 1, 'CONDITIONING'),
          link(503, 51, 0, 52, 0, 'LATENT')
        ]
      }]
    }
  };
}

/* ------------------------------------------------------------------ */
/* title DSL                                                           */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - title DSL');

test('plain title is not exposed', () => {
  const p = Convert.parseTitle({ type: 'Foo' }, 'Foo');
  eq(p.exposed, false);
});

test('# exposes with label', () => {
  const p = Convert.parseTitle({ title: '#Prompt', type: 'CLIPTextEncode' });
  ok(p.exposed && p.label === 'Prompt', 'label');
});

test('#02 order and separator variants', () => {
  eq(Convert.parseTitle({ title: '#02 Negative' }).order, 2, 'order');
  eq(Convert.parseTitle({ title: '#07-Denoise' }).order, 7, 'order from dash');
  eq(Convert.parseTitle({ title: '#9 Upscale' }).order, 9, 'single digit order');
});

test('##Group/Label splits the group', () => {
  const p = Convert.parseTitle({ title: '##Model/checkpoint' });
  eq(p.group, 'Model', 'group');
  eq(p.label, 'checkpoint', 'label');
});

test('? marks the card collapsed', () => {
  eq(Convert.parseTitle({ title: '#Negative?' }).collapsed, true, 'collapsed');
});

test('sd-ppp widgetable title is used when the visible title has no #', () => {
  const p = Convert.parseTitle({
    title: 'Resolution',
    properties: { sdppp_widgetable_title: '#3 Resolution' }
  });
  eq(p.exposed, true, 'exposed');
  eq(p.label, 'Resolution', 'label');
  eq(p.order, 3, 'order');
});

test(':: filters widgets', () => {
  const only = Convert.parseTitle({ title: '#Size::width,height' });
  eq(only.only, ['width', 'height'], 'only');
  const except = Convert.parseTitle({ title: '#Node::!cfg' });
  eq(except.except, ['cfg'], 'except');
});

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - buildModel');

const model = Convert.buildModel(uiWorkflow(), OBJECT_INFO);

test('no hard errors for a healthy workflow (dev.reroute tolerated)', () => {
  eq(model.errors, [], 'errors');
});

test('exposed nodes are ordered by the numeric prefix', () => {
  eq(model.exposed.map((n) => n.title), ['Prompt', 'Negative', 'checkpoint', 'Size', 'Sampler', 'Input image', 'Input mask', 'Composite', 'Upscale'], 'order');
});

test('widget filter keeps only the requested widgets', () => {
  const size = model.exposed.filter((n) => n.title === 'Size')[0];
  eq(size.widgets.map((w) => w.name), ['width', 'height'], 'size widgets');
  const comp = model.exposed.filter((n) => n.title === 'Composite')[0];
  eq(comp.widgets.map((w) => w.name), ['x', 'y'], 'link sockets are not widgets; resize_source was excluded');
});

test('seed widget is detected through control_after_generate', () => {
  const sampler = model.exposed.filter((n) => n.title === 'Sampler')[0];
  const seed = sampler.widgets.filter((w) => w.name === 'seed')[0];
  ok(seed.isSeed, 'isSeed');
  eq(seed.seedControl, 'randomize', 'seed control');
});

test('control_after_generate does not leak into the widget list', () => {
  const sampler = model.exposed.filter((n) => n.title === 'Sampler')[0];
  ok(!sampler.widgets.some((w) => /control_after_generate/.test(w.name)), 'no control widget');
});

test('combo values are exposed for the dropdown', () => {
  const sampler = model.exposed.filter((n) => n.title === 'Sampler')[0];
  const samplerName = sampler.widgets.filter((w) => w.name === 'sampler_name')[0];
  eq(samplerName.kind, 'combo', 'kind');
  eq(samplerName.values, ['euler', 'dpmpp_2m', 'euler_ancestral'], 'values');
  eq(samplerName.value, 'euler', 'value');
});

test('new style COMBO with options in the options object works', () => {
  const upscale = model.exposed.filter((n) => n.title === 'Upscale')[0];
  const method = upscale.widgets.filter((w) => w.name === 'upscale_method')[0];
  eq(method.kind, 'combo', 'kind');
  eq(method.value, 'lanczos', 'value');
});

test('image upload nodes are collected separately', () => {
  eq(model.loadImages.map((n) => n.id), [8], 'loadImages');
  eq(model.loadMasks.map((n) => n.id), [15], 'loadMasks');
});

test('muted nodes never reach the UI model', () => {
  ok(!model.exposed.some((n) => n.title === 'old preview'), 'no muted preview');
});

test('output nodes are found and the sampler-fed one is the default', () => {
  ok(model.outputs.some((o) => o.id === 10), 'SaveImage present');
  eq(model.defaultOutputId, 10, 'default output');
});

test('subgraph free workflow reports ok', () => {
  eq(model.ok, true, 'ok');
});

/* ------------------------------------------------------------------ */
/* prompt                                                              */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - buildPrompt');

const built = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {
  3: { text: 'a dog' },
  5: { width: 512, height: 896 },
  6: { seed: '991', denoise: 0.45 },
  8: { image: 'ps_input.png' },
  15: { image: 'ps_mask.png' }
}, { outputIds: [10] });

test('prompt uses node id keys with class_type', () => {
  ok(built.prompt['3'] && built.prompt['3'].class_type === 'CLIPTextEncode', 'node 3');
});

test('errors are empty', () => {
  eq(built.errors, [], 'errors');
});

test('link through a rgthree dev.reroute resolves to the real origin', () => {
  eq(built.prompt['6'].inputs.model, ['1', 0], 'model link');
});

test('overrides replace widget values', () => {
  eq(built.prompt['3'].inputs.text, 'a dog', 'prompt text');
  eq(built.prompt['5'].inputs.height, 896, 'height');
  eq(built.prompt['6'].inputs.denoise, 0.45, 'denoise');
});

test('seed strings become numbers', () => {
  eq(built.prompt['6'].inputs.seed, 991, 'seed');
});

test('file overrides land in the LoadImage / LoadImageMask nodes', () => {
  eq(built.prompt['8'].inputs.image, 'ps_input.png', 'image');
  eq(built.prompt['15'].inputs.image, 'ps_mask.png', 'mask file');
});

test('forceInput sockets are not treated as widgets', () => {
  ok(!('mask' in built.prompt['9'].inputs) || Array.isArray(built.prompt['9'].inputs.mask), 'mask is a link');
  eq(built.prompt['9'].inputs.mask, ['15', 0], 'mask link');
});

test('muted branches are dropped from the prompt', () => {
  eq('11' in built.prompt, false, 'muted preview gone');
});

test('pruning removes branches the chosen output does not use', () => {
  eq('12' in built.prompt, false, 'debug preview pruned');
  ok('16' in built.prompt, 'upscale kept');
});

test('every referenced node exists in the prompt', () => {
  Object.keys(built.prompt).forEach((id) => {
    Object.keys(built.prompt[id].inputs).forEach((key) => {
      const v = built.prompt[id].inputs[key];
      if (Array.isArray(v)) ok(built.prompt[v[0]], 'node ' + id + '.' + key + ' -> missing ' + v[0]);
    });
  });
});

test('a bogus output id never produces an empty prompt', () => {
  const all = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, { outputIds: [12345] });
  ok(Object.keys(all.prompt).length > 5, 'kept everything');
});

test('a stored control_after_generate string is consumed and never shifts the widgets', () => {
  const sampler = model.exposed.filter((n) => n.title === 'Sampler')[0];
  const values = {};
  sampler.widgets.forEach((w) => { values[w.name] = w.value; });
  eq(values.steps, 30, 'steps after the seed control');
  eq(values.cfg, 7.5, 'cfg');
  eq(values.scheduler, 'karras', 'scheduler');
  eq(values.denoise, 0.9, 'denoise');
  eq(sampler.widgets.filter((w) => w.name === 'seed')[0].seedControl, 'randomize', 'seed control');
});

test('a real count mismatch warns instead of silently shifting values', () => {
  const wf = uiWorkflow();
  wf.nodes.filter((n) => n.id === 5)[0].widgets_values = [1024, 768, 1, 'ghost'];
  const m = Convert.buildModel(wf, OBJECT_INFO);
  has(m.warnings, 'widgets_values length', 'warning');
});

test('a missing trailing widget value falls back to the node default', () => {
  const wf = uiWorkflow();
  wf.nodes.filter((n) => n.id === 6)[0].widgets_values = [1, 'randomize', 20, 6.5, 'euler', 'karras'];
  const m = Convert.buildModel(wf, OBJECT_INFO);
  const sampler = m.exposed.filter((n) => n.title === 'Sampler')[0];
  const denoise = sampler.widgets.filter((w) => w.name === 'denoise')[0];
  eq(denoise.value, 1, 'denoise default');
  eq(m.warnings.filter((w) => /widgets_values length/.test(w)), [], 'no false warning');
});

test('missing custom node produces an actionable error', () => {
  const wf = uiWorkflow();
  const save = wf.nodes.filter((n) => n.id === 10)[0];
  wf.nodes.push(node(77, 'SomeFancyNode', {
    title: '#Fancy',
    inputs: [txt(31, 'image')],
    outputs: [out(77, 'IMAGE', 'IMAGE', [32])],
    widgets: [1]
  }));
  wf.links.push(link(31, 16, 0, 77, 0, 'IMAGE'), link(32, 77, 0, 10, 0, 'IMAGE'));
  save.inputs[0].link = 32;
  const m = Convert.buildModel(wf, OBJECT_INFO);
  has(m.errors, 'SomeFancyNode', 'error text');
  has(m.errors, 'ComfyUI Manager', 'hint');
  const p = Convert.buildPrompt(wf, OBJECT_INFO, {}, { outputIds: [10] });
  has(p.errors, 'SomeFancyNode', 'prompt error');
});

test('unused unknown nodes are skipped instead of blocking the run', () => {
  const wf = uiWorkflow();
  wf.nodes.push(node(78, 'SomeUnusedNode', { title: '#Unused', widgets: [1] }));
  const m = Convert.buildModel(wf, OBJECT_INFO);
  eq(m.errors, [], 'errors');
  has(m.warnings, 'not connected', 'warning');
  ok(!m.exposed.some((n) => n.id === 78), 'not exposed');
  const p = Convert.buildPrompt(wf, OBJECT_INFO, {}, { outputIds: [10] });
  eq(p.errors, [], 'prompt errors');
});

test('defaults are filled in for widgets without a stored value', () => {
  const wf = uiWorkflow();
  wf.nodes.filter((n) => n.id === 5)[0].widgets_values = [];
  const p = Convert.buildPrompt(wf, OBJECT_INFO, {}, { outputIds: [10] });
  eq(p.prompt['5'].inputs.width, 512, 'default width');
  eq(p.prompt['5'].inputs.batch_size, 1, 'default batch');
});

test('out of range numbers are clamped to the widget bounds', () => {
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, { 5: { width: 3, height: 99999 } }, { outputIds: [10] });
  eq(p.prompt['5'].inputs.width, 16, 'clamped to min');
  eq(p.prompt['5'].inputs.height, 8192, 'clamped to max');
});

test('invalid combo values fall back to a valid option instead of erroring', () => {
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, { 6: { sampler_name: 'does_not_exist' } }, { outputIds: [10] });
  eq(p.prompt['6'].inputs.sampler_name, 'euler', 'fallback option');
});

test('file names are allowed for image combos', () => {
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, { 8: { image: 'sub/dir/whatever.png' } }, { outputIds: [10] });
  eq(p.prompt['8'].inputs.image, 'sub/dir/whatever.png', 'kept path');
});

/* ------------------------------------------------------------------ */
/* DynamicCombo (TextGenerate sampling_mode)                           */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - DynamicCombo inputs');

const DYNAMIC_INFO = Object.assign({}, OBJECT_INFO, {
  TextGenerate: {
    input: {
      required: {
        clip: ['CLIP'],
        prompt: ['STRING', { multiline: true, default: '' }],
        max_length: ['INT', { default: 512, min: 1, max: 32768 }],
        sampling_mode: ['COMFY_DYNAMICCOMBO_V3', {
          options: [
            {
              key: 'on',
              inputs: {
                required: {
                  temperature: ['FLOAT', { default: 0.7, min: 0.01, max: 2, step: 0.000001 }],
                  top_k: ['INT', { default: 64, min: 0, max: 1000 }],
                  top_p: ['FLOAT', { default: 0.95, min: 0, max: 1, step: 0.01 }],
                  min_p: ['FLOAT', { default: 0.05, min: 0, max: 1, step: 0.01 }],
                  repetition_penalty: ['FLOAT', { default: 1.05, min: 0, max: 5, step: 0.01 }],
                  seed: ['INT', { default: 0, min: 0, max: 0xffffffffffffffff }],
                  presence_penalty: ['FLOAT', { default: 0, min: 0, max: 5, step: 0.01 }]
                }
              }
            },
            { key: 'off', inputs: { required: {} } }
          ]
        }]
      },
      optional: {
        image: ['IMAGE'],
        thinking: ['BOOLEAN', { default: false }],
        use_default_template: ['BOOLEAN', { default: true }],
        mtp: ['STRING', { default: 'auto' }],
        system_prompt: ['STRING', { forceInput: true }]
      }
    },
    output: ['STRING', 'STRING'],
    name: 'TextGenerate'
  }
});

function textGenWorkflow() {
  return {
    nodes: [
      node(1, 'CheckpointLoaderSimple', {
        widgets: ['sd15.safetensors'],
        outputs: [out(1, 'CLIP', 'CLIP', [10])]
      }),
      node(522, 'TextGenerate', {
        title: '#Text',
        inputs: [txt(10, 'clip')],
        outputs: [out(522, 'generated_text', 'STRING', [])],
        widgets: ['', 512, 'on', 0.7, 20, 0.95, 0, 1.05, 891836227295376, 0, false, true, '2']
      })
    ],
    links: [link(10, 1, 1, 522, 0, 'CLIP')]
  };
}

function namedTextGenWorkflow() {
  const wf = textGenWorkflow();
  wf.nodes[1].widgets_values_named = {
    prompt: '',
    max_length: 512,
    sampling_mode: 'on',
    'sampling_mode.temperature': 0.7,
    'sampling_mode.top_k': 20,
    'sampling_mode.top_p': 0.95,
    'sampling_mode.min_p': 0,
    'sampling_mode.repetition_penalty': 1.05,
    'sampling_mode.seed': 891836227295376,
    'sampling_mode.presence_penalty': 0,
    thinking: false,
    use_default_template: true,
    mtp: '2'
  };
  return wf;
}

test('sampling_mode is sent as the option key, not as an option object', () => {
  const p = Convert.buildPrompt(namedTextGenWorkflow(), DYNAMIC_INFO, {});
  eq(p.errors, [], 'errors');
  eq(p.prompt['522'].inputs.sampling_mode, 'on', 'sampling_mode');
});

test('dynamic combo parameters are sent as flat parent.child inputs', () => {
  const p = Convert.buildPrompt(namedTextGenWorkflow(), DYNAMIC_INFO, {});
  const inputs = p.prompt['522'].inputs;
  eq(inputs['sampling_mode.temperature'], 0.7, 'temperature');
  eq(inputs['sampling_mode.top_k'], 20, 'top_k');
  eq(inputs['sampling_mode.min_p'], 0, 'min_p');
  eq(inputs['sampling_mode.repetition_penalty'], 1.05, 'repetition_penalty');
  eq(inputs['sampling_mode.seed'], 891836227295376, 'seed');
  eq(inputs['sampling_mode.presence_penalty'], 0, 'presence_penalty');
});

test('switching the dynamic combo off removes its parameters', () => {
  const p = Convert.buildPrompt(namedTextGenWorkflow(), DYNAMIC_INFO, { 522: { sampling_mode: 'off' } });
  const inputs = p.prompt['522'].inputs;
  eq(inputs.sampling_mode, 'off', 'sampling_mode');
  ok(!Object.keys(inputs).some((k) => k.indexOf('sampling_mode.') === 0), 'no nested inputs');
});

test('dynamic combo parameters can be overridden by their dotted name', () => {
  const p = Convert.buildPrompt(namedTextGenWorkflow(), DYNAMIC_INFO, { 522: { 'sampling_mode.temperature': '1.2' } });
  eq(p.prompt['522'].inputs['sampling_mode.temperature'], 1.2, 'temperature');
});

test('missing dynamic combo parameters fall back to their defaults', () => {
  const wf = textGenWorkflow();
  wf.nodes[1].widgets_values_named = { prompt: '', max_length: 512, sampling_mode: 'on' };
  const p = Convert.buildPrompt(wf, DYNAMIC_INFO, {});
  eq(p.prompt['522'].inputs['sampling_mode.temperature'], 0.7, 'temperature default');
  eq(p.prompt['522'].inputs['sampling_mode.top_k'], 64, 'top_k default');
});

test('the panel gets a plain on/off dropdown for sampling_mode', () => {
  const m = Convert.buildModel(namedTextGenWorkflow(), DYNAMIC_INFO);
  const gen = m.exposed.filter((n) => n.id === 522)[0];
  ok(gen, 'node exposed');
  const mode = gen.widgets.filter((w) => w.name === 'sampling_mode')[0];
  eq(mode.kind, 'combo', 'kind');
  eq(mode.values, ['on', 'off'], 'values');
  eq(mode.value, 'on', 'value');
});

/* ------------------------------------------------------------------ */
/* Batch runs: seed variation (x2 / x5)                                */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - batch seeds');

function fixedSeedWorkflow() {
  const wf = uiWorkflow();
  wf.nodes.filter((n) => n.id === 6)[0].widgets_values_named = {
    seed: 1234,
    control_after_generate: 'fixed',
    steps: 30,
    cfg: 7.5,
    sampler_name: 'euler',
    scheduler: 'karras',
    denoise: 0.9
  };
  return wf;
}

test('the stored seed is kept when no generator is passed', () => {
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, { outputIds: [10] });
  eq(p.prompt['6'].inputs.seed, 1234, 'seed');
});

test('varySeeds replaces the seed of a non-exposed sampler', () => {
  let n = 0;
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, {
    outputIds: [10],
    varySeeds: () => { n += 1; return 500000 + n; }
  });
  eq(p.prompt['6'].inputs.seed, 500001, 'seed');
  eq(p.prompt['6'].inputs.steps, 30, 'steps untouched');
});

test('every run gets its own seed', () => {
  let n = 0;
  const gen = () => { n += 1; return 700000 + n; };
  const a = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, { outputIds: [10], varySeeds: gen });
  const b = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, { outputIds: [10], varySeeds: gen });
  ok(a.prompt['6'].inputs.seed !== b.prompt['6'].inputs.seed, 'seeds differ');
});

test('a seed marked "fixed" in the workflow is not varied', () => {
  const p = Convert.buildPrompt(fixedSeedWorkflow(), OBJECT_INFO, {}, {
    outputIds: [10],
    varySeeds: () => 999999
  });
  eq(p.prompt['6'].inputs.seed, 1234, 'pinned seed');
});

test('pinnedSeedNodes keeps the seed the user locked in the panel', () => {
  const p = Convert.buildPrompt(uiWorkflow(), OBJECT_INFO, {}, {
    outputIds: [10],
    varySeeds: () => 999999,
    pinnedSeedNodes: [6]
  });
  eq(p.prompt['6'].inputs.seed, 1234, 'pinned seed');
});

test('increment seeds advance by the run index', () => {
  const wf = uiWorkflow();
  const sampler = wf.nodes.filter((n) => n.id === 6)[0];
  sampler.widgets_values = [100, 'increment', 30, 7.5, 'euler', 'karras', 0.9];
  const p = Convert.buildPrompt(wf, OBJECT_INFO, {}, {
    outputIds: [10],
    varySeeds: () => 999999,
    seedRunIndex: 3
  });
  eq(p.prompt['6'].inputs.seed, 103, 'seed advanced');
});

test('DynamicCombo sub-seeds are not re-rolled: the text prompt stays cached', () => {
  const p = Convert.buildPrompt(namedTextGenWorkflow(), DYNAMIC_INFO, {}, {
    varySeeds: () => 424242
  });
  eq(p.prompt['522'].inputs['sampling_mode.seed'], 891836227295376, 'sampling seed untouched');
  eq(p.prompt['522'].inputs['sampling_mode.temperature'], 0.7, 'temperature untouched');
});

/* ------------------------------------------------------------------ */
/* Prompt nodes: primitives and linked widgets                          */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - prompt primitives');

/* A "#Prompt" primitive feeds CLIPTextEncode.text, like the "#2 Promt"
 * nodes in the 9B / FLUX3 workflows. */
function primitivePromptWorkflow() {
  return {
    nodes: [
      node(1, 'CheckpointLoaderSimple', {
        widgets: ['sd15.safetensors'],
        outputs: [out(1, 'CLIP', 'CLIP', [11])]
      }),
      node(20, 'PrimitiveStringMultiline', {
        title: '#Prompt',
        outputs: [out(20, 'STRING', 'STRING', [30])],
        widgets: ['text stored in the workflow']
      }),
      node(21, 'CLIPTextEncode', {
        title: '#Text',
        inputs: [{ name: 'text', type: 'STRING', widget: { name: 'text' }, link: 30 }, txt(11, 'clip')],
        outputs: [out(21, 'CONDITIONING', 'CONDITIONING', [31])],
        widgets: ['text stored in the workflow']
      })
    ],
    links: [link(11, 1, 1, 21, 1, 'CLIP'), link(30, 20, 0, 21, 0, 'STRING')]
  };
}

test('an edited primitive is inlined with the new text, not the stored one', () => {
  const p = Convert.buildPrompt(primitivePromptWorkflow(), OBJECT_INFO, { 20: { value: 'my new prompt' } }, { outputIds: [21] });
  eq(p.errors, [], 'errors');
  eq(p.prompt['21'].inputs.text, 'my new prompt', 'text');
  eq('20' in p.prompt, false, 'primitive is inlined');
});

test('the stored primitive text is used when it is not edited', () => {
  const p = Convert.buildPrompt(primitivePromptWorkflow(), OBJECT_INFO, {}, { outputIds: [21] });
  eq(p.prompt['21'].inputs.text, 'text stored in the workflow', 'text');
});

test('a linked widget input is not offered as an editable field', () => {
  const m = Convert.buildModel(primitivePromptWorkflow(), OBJECT_INFO);
  const enc = m.exposed.filter((n) => n.id === 21)[0];
  ok(enc, 'node exposed');
  eq(enc.widgets.some((w) => w.name === 'text'), false, 'linked text widget hidden');
  const prim = m.exposed.filter((n) => n.id === 20)[0];
  ok(prim.widgets.some((w) => w.name === 'value'), 'the primitive stays editable');
});

/* ------------------------------------------------------------------ */
/* API format                                                          */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - API format workflows');

const apiPrompt = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' }, _meta: { title: '#Model' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'hello', clip: ['1', 1] }, _meta: { title: '#Prompt' } },
  '3': { class_type: 'KSampler', inputs: { seed: 5, steps: 20, cfg: 3.5, sampler_name: 'euler', scheduler: 'karras', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'api' } }
};

test('API format is detected', () => {
  ok(Convert.looksLikeApiFormat(apiPrompt), 'detected');
  eq(Convert.looksLikeApiFormat(uiWorkflow()), false, 'ui format not detected');
});

const apiModel = Convert.buildModel(apiPrompt, OBJECT_INFO);

test('API workflow exposes _meta titles', () => {
  ok(apiModel.ok, 'errors: ' + apiModel.errors.join(' | '));
  eq(apiModel.exposed.map((n) => n.title), ['Model', 'Prompt'], 'exposed');
  has(apiModel.warnings, 'API-format', 'warning');
});

test('API workflow builds a runnable prompt', () => {
  const p = Convert.buildPrompt(apiPrompt, OBJECT_INFO, { 3: { steps: 42 } });
  eq(p.errors, [], 'errors');
  eq(p.prompt['3'].inputs.steps, 42, 'override applied');
  eq(p.prompt['3'].inputs.model, ['1', 0], 'link kept');
});

/* ------------------------------------------------------------------ */
/* subgraphs                                                           */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - subgraph flattening');

const sgWf = subgraphWorkflow();
const sgModel = Convert.buildModel(sgWf, OBJECT_INFO);

test('subgraph workflow no longer hard errors', () => {
  eq(sgModel.errors, [], 'errors');
  ok(sgModel.hasSubgraphs, 'flagged');
});

test('subgraph nodes are flattened and the link chain is rebuilt', () => {
  const p = Convert.buildPrompt(sgWf, OBJECT_INFO, { 1051: { seed: 4242 } });
  eq(p.errors, [], 'errors');
  const samplerId = Object.keys(p.prompt).find((id) => p.prompt[id].class_type === 'KSampler');
  ok(samplerId, 'inlined sampler exists');
  eq(p.prompt[samplerId].inputs.model, ['1', 0], 'outer model wired in');
  eq(p.prompt[samplerId].inputs.positive, ['2', 0], 'outer conditioning wired in');
  eq(p.prompt[samplerId].inputs.seed, 4242, 'override by inner id');
  const save = p.prompt['60'];
  ok(save, 'SaveImage kept');
  ok(Array.isArray(save.inputs.images), 'SaveImage fed by the inlined VAEDecode');
  const decode = Object.keys(p.prompt).find((id) => p.prompt[id].class_type === 'VAEDecode');
  eq(save.inputs.images[0], decode, 'output rewired');
});

/* ------------------------------------------------------------------ */
/* layer tokens                                                        */
/* ------------------------------------------------------------------ */

console.log('\nconvert.js - Photoshop layer tokens');

test('layer names are parsed', () => {
  const tokens = Convert.parseLayerTokens(['Background', '#cs steps=25', '#cs Prompt += cinematic', '#cs Sampler.denoise-=0.1']);
  eq(tokens.length, 3, 'count');
  eq(tokens[1].op, '+=', 'append op');
});

test('tokens map onto exposed widgets', () => {
  const res = Convert.applyLayerTokens(model, Convert.parseLayerTokens(['#cs steps=8', '#cs Prompt=a fox', '#cs nope=1']));
  eq(res.applied.length, 2, 'applied: ' + JSON.stringify(res.applied));
  eq(res.applied[0].value, 8, 'number parsed');
  eq(res.unmatched, ['nope'], 'unmatched');
});

/* ------------------------------------------------------------------ */

console.log('\n' + (failed ? '\x1b[31m' : '\x1b[32m') + passed + ' passed, ' + failed + ' failed\x1b[0m');
if (failed) {
  console.log('\n' + failures.join('\n'));
  process.exit(1);
}
