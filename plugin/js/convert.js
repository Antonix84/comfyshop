/*
 * ComfyShop - ComfyUI workflow -> API prompt converter.
 *
 * Works on ComfyUI "UI format" workflow JSON (the files in
 * F:\AI\ComfyUI\workflows) and the node definitions from /object_info.
 *
 * Pure functions only: no network, no Photoshop, no DOM.
 * Usable both inside the Photoshop UXP panel (window.CSConvert) and from
 * Node (module.exports) for tests.
 */
(function (root, factory) {
  if (typeof document !== "undefined" && root) { root.CSConvert = factory(); return; }
  if (typeof module === "object" && module.exports) { module.exports = factory(); return; }
  root.CSConvert = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PRIMITIVE_TYPES = { INT: 1, FLOAT: 1, STRING: 1, BOOLEAN: 1 };
  var NON_PROMPT_NODES = {
    Reroute: 1,
    PrimitiveNode: 1,
    Note: 1,
    MarkdownNote: 1,
    Comment: 1,
    'Label (rgthree)': 1
  };

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /* A combo spec in this ComfyUI version looks like
   *   [ {"value": ["a","b"], "Count": 2}, {tooltip...} ]
   * but older versions use a plain array: [ ["a","b"], {default:"a"} ].
   * Returns the value list or null. */
  function comboValues(type, opts) {
    if (opts && Array.isArray(opts.options)) return opts.options.slice();
    if (Array.isArray(type)) return type.slice();
    if (isPlainObject(type) && Array.isArray(type.value)) return type.value.slice();
    return null;
  }

  /* Returns true if the input is a widget on the node (not a socket). */
  function isWidgetInput(name, spec) {
    var type = Array.isArray(spec) ? spec[0] : spec;
    var opts = inputOptions(spec);
    if (typeof type === 'string' && PRIMITIVE_TYPES[type]) return true;
    if (comboValues(type, opts)) return true;
    // Some recent ComfyUI nodes use the string "COMBO" and keep the options
    // in the input options object.
    if (typeof type === 'string' && type.toUpperCase() === 'COMBO') return true;
    return false;
  }

  function inputOptions(spec) {
    if (Array.isArray(spec) && isPlainObject(spec[1])) return spec[1];
    if (isPlainObject(spec) && isPlainObject(spec[1])) return spec[1];
    return {};
  }

  /* Build the ordered list of widgets a node exposes, matching the order of
   * node.widgets_values. Extra pseudo-widgets are added for the frontend's
   * "control_after_generate" seed control and for the image upload button,
   * both of which occupy a slot in widgets_values without being API inputs. */
  function widgetSpecs(definition) {
    var specs = [];
    if (!definition || !definition.input) return specs;
    var sections = [definition.input.required, definition.input.optional];
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      if (!section) continue;
      var names = Object.keys(section);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var spec = section[name];
        var opts = inputOptions(spec);
        if (opts.forceInput) continue;
        if (!isWidgetInput(name, spec)) continue;

        var type = Array.isArray(spec) ? spec[0] : spec;
        var values = comboValues(type, opts);
        var isCombo = !!values || String(type).toUpperCase() === 'COMBO';
        var kind = isCombo ? 'combo' : String(type).toLowerCase();

        if (kind === 'string') {
          kind = opts.multiline ? 'text' : 'string';
        }

        specs.push({
          name: name,
          kind: kind,
          type: isCombo ? 'COMBO' : String(type),
          values: values,
          options: opts
        });

        if (opts.control_after_generate) {
          specs.push({
            name: name + '__control_after_generate',
            namedKey: 'control_after_generate',
            kind: 'control',
            type: 'COMBO',
            values: ['fixed', 'increment', 'decrement', 'randomize'],
            options: {},
            controlOf: name
          });
        }
        if (opts.image_upload) {
          specs.push({
            name: name + '__upload',
            namedKey: 'upload',
            kind: 'upload',
            type: 'IMAGEUPLOAD',
            options: {},
            uploadOf: name
          });
        }
      }
    }
    return specs;
  }

  /* Assign widget values (array or dict) to the ordered widget specs. */
  function widgetValues(node, specs) {
    var raw = node.widgets_values;
    var named = node.widgets_values_named;
    var result = [];

    // ComfyUI writes a name->value map alongside the legacy array. Prefer it:
    // it is immune to widget order changes and hidden widgets.
    if (isPlainObject(named)) {
      for (var n = 0; n < specs.length; n++) {
        var spec = specs[n];
        var namedKey = spec.namedKey || spec.name;
        result.push(Object.prototype.hasOwnProperty.call(named, namedKey) ? named[namedKey] : undefined);
      }
      return result;
    }

    if (Array.isArray(raw)) {
      for (var i = 0; i < specs.length; i++) {
        result.push(i < raw.length ? raw[i] : undefined);
      }
    } else if (isPlainObject(raw)) {
      for (var j = 0; j < specs.length; j++) {
        var specJ = specs[j];
        var key = specJ.namedKey || specJ.name;
        result.push(Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined);
      }
    } else {
      for (var k = 0; k < specs.length; k++) result.push(undefined);
    }
    return result;
  }

  function nodeTitle(node) {
    var t = node.title;
    if (t) return String(t);
    return node.type ? String(node.type) : '';
  }

  function makeLinksIndex(workflow) {
    var index = {};
    var links = workflow.links || [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (!Array.isArray(link) || link.length < 6) continue;
      index[link[0]] = link;
    }
    return index;
  }

  function makeNodesIndex(workflow) {
    var index = {};
    var nodes = workflow.nodes || [];
    for (var i = 0; i < nodes.length; i++) index[nodes[i].id] = nodes[i];
    return index;
  }

  /* Nodes with a mode other than 0 are muted (2) or bypassed (4). */
  function isActive(node) {
    return node.mode === undefined || node.mode === 0;
  }

  function outputTypeOf(node, slot) {
    if (!node.outputs || !node.outputs[slot]) return null;
    return node.outputs[slot].type || null;
  }

  function findInputByType(node, type) {
    var inputs = node.inputs || [];
    var fallback = null;
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].link === null || inputs[i].link === undefined) continue;
      if (inputs[i].type === type) return inputs[i];
      if (type === 'IMAGE' && inputs[i].type === 'IMAGE') return inputs[i];
      if (!fallback) fallback = inputs[i];
    }
    return fallback;
  }

  function resolveOrigin(nodeId, slot, ctx, depth) {
    if (depth > 64) return null;
    var node = ctx.nodesById[nodeId];
    if (!node) return null;

    if (node.type === 'PrimitiveNode') {
      var wv = node.widgets_values;
      var value = Array.isArray(wv) ? wv[0] : (isPlainObject(wv) ? wv.value : undefined);
      return { literal: value };
    }

    if (node.type === 'Reroute') {
      var rin = node.inputs && node.inputs[0];
      if (!rin || rin.link === null || rin.link === undefined) return null;
      return resolveLink(rin.link, ctx, depth + 1);
    }

    if (node.mode === 4) {
      var t = outputTypeOf(node, slot);
      var src = findInputByType(node, t);
      if (!src) return null;
      return resolveLink(src.link, ctx, depth + 1);
    }

    if (node.mode === 2) return null;

    return { nodeId: node.id, slot: slot };
  }

  function resolveLink(linkId, ctx, depth) {
    if (depth === undefined) depth = 0;
    var link = ctx.linksById[linkId];
    if (!link) return null;
    return resolveOrigin(link[1], link[2], ctx, depth + 1);
  }

  /* Work out which node types produce images and are terminal. */
  function isImageOutput(definition) {
    if (!definition) return false;
    if (!definition.output_node) return false;
    var out = definition.output;
    if (typeof out === 'string') return out === 'IMAGE';
    if (Array.isArray(out)) return out.indexOf('IMAGE') >= 0;
    return false;
  }

  function isSamplerType(type) {
    if (!type) return false;
    return type.indexOf('KSampler') >= 0 || type.indexOf('SamplerCustom') >= 0 || type.indexOf('Sampler') >= 0;
  }

  /* True when `nodeId` can be reached by walking upstream from `fromId`. */
  function reachableUpstream(workflow, fromId, predicate, nodesById, linksById) {
    var seen = {};
    var stack = [fromId];
    while (stack.length) {
      var id = stack.pop();
      if (seen[id]) continue;
      seen[id] = true;
      var node = nodesById[id];
      if (!node) continue;
      if (predicate(node)) return true;
      var inputs = node.inputs || [];
      for (var i = 0; i < inputs.length; i++) {
        var linkId = inputs[i].link;
        if (linkId === null || linkId === undefined) continue;
        var link = linksById[linkId];
        if (link) stack.push(link[1]);
      }
    }
    return false;
  }

  /* Build the UI model: exposed ("#") parameter nodes, image inputs,
   * output nodes and any problems. */
  function buildModel(workflow, objectInfo) {
    var warnings = [];
    var errors = [];

    if (!workflow || !Array.isArray(workflow.nodes)) {
      return { errors: ['Workflow JSON has no "nodes" array.'], warnings: warnings };
    }
    if (workflow.definitions && Array.isArray(workflow.definitions.subgraphs) && workflow.definitions.subgraphs.length) {
      errors.push('This workflow uses ComfyUI subgraphs and cannot be converted by ComfyShop yet. ' +
        'Open it in ComfyUI and export it in API format, or use a workflow without subgraphs.');
    }

    var nodesById = makeNodesIndex(workflow);
    var linksById = makeLinksIndex(workflow);

    var exposed = [];
    var loadImages = [];
    var outputs = [];
    var unknownTypes = {};

    var nodes = workflow.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.type) continue;
      if (!isActive(node)) continue;
      if (NON_PROMPT_NODES[node.type]) continue;

      var definition = objectInfo[node.type];
      if (!definition) {
        unknownTypes[node.type] = (unknownTypes[node.type] || 0) + 1;
      }

      var title = nodeTitle(node);
      var specs = definition ? widgetSpecs(definition) : [];
      var rawValues = widgetValues(node, specs);

      var uiWidgets = [];
      for (var w = 0; w < specs.length; w++) {
        var spec = specs[w];
        if (spec.kind === 'control' || spec.kind === 'upload') continue;
        var widget = {
          name: spec.name,
          kind: spec.kind,
          values: spec.values,
          options: spec.options || {},
          index: w,
          value: rawValues[w],
          isSeed: !!spec.options.control_after_generate
        };
        if (widget.isSeed) {
          var controlSpec = specs[w + 1];
          if (controlSpec && controlSpec.kind === 'control') {
            widget.seedControl = rawValues[w + 1];
          }
        }
        uiWidgets.push(widget);
      }

      if (definition && definition.input && definition.input.required) {
        var imageInput = definition.input.required.image;
        var isLoadImage = imageInput && isPlainObject(imageInput[1] || {}) && (imageInput[1] || {}).image_upload;
        if (isLoadImage || node.type === 'LoadImage') {
          loadImages.push({
            id: node.id,
            title: title,
            widgets: uiWidgets,
            imageValue: pickWidgetValue(uiWidgets, 'image')
          });
        }
      }

      if (definition && isImageOutput(definition)) {
        outputs.push({
          id: node.id,
          type: node.type,
          title: title,
          // Prefer outputs that come after a sampler: the control-map
          // previews (SaveImage fed by preprocessors) are not the result.
          afterSampler: reachableUpstream(workflow, node.id, function (n) {
            return isSamplerType(n.type);
          }, nodesById, linksById)
        });
      }

      if (title.charAt(0) === '#') {
        exposed.push({
          id: node.id,
          type: node.type,
          title: title.replace(/^#\s*/, ''),
          rawTitle: title,
          widgets: uiWidgets,
          isLoadImage: node.type === 'LoadImage'
        });
      }
    }

    var unknownList = Object.keys(unknownTypes);
    if (unknownList.length) {
      errors.push('Unknown node types (missing custom nodes on the ComfyUI server): ' + unknownList.join(', '));
    }

    exposed.sort(function (a, b) {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });

    var defaultOutputId = null;
    for (var oi = 0; oi < outputs.length; oi++) {
      if (outputs[oi].afterSampler) { defaultOutputId = outputs[oi].id; break; }
    }
    if (defaultOutputId === null && outputs.length) defaultOutputId = outputs[0].id;

    return {
      exposed: exposed,
      loadImages: loadImages,
      outputs: outputs,
      defaultOutputId: defaultOutputId,
      warnings: warnings,
      errors: errors,
      nodeCount: nodes.length,
      hasSubgraphs: !!(workflow.definitions && workflow.definitions.subgraphs && workflow.definitions.subgraphs.length)
    };
  }

  function pickWidgetValue(widgets, name) {
    for (var i = 0; i < widgets.length; i++) if (widgets[i].name === name) return widgets[i].value;
    return undefined;
  }

  /* Convert a UI workflow to the /prompt API payload.
   *
   * overrides: { "<nodeId>": { "<widgetName>": value } }
   * Returns { prompt, errors, warnings }.
   */
  function buildPrompt(workflow, objectInfo, overrides) {
    var result = { prompt: {}, errors: [], warnings: [] };
    overrides = overrides || {};

    if (!workflow || !Array.isArray(workflow.nodes)) {
      result.errors.push('Workflow JSON has no "nodes" array.');
      return result;
    }

    var ctx = {
      nodesById: makeNodesIndex(workflow),
      linksById: makeLinksIndex(workflow)
    };

    var nodes = workflow.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.type) continue;
      if (NON_PROMPT_NODES[node.type]) continue;
      if (!isActive(node)) continue;

      var definition = objectInfo[node.type];
      if (!definition) {
        result.errors.push('Node #' + node.id + ' has unknown type "' + node.type + '". ' +
          'Install the missing custom node on the ComfyUI server.');
        continue;
      }

      var specs = widgetSpecs(definition);
      var rawValues = widgetValues(node, specs);
      var nodeOverrides = overrides[node.id] || overrides[String(node.id)] || {};
      var inputs = {};

      // 1. Socket connections (and literals coming from PrimitiveNode).
      var nodeInputs = node.inputs || [];
      for (var ni = 0; ni < nodeInputs.length; ni++) {
        var input = nodeInputs[ni];
        if (input.link === null || input.link === undefined) continue;
        var resolved = resolveLink(input.link, ctx, 0);
        if (!resolved) continue;
        if (Object.prototype.hasOwnProperty.call(resolved, 'literal')) {
          if (resolved.literal !== undefined) inputs[input.name] = resolved.literal;
        } else {
          inputs[input.name] = [String(resolved.nodeId), resolved.slot];
        }
      }

      // 2. Widget values (unless a socket already feeds that input).
      for (var w = 0; w < specs.length; w++) {
        var spec = specs[w];
        if (spec.kind === 'control' || spec.kind === 'upload') continue;
        if (inputs[spec.name] !== undefined) continue;

        var value;
        if (Object.prototype.hasOwnProperty.call(nodeOverrides, spec.name)) {
          value = nodeOverrides[spec.name];
        } else {
          value = rawValues[w];
        }
        if (value === undefined) continue;

        // Combos must be strings (file names, sampler names...). Numbers stay.
        if (spec.kind === 'combo' && value !== null && typeof value !== 'string') {
          value = String(value);
        }
        inputs[spec.name] = value;
      }

      result.prompt[String(node.id)] = {
        class_type: node.type,
        inputs: inputs
      };
    }

    // 3. Sanity check: every linked origin must exist in the prompt.
    var ids = Object.keys(result.prompt);
    for (var p = 0; p < ids.length; p++) {
      var entry = result.prompt[ids[p]];
      var keys = Object.keys(entry.inputs);
      for (var k = 0; k < keys.length; k++) {
        var v = entry.inputs[keys[k]];
        if (Array.isArray(v) && v.length === 2) {
          if (!result.prompt[v[0]]) {
            result.errors.push('Node #' + ids[p] + ' input "' + keys[k] + '" points at missing node #' + v[0] + '.');
          }
        }
      }
    }

    return result;
  }

  return {
    buildModel: buildModel,
    buildPrompt: buildPrompt,
    widgetSpecs: widgetSpecs,
    isImageOutput: isImageOutput
  };
});

