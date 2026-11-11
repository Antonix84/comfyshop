/*
 * ComfyShop - ComfyUI workflow -> API prompt converter.
 *
 * Pure functions only: no network, no Photoshop, no DOM.
 * Usable inside the Photoshop UXP panel (window.CSConvert) and from Node
 * (module.exports) for tests.
 *
 * What it accepts:
 *   - UI format workflow JSON  ({ nodes: [...], links: [...] })
 *   - API format JSON          ({ "3": { class_type, inputs }, ... })
 *   - Workflows that use ComfyUI subgraphs (definitions.subgraphs) - they get
 *     flattened into plain nodes before conversion.
 *
 * Only nodes that feed the selected output are sent to ComfyUI, so unrelated
 * nodes with missing custom packs no longer block a run.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = mod; return; }
  root.CSConvert = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PRIMITIVE_TYPES = { INT: 1, FLOAT: 1, STRING: 1, BOOLEAN: 1, CUSTOM: 1 };

  /* Nodes that never appear in the API prompt but have to be traversed. */
  var PASSTHROUGH_TYPES = {
    Reroute: 1,
    PrimitiveNode: 1,
    Note: 1,
    MarkdownNote: 1,
    Comment: 1
  };

  /* Output node types recognised without /object_info (offline analysis). */
  var KNOWN_IMAGE_OUTPUTS = {
    SaveImage: 1, PreviewImage: 1, SaveAnimatedWEBP: 1, SaveAnimatedPNG: 1,
    QuickSave: 1, 'SaveImage (rgthree)': 1, PGSaveImage: 1, EasySaveImage: 1,
    VHS_VideoCombine: 1, SaveVideo: 1, CreateVideo: 1
  };

  /* Output payload keys used by history entries, in priority order. */
  var IMAGE_KEYS = ['images', 'gifs', 'videos', 'files'];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  function round(v, digits) {
    var p = Math.pow(10, digits);
    return Math.round(Number(v) * p) / p;
  }

  /* ------------------------------------------------------------------ */
  /* node title DSL                                                      */
  /* ------------------------------------------------------------------ */
  /*
   * Title conventions understood by ComfyShop (set the title in ComfyUI or
   * in Photoshop - every part after "#" is optional):
   *
   *   #Prompt                     expose the node, label "Prompt"
   *   #02 Prompt / #02-Prompt     expose + sort order 2 (UI grouping)
   *   ##Style/Prompt              expose inside UI group "Style"
   *   #KSampler::seed,steps       expose only these widgets
   *   #KSampler::!cfg             expose everything except "cfg"
   *   #Prompt?                    exposed but collapsed by default
   *   (no "#")                    node is not exposed
   *
   * Widgets can be narrowed down too: rename an input label inside a "#"
   * node so that it starts with "#" (e.g. "#megapixels"). If at least one
   * input is marked, only marked widgets are shown; otherwise all widgets
   * are shown as before.
   */
  function titleSource(node, fallbackType) {
    var raw = node && node.title ? String(node.title) : (fallbackType || '');
    if (raw.trim().charAt(0) === '#') return raw;
    /* sd-ppp stores the marker in a property and keeps the visible node title
     * clean. Workflows made with it still work out of the box. */
    var props = node && node.properties;
    if (props) {
      var marked = props.sdppp_widgetable_title || props['sdppp_widgetable_title'];
      if (marked && String(marked).trim().charAt(0) === '#') return String(marked);
    }
    return raw;
  }

  function parseTitle(node, fallbackType) {
    var raw = titleSource(node, fallbackType);
    var t = raw.trim();
    var out = {
      raw: raw,
      exposed: false,
      collapsed: false,
      label: t,
      group: '',
      order: 1000,
      explicitOrder: false,
      only: null,
      except: null,
      isNode: false
    };
    if (t.charAt(0) !== '#') return out;
    out.exposed = true;
    out.isNode = true;

    if (t.charAt(1) === '#') {
      out.group = 'default';
      t = t.slice(2);
    } else {
      t = t.slice(1);
    }
    t = t.trim();

    var groupMatch = t.match(/^([^/]{1,40})\/(.+)$/);
    if (groupMatch) {
      out.group = groupMatch[1].trim();
      t = groupMatch[2].trim();
    }

    var orderMatch = t.match(/^(\d{1,3})[\s._-]*(.*)$/);
    if (orderMatch) {
      out.order = parseInt(orderMatch[1], 10);
      out.explicitOrder = true;
      t = orderMatch[2].trim();
    }

    if (/\?\s*$/.test(t)) {
      out.collapsed = true;
      t = t.replace(/\?\s*$/, '').trim();
    }

    var widgetMatch = t.match(/^(.*?)::(.*)$/);
    if (widgetMatch) {
      t = widgetMatch[1].trim();
      var names = widgetMatch[2].split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      var except = names.filter(function (n) { return n.charAt(0) === '!'; })
        .map(function (n) { return n.slice(1).trim(); });
      var only = names.filter(function (n) { return n.charAt(0) !== '!'; });
      if (only.length) out.only = only;
      if (except.length) out.except = except;
    }

    out.label = t || out.label;
    return out;
  }

  /*
   * Per-widget "#" markers.
   *
   * ComfyUI stores a renamed widget label on the node input, e.g.
   *   { "name": "megapixels", "label": "#megapixels" }
   * When a node title starts with "#", only widgets whose input carries such
   * a marker are shown/edited in the panel. Nodes without any marked input
   * keep their old behaviour (all widgets), so existing workflows still work.
   */
  function hashName(value) {
    var s = value === undefined || value === null ? '' : String(value).trim();
    if (s.charAt(0) !== '#') return null;
    return s.replace(/^#+\s*/, '').trim();
  }

  function widgetMarks(node) {
    var marks = {};
    var inputs = node && node.inputs;
    if (!Array.isArray(inputs)) return marks;
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (!input || input.name === undefined || input.name === null) continue;
      var label = hashName(input.label);
      if (label === null) label = hashName(input.localized_name);
      if (label === null) label = hashName(input.name);
      if (label === null) continue;
      marks[String(input.name)] = label || String(input.name);
    }
    return marks;
  }

  /* ------------------------------------------------------------------ */
  /* format detection / normalisation                                    */
  /* ------------------------------------------------------------------ */

  function looksLikeApiFormat(obj) {
    if (!isPlainObject(obj)) return false;
    if (Array.isArray(obj.nodes)) return false;
    var keys = Object.keys(obj);
    if (!keys.length) return false;
    var hits = 0;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (isPlainObject(v) && typeof v.class_type === 'string') hits++;
    }
    return hits > 0 && hits >= keys.length * 0.5;
  }

  function isLinkRef(v) {
    return Array.isArray(v) && v.length === 2 &&
      (typeof v[0] === 'number' || /^\d+$/.test(String(v[0]))) &&
      typeof v[1] === 'number';
  }

  /* Convert an API prompt into an equivalent UI workflow so that the rest of
   * the pipeline (model building, overrides, re-serialisation) has a single
   * code path. */
  function apiToUI(prompt) {
    var nodes = [];
    var links = [];
    var linkId = 1;
    var ids = Object.keys(prompt);

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var entry = prompt[id] || {};
      var inputs = isPlainObject(entry.inputs) ? entry.inputs : {};
      var names = Object.keys(inputs);
      var nodeInputs = [];
      var widgets = [];

      for (var n = 0; n < names.length; n++) {
        var name = names[n];
        var value = inputs[name];
        if (isLinkRef(value)) {
          var lid = linkId++;
          nodeInputs.push({ name: name, type: '*', link: lid });
          links.push([lid, String(value[0]), value[1], Number(id) || parseInt(id, 10) || id, 0, '*']);
        } else {
          nodeInputs.push({ name: name, type: name, link: null, widget: true });
          widgets.push(value);
        }
      }

      var numeric = /^\d+$/.test(id);
      nodes.push({
        id: numeric ? parseInt(id, 10) : id,
        type: entry.class_type,
        title: (entry._meta && (entry._meta.title || entry._meta.name)) || null,
        mode: 0,
        inputs: nodeInputs.filter(function (x) { return !x.widget; }),
        widgets_values: widgets,
        _apiOrder: widgets.length ? names.filter(function (nm) { return !isLinkRef(inputs[nm]); }) : [],
        _apiInputNames: names
      });
    }

    /* Fix real slot numbers on the links (we guessed 0 above). */
    for (var l = 0; l < links.length; l++) {
      var target = nodes.filter(function (nd) { return String(nd.id) === String(links[l][3]); })[0];
      if (!target) continue;
      var inputName = null;
      for (var ti = 0; ti < target.inputs.length; ti++) {
        if (target.inputs[ti].link === links[l][0]) inputName = target.inputs[ti].name;
      }
      links[l][2] = links[l][2] === 0 ? 0 : links[l][2];
      if (inputName) links[l][4] = 0;
    }

    return { nodes: nodes, links: links, groups: [], config: {}, _convertedFromApi: true };
  }

  /* ------------------------------------------------------------------ */
  /* subgraph flattening                                                 */
  /* ------------------------------------------------------------------ */

  function findSubgraph(defs, node) {
    if (!defs || !defs.length) return null;
    var wanted = [node.type, node.subgraph_id, node.properties && node.properties.subgraph_id];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      for (var w = 0; w < wanted.length; w++) {
        if (wanted[w] == null) continue;
        if (String(d.id) === String(wanted[w]) || String(d.name) === String(wanted[w])) return d;
      }
    }
    return null;
  }

  function linkMapOf(links) {
    var m = {};
    for (var i = 0; i < (links || []).length; i++) {
      var l = links[i];
      if (Array.isArray(l) && l.length >= 6) m[l[0]] = l;
    }
    return m;
  }

  /*
   * Inline ComfyUI subgraphs so the converter only ever sees plain nodes.
   *
   * A subgraph node is replaced by the nodes of its definition:
   *   - every inner link that starts at the subgraph "input node" is rewired
   *     to whatever feeds the matching input of the outer node;
   *   - every outer link that starts at the subgraph node is rewired to the
   *     matching "output node" inside the definition;
   *   - inner node ids are offset so they never collide with the outer graph.
   * Anything that cannot be mapped is reported instead of silently dropped.
   */
  function flattenSubgraphs(workflow) {
    var result = { workflow: workflow, errors: [], warnings: [], expanded: 0 };
    var defs = workflow && workflow.definitions && workflow.definitions.subgraphs;
    if (!Array.isArray(defs) || !defs.length || !Array.isArray(workflow.nodes)) return result;

    var maxId = 0;
    workflow.nodes.forEach(function (n) {
      var v = typeof n.id === 'number' ? n.id : parseInt(n.id, 10);
      if (!isNaN(v) && v > maxId) maxId = v;
    });

    /* Inlined nodes get predictable ids: BASE + definitionIndex * STRIDE +
     * inner id. In a small graph inner node 51 of the first subgraph becomes
     * #1051 - which is what "#cs 1051.seed=..." and saved values refer to. */
    var STRIDE = 1000;
    var BASE = (Math.floor(maxId / STRIDE) + 1) * STRIDE;

    var links = (workflow.links || []).slice().map(function (l) { return Array.isArray(l) ? l.slice() : l; });
    var linkIndex = linkMapOf(links);
    var nodes = [];
    var warnings = [];
    var errors = [];
    var expanded = 0;

    function num(v, fallback) {
      var n = Number(v);
      return isNaN(n) ? fallback : n;
    }

    /* Old exports store links as arrays, newer ones as objects
     * ({id, origin_id, origin_slot, target_id, target_slot, type}). */
    function normalizeSubgraphLink(l) {
      if (Array.isArray(l) && l.length >= 6) {
        return { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] };
      }
      if (l && typeof l === 'object') {
        var id = l.id !== undefined ? l.id : l.link_id;
        var origin = l.origin_id !== undefined ? l.origin_id : (l.originId !== undefined ? l.originId : l.source);
        var target = l.target_id !== undefined ? l.target_id : (l.targetId !== undefined ? l.targetId : l.target);
        if (id === undefined || origin === undefined || target === undefined) return null;
        return {
          id: id,
          origin_id: origin,
          origin_slot: l.origin_slot !== undefined ? l.origin_slot : l.originSlot,
          target_id: target,
          target_slot: l.target_slot !== undefined ? l.target_slot : l.targetSlot,
          type: l.type
        };
      }
      return null;
    }

    function inputNodeId(def) {
      if (def.input_node !== undefined && def.input_node !== null) return def.input_node;
      if (def.inputNode && def.inputNode.id !== undefined) return def.inputNode.id;
      return null;
    }

    function outputNodeId(def) {
      if (def.output_node !== undefined && def.output_node !== null) return def.output_node;
      if (def.outputNode && def.outputNode.id !== undefined) return def.outputNode.id;
      return null;
    }

    /* Inner link ids are only unique inside a subgraph definition - two
     * definitions can both contain link 167. Inlined links therefore get a
     * fresh id and the inner node references are remapped below. */
    var maxLinkId = 0;
    links.forEach(function (l) {
      var v = Number(Array.isArray(l) ? l[0] : (l && l.id));
      if (!isNaN(v) && v > maxLinkId) maxLinkId = v;
    });
    defs.forEach(function (d) {
      (d.links || []).forEach(function (raw) {
        var l = normalizeSubgraphLink(raw);
        if (l && Number(l.id) > maxLinkId) maxLinkId = Number(l.id);
      });
    });
    var nextLinkId = maxLinkId + 1;

    for (var i = 0; i < workflow.nodes.length; i++) {
      var node = workflow.nodes[i];
      var def = findSubgraph(defs, node);
      if (!def) { nodes.push(node); continue; }

      var innerNodes = def.nodes || [];
      var idOffset = BASE + defs.indexOf(def) * STRIDE;
      var remap = {};
      innerNodes.forEach(function (inn) {
        var innId = typeof inn.id === 'number' ? inn.id : parseInt(inn.id, 10);
        if (isNaN(innId) || innId >= STRIDE) {
          warnings.push('Subgraph "' + (def.name || def.id) + '": node id ' + inn.id + ' is out of range, it was remapped to #' + idOffset + '.');
          innId = 0;
        }
        remap[String(inn.id)] = idOffset + innId;
      });

      var virtualIn = inputNodeId(def);
      var virtualOut = outputNodeId(def);
      var defLinks = (def.links || []).map(normalizeSubgraphLink).filter(Boolean);
      var defLinkById = {};
      defLinks.forEach(function (l) { defLinkById[String(l.id)] = l; });

      /* Old definitions may omit inputNode/outputNode; ComfyUI uses
       * negative ids for these virtual nodes. */
      if (virtualIn === null) {
        for (var vin = 0; vin < defLinks.length; vin++) {
          if (Number(defLinks[vin].origin_id) < 0) { virtualIn = defLinks[vin].origin_id; break; }
        }
      }
      if (virtualOut === null) {
        for (var vout = 0; vout < defLinks.length; vout++) {
          if (Number(defLinks[vout].target_id) < 0) { virtualOut = defLinks[vout].target_id; break; }
        }
      }

      /* Unique ids for every inlined link of this subgraph instance. */
      var linkRemap = {};
      defLinks.forEach(function (l) { linkRemap[String(l.id)] = nextLinkId++; });

      /* 1. copy inner links, remapping node + link ids. Links from/to the
       * virtual input/output nodes are skipped; they connect to the outer graph. */
      defLinks.forEach(function (l) {
        if (virtualIn !== null && String(l.origin_id) === String(virtualIn)) return;
        if (virtualOut !== null && String(l.target_id) === String(virtualOut)) return;
        var origin = remap[String(l.origin_id)];
        var target = remap[String(l.target_id)];
        if (origin === undefined || target === undefined) return;
        var newId = linkRemap[String(l.id)];
        var copy = [newId, origin, num(l.origin_slot, 0), target, num(l.target_slot, 0), l.type];
        links.push(copy);
        linkIndex[String(newId)] = copy;
      });

      /* 2. outer inputs -> consumers of the subgraph input node */
      var inputDefs = def.inputs || [];
      (node.inputs || []).forEach(function (outer, outerIndex) {
        if (outer.link === null || outer.link === undefined) return;
        var outerLink = linkIndex[String(outer.link)];
        if (!outerLink) return;

        var defInput = null;
        for (var di = 0; di < inputDefs.length; di++) {
          if (String(inputDefs[di].name) === String(outer.name)) { defInput = inputDefs[di]; break; }
        }
        if (!defInput && inputDefs[outerIndex]) defInput = inputDefs[outerIndex];

        var ids = [];
        if (defInput && Array.isArray(defInput.linkIds)) {
          ids = defInput.linkIds.map(String);
        }
        if (!ids.length) {
          /* Older definitions only have slot numbers on the inner links. */
          var slot = -1;
          for (var si = 0; si < inputDefs.length; si++) {
            if (String(inputDefs[si].name) === String(outer.name)) { slot = si; break; }
          }
          if (slot < 0) slot = outerIndex;
          defLinks.forEach(function (l) {
            if (virtualIn !== null && String(l.origin_id) === String(virtualIn) &&
                num(l.origin_slot, 0) === slot) ids.push(String(l.id));
          });
        }

        var wired = 0;
        ids.forEach(function (lid) {
          var inner = defLinkById[lid];
          if (!inner) return;
          var target = remap[String(inner.target_id)];
          if (target === undefined) return;
          var newLid = linkRemap[lid];
          if (newLid === undefined) return;
          var created = [newLid, outerLink[1], outerLink[2], target, num(inner.target_slot, 0), inner.type];
          links.push(created);
          linkIndex[String(newLid)] = created;
          wired++;
        });
        if (!wired) warnings.push('Subgraph "' + (def.name || def.id) + '": nothing consumes input "' + outer.name + '".');
      });

      /* 3. outer outputs -> the definition output nodes / inner link sources */
      var oldOutDefs = def.output_nodes || [];
      var newOutDefs = def.outputs || [];
      (node.outputs || []).forEach(function (outer, index) {
        var source = null;

        var defOut = null;
        for (var no = 0; no < newOutDefs.length; no++) {
          var candOut = newOutDefs[no];
          if (String(candOut.name) === String(outer.name) ||
              (candOut.label && outer.label && String(candOut.label) === String(outer.label))) {
            defOut = candOut;
            break;
          }
        }
        if (!defOut && newOutDefs[index]) defOut = newOutDefs[index];
        if (defOut && Array.isArray(defOut.linkIds) && defOut.linkIds.length) {
          var innerOut = defLinkById[String(defOut.linkIds[0])];
          if (innerOut) source = { id: innerOut.origin_id, slot: num(innerOut.origin_slot, 0) };
        }

        if (!source) {
          var src = null;
          for (var o = 0; o < oldOutDefs.length; o++) {
            var cand = oldOutDefs[o];
            var nm = cand.name || cand.code || cand.slot_name;
            if (String(nm) === String(outer.name)) { src = cand; break; }
          }
          if (!src && oldOutDefs[index]) src = oldOutDefs[index];
          if (src) {
            source = {
              id: src.id,
              slot: src.slot === undefined ? (src.data && src.data.slot) || 0 : src.slot
            };
          }
        }

        if (!source) {
          warnings.push('Subgraph "' + (def.name || def.id) + '": output "' + outer.name + '" is not mapped, downstream nodes will lose their input.');
          return;
        }
        var remappedSource = remap[String(source.id)];
        if (remappedSource === undefined) {
          warnings.push('Subgraph "' + (def.name || def.id) + '": output "' + outer.name + '" comes from an unknown inner node #' + source.id + '.');
          return;
        }
        (outer.links || []).forEach(function (lid) {
          var l = linkIndex[String(lid)];
          if (!l) return;
          l[1] = remappedSource;
          l[2] = num(source.slot, 0);
        });
      });

      /* 4. copy the inner nodes themselves */
      innerNodes.forEach(function (inn) {
        if (virtualIn !== null && String(inn.id) === String(virtualIn)) return;
        if (virtualOut !== null && String(inn.id) === String(virtualOut)) return;
        nodes.push({
          id: remap[String(inn.id)],
          type: inn.type,
          title: inn.title || null,
          mode: inn.mode === undefined ? 0 : inn.mode,
          inputs: (inn.inputs || []).map(function (inp) {
            var copy = {
              name: inp.name,
              type: inp.type,
              link: inp.link === null || inp.link === undefined ? inp.link
                : (linkRemap[String(inp.link)] !== undefined ? linkRemap[String(inp.link)] : inp.link)
            };
            if (inp.label !== undefined) copy.label = inp.label;
            if (inp.localized_name !== undefined) copy.localized_name = inp.localized_name;
            if (inp.widget !== undefined) copy.widget = inp.widget;
            return copy;
          }),
          outputs: (inn.outputs || []).map(function (o) {
            return {
              name: o.name,
              type: o.type,
              links: (o.links || []).map(function (lid) {
                return linkRemap[String(lid)] !== undefined ? linkRemap[String(lid)] : lid;
              })
            };
          }),
          widgets_values: (inn.widgets_values || []).slice(),
          widgets_values_named: inn.widgets_values_named,
          properties: inn.properties || {}
        });
      });

      /* the subgraph node itself is replaced by a comment node we drop */
      expanded++;
      if (!innerNodes.length) errors.push('Subgraph "' + (def.name || def.id) + '" has no nodes.');
    }

    if (!expanded) errors.push('The workflow references subgraphs but no node matches a definition.');

    result.workflow = { nodes: nodes, links: links, groups: workflow.groups || [], _flattenedSubgraphs: expanded };
    result.errors = errors;
    result.warnings = warnings;
    result.expanded = expanded;
    return result;
  }


  /* ------------------------------------------------------------------ */
  /* object_info helpers                                                 */
  /* ------------------------------------------------------------------ */

  function inputOptions(spec) {
    if (Array.isArray(spec) && isPlainObject(spec[1])) return spec[1];
    if (isPlainObject(spec) && isPlainObject(spec[1])) return spec[1];
    return {};
  }

  function comboValues(type, opts) {
    if (opts) {
      if (Array.isArray(opts.options)) return opts.options.slice();
      if (Array.isArray(opts.values)) return opts.values.slice();
    }
    if (Array.isArray(type)) return type.slice();
    if (isPlainObject(type) && Array.isArray(type.value)) return type.value.slice();
    return null;
  }

  /* DynamicCombo (COMFY_DYNAMICCOMBO_V3) - a combo whose options carry their
   * own inputs, e.g. TextGenerate's "sampling_mode". Options are objects
   * { key, inputs }, so they must not be treated as plain combo values. */
  function dynamicComboOptions(type, opts) {
    if (upper(type) !== 'COMFY_DYNAMICCOMBO_V3') return null;
    var list = opts && Array.isArray(opts.options) ? opts.options : null;
    if (!list) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var option = list[i];
      if (!option || typeof option.key !== 'string') continue;
      out.push(option);
    }
    return out.length ? out : null;
  }

  function isWidgetInput(name, spec) {
    var type = Array.isArray(spec) ? spec[0] : spec;
    var opts = inputOptions(spec);
    if (opts.forceInput) return false;
    if (dynamicComboOptions(type, opts)) return true;
    if (typeof type === 'string' && PRIMITIVE_TYPES[type]) return true;
    if (comboValues(type, opts)) return true;
    if (typeof type === 'string' && upper(type) === 'COMBO') return true;
    return false;
  }

  function upper(t) { return String(t == null ? '' : t).toUpperCase(); }

  function widgetSpecs(definition) {
    var specs = [];
    if (!definition || !definition.input) return specs;
    var sections = [definition.input.required, definition.input.optional];

    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      if (!section || !isPlainObject(section)) continue;
      var names = Object.keys(section);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var spec = section[name];
        var opts = inputOptions(spec);
        if (!isWidgetInput(name, spec)) continue;

        var type = Array.isArray(spec) ? spec[0] : spec;
        var values = comboValues(type, opts);
        var isCombo = !!values || upper(type) === 'COMBO';
        var kind = isCombo ? 'combo' : lower(String(type) === 'CUSTOM' ? (opts.multiline ? 'text' : 'string') : String(type));

        if (kind === 'string') kind = opts.multiline ? 'text' : 'string';

        var dynamic = dynamicComboOptions(type, opts);
        if (dynamic) {
          specs.push({
            name: name,
            kind: 'combo',
            type: 'COMBO',
            values: dynamic.map(function (option) { return option.key; }),
            options: opts,
            required: s === 0,
            'default': opts['default'],
            dynamic: dynamic
          });
          continue;
        }

        specs.push({
          name: name,
          kind: kind,
          type: isCombo ? 'COMBO' : String(type),
          values: values,
          options: opts,
          required: s === 0,
          'default': opts['default']
        });

        if (false && opts.control_after_generate && (kind === 'int' || kind === 'float')) {
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
        if (false && opts.image_upload) {
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

  var SEED_NAMES = { seed: 1, noise_seed: 1, rand_seed: 1, random_seed: 1, global_seed: 1, 'value': 0 };

  /* API-prompt inputs that hold a seed, including DynamicCombo sub-inputs
   * such as "sampling_mode.seed". */
  var SEED_INPUT = /(^|\.)(seed|noise_seed|rand_seed|random_seed|global_seed)$/i;

  var CONTROL_VALUES = { fixed: 1, increment: 1, decrement: 1, randomize: 1 };

  function isSeedWidget(spec) {
    if (!spec) return false;
    if (spec.options && spec.options.control_after_generate) return true;
    if (spec.kind !== 'int') return false;
    return !!SEED_NAMES[spec.name];
  }

  /* Nested widget specs of the selected DynamicCombo option. ComfyUI sends
   * those as flat "parent.child" inputs next to the selected key. */
  function dynamicNestedSpecs(spec, selected) {
    var out = [];
    if (!spec || !spec.dynamic) return out;
    var chosen = null;
    for (var i = 0; i < spec.dynamic.length; i++) {
      if (String(spec.dynamic[i].key) === String(selected)) { chosen = spec.dynamic[i]; break; }
    }
    if (!chosen || !isPlainObject(chosen.inputs)) return out;
    var sections = [chosen.inputs.required, chosen.inputs.optional];
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      if (!section || !isPlainObject(section)) continue;
      var names = Object.keys(section);
      for (var n = 0; n < names.length; n++) {
        var name = names[n];
        var raw = section[name];
        if (!isWidgetInput(name, raw)) continue;
        var opts = inputOptions(raw);
        var type = Array.isArray(raw) ? raw[0] : raw;
        var values = comboValues(type, opts);
        var isCombo = !!values || upper(type) === 'COMBO';
        var kind = isCombo ? 'combo' : lower(String(type) === 'CUSTOM' ? (opts.multiline ? 'text' : 'string') : String(type));
        if (kind === 'string') kind = opts.multiline ? 'text' : 'string';
        out.push({
          name: spec.name + '.' + name,
          kind: kind,
          type: isCombo ? 'COMBO' : String(type),
          values: values,
          options: opts,
          required: s === 0,
          'default': opts['default']
        });
      }
    }
    return out;
  }

  /* name -> raw value map of a workflow node's widgets. The frontend writes
   * widgets_values_named (including dotted DynamicCombo names); older saves
   * only carry an array of widget objects. */
  function widgetValueMap(node) {
    var map = {};
    var named = node && node.widgets_values_named;
    if (isPlainObject(named)) {
      for (var key in named) {
        if (Object.prototype.hasOwnProperty.call(named, key)) map[key] = named[key];
      }
      return map;
    }
    var widgets = node && node.widgets;
    if (Array.isArray(widgets)) {
      for (var i = 0; i < widgets.length; i++) {
        var widget = widgets[i];
        if (widget && typeof widget.name === 'string') map[widget.name] = widget.value;
      }
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* widget value alignment                                              */
  /* ------------------------------------------------------------------ */

  function typeScore(spec, value) {
    if (value === undefined || value === null) return 0;
    switch (spec.kind) {
      case 'int': return typeof value === 'number' ? 3 : (value !== '' && !isNaN(Number(value)) ? 1 : -2);
      case 'float': return typeof value === 'number' ? 3 : (value !== '' && !isNaN(Number(value)) ? 1 : -2);
      case 'boolean': return typeof value === 'boolean' ? 3 : -1;
      case 'combo':
        if (typeof value !== 'string') return -1;
        if (!spec.values || !spec.values.length) return 2;
        return spec.values.some(function (v) { return String(v) === value; }) ? 3 : 0;
      case 'text': return typeof value === 'string' ? 3 : -1;
      case 'string': return typeof value === 'string' ? 3 : (typeof value === 'number' ? 0 : -1);
      default: return 1;
    }
  }

  function rawWidgetList(node) {
    if (Array.isArray(node.widgets_values)) return node.widgets_values;
    if (isPlainObject(node.widgets_values)) return node.widgets_values;
    return null;
  }

  /* Assign widget values to the ordered widget specs.
   *
   * Preference order:
   *   1. node.widgets_values_named  (name -> value map, new frontend)
   *   2. node.widgets[]             (per-widget objects, some exports)
   *   3. positional, with an offset search when the counts disagree
   */
  function alignWidgets(node, specs) {
    var out = new Array(specs.length);
    for (var i = 0; i < specs.length; i++) out[i] = undefined;
    var note = null;

    var named = node.widgets_values_named;
    if (isPlainObject(named)) {
      var namedControls = {};
      for (var n = 0; n < specs.length; n++) {
        var key = specs[n].namedKey || specs[n].name;
        if (Object.prototype.hasOwnProperty.call(named, key)) out[n] = named[key];
        if (typeof named.control_after_generate === 'string' && isSeedWidget(specs[n])) {
          namedControls[n] = named.control_after_generate;
        }
      }
      return { values: out, controls: namedControls, note: null, source: 'named' };
    }

    if (Array.isArray(node.widgets) && node.widgets.length) {
      var byName = {};
      var any = false;
      for (var wI = 0; wI < node.widgets.length; wI++) {
        var w = node.widgets[wI];
        if (w && typeof w.name === 'string') { byName[w.name] = w.value; any = true; }
      }
      if (any) {
        for (var m = 0; m < specs.length; m++) {
          var k2 = specs[m].namedKey || specs[m].name;
          if (Object.prototype.hasOwnProperty.call(byName, k2)) out[m] = byName[k2];
        }
        return { values: out, controls: {}, note: null, source: 'widgets' };
      }
    }

    var raw = rawWidgetList(node);
    if (raw === null) return { values: out, controls: {}, note: null, source: 'none' };

    if (isPlainObject(raw)) {
      for (var j = 0; j < specs.length; j++) {
        var k3 = specs[j].namedKey || specs[j].name;
        if (Object.prototype.hasOwnProperty.call(raw, k3)) out[j] = raw[k3];
      }
      return { values: out, controls: {}, note: null, source: 'map' };
    }

    /* The frontend stores an extra "control_after_generate" string after some
     * numeric widgets. Consume those while walking so nothing shifts by one -
     * this is the classic "my sampler settings are wrong" symptom. */
    function walk(list) {
      var values = new Array(list.length);
      var controls = {};
      var p = 0;
      for (var x = 0; x < list.length; x++) {
        values[x] = p < raw.length ? raw[p] : undefined;
        p++;
        var kind = list[x].kind;
        if ((kind === 'int' || kind === 'float') && p < raw.length &&
            typeof raw[p] === 'string' && CONTROL_VALUES[raw[p]]) {
          controls[x] = raw[p];
          p++;
        }
      }
      return { values: values, controls: controls, consumed: p };
    }

    if (raw.length >= specs.length) {
      var walked = walk(specs);
      if (walked.consumed === raw.length || raw.length === specs.length) {
        return { values: walked.values, controls: walked.controls, note: null, source: 'positional' };
      }
    }

    if (!raw.length) return { values: out, controls: {}, note: null, source: 'empty' };

    /* Counts disagree - try every sane offset and keep the best typed fit. */
    var best = { score: -Infinity, offset: 0, shifted: false };
    var maxOffset = Math.max(0, Math.min(raw.length, specs.length));
    for (var off = 0; off <= maxOffset; off++) {
      var score = 0;
      for (var sI = 0; sI < specs.length; sI++) {
        var v = raw[sI + off];
        score += typeScore(specs[sI], v);
      }
      /* a trailing-prefix alignment (offset 0) is preferred when tied */
      if (score > best.score + 0.5) best = { score: score, offset: off, shifted: off !== 0 };
    }

    for (var q = 0; q < specs.length; q++) {
      var idx = q + best.offset;
      out[q] = idx < raw.length ? raw[idx] : undefined;
    }
    var tried = walk(specs);
    note = 'widgets_values length ' + raw.length + ' != expected ' + specs.length +
      (best.offset ? ', aligned with offset ' + best.offset : '') +
      ' - check the values before generating';
    return { values: out, controls: tried.controls, note: note, source: 'fuzzy' };
  }

  /* ------------------------------------------------------------------ */
  /* value coercion                                                      */
  /* ------------------------------------------------------------------ */

  function coerce(spec, value) {
    var opts = (spec && spec.options) || {};
    if (value === undefined || value === null || value === '') {
      if (spec && spec.kind !== 'combo' && opts['default'] !== undefined) return opts['default'];
      if (spec && spec.kind === 'combo' && spec.values && spec.values.length) {
        return opts['default'] !== undefined && spec.values.indexOf(opts['default']) >= 0 ? opts['default'] : spec.values[0];
      }
      return value === '' && (spec.kind === 'string' || spec.kind === 'text') ? '' : undefined;
    }

    switch (spec.kind) {
      case 'int': {
        var n = Math.round(Number(value));
        if (isNaN(n)) n = Number(opts['default']);
        if (isNaN(n)) return undefined;
        if (opts.min !== undefined && n < Number(opts.min)) n = Number(opts.min);
        if (opts.max !== undefined && n > Number(opts.max)) n = Number(opts.max);
        return n;
      }
      case 'float': {
        var f = Number(value);
        if (isNaN(f)) f = Number(opts['default']);
        if (isNaN(f)) return undefined;
        if (opts.min !== undefined && f < Number(opts.min)) f = Number(opts.min);
        if (opts.max !== undefined && f > Number(opts.max)) f = Number(opts.max);
        return round(f, 6);
      }
      case 'boolean':
        return value === true || value === 'true' || value === 1 || value === '1';
      case 'combo': {
        var str = String(value);
        if (!spec.values || !spec.values.length) return str;
        for (var i = 0; i < spec.values.length; i++) {
          if (String(spec.values[i]) === str) return spec.values[i];
        }
        /* keep raw reference for file inputs (subfolder/name style) */
        if (/[\w\-]+\.(png|jpg|jpeg|webp|gif|mp4|json)$/i.test(str)) return str;
        var fallback = opts['default'] !== undefined && spec.values.map(String).indexOf(String(opts['default'])) >= 0
          ? opts['default'] : spec.values[0];
        return fallback;
      }
      case 'text':
      case 'string':
        return typeof value === 'string' ? value : String(value);
      default:
        return value;
    }
  }

  /* ------------------------------------------------------------------ */
  /* indexes and link resolution                                         */
  /* ------------------------------------------------------------------ */

  function makeNodesIndex(workflow) {
    var index = {};
    var nodes = workflow.nodes || [];
    for (var i = 0; i < nodes.length; i++) index[String(nodes[i].id)] = nodes[i];
    return index;
  }

  function makeLinksIndex(workflow) {
    var index = {};
    var links = workflow.links || [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (!Array.isArray(link) || link.length < 6) continue;
      index[String(link[0])] = link;
    }
    return index;
  }

  /* 0 normal, 2 muted, 3 muted (older), 4 bypass/never */
  function isActive(node) {
    var m = node.mode === undefined ? 0 : node.mode;
    return m === 0 || m === 1;
  }

  function isBypassed(node) {
    var m = node.mode === undefined ? 0 : node.mode;
    return m === 4 || m === 3;
  }

  function passthroughType(type) {
    if (!type) return false;
    if (PASSTHROUGH_TYPES[type]) return true;
    if (/reroute/i.test(type)) return true;              /* Reroute, dev.reroute, rgthree ... */
    if (/^(Primitive|AnyInput|InputSwitch|Cache|CheckpointLoaderSimpleX)/i.test(type)) return false;
    if (/^(Note|MarkdownNote|Comment|Sticky Note|CreateNote)/i.test(type)) return true;
    return false;
  }

  function isPrimitiveLike(type) {
    return /primitive/i.test(String(type)) || String(type) === 'Constant' || /constant.*node/i.test(String(type));
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
      if (String(inputs[i].type) === String(type)) return inputs[i];
      if (!fallback) fallback = inputs[i];
    }
    return fallback;
  }

  function primitiveValueOf(node) {
    var named = node.widgets_values_named;
    if (isPlainObject(named)) {
      if (named.value !== undefined) return { literal: named.value };
    }
    var raw = rawWidgetList(node);
    if (Array.isArray(raw) && raw.length) return { literal: raw[0] };
    if (isPlainObject(raw) && raw.value !== undefined) return { literal: raw.value };
    return { literal: undefined };
  }

  function resolveOrigin(nodeId, slot, ctx, depth) {
    if (depth > 128) return null;
    var node = ctx.nodesById[String(nodeId)];
    if (!node) return null;

    if (isPrimitiveLike(node.type)) return primitiveValueOf(node);

    if (/reroute/i.test(String(node.type)) || passthroughType(node.type)) {
      var rin = node.inputs && node.inputs[0];
      if (!rin || rin.link === null || rin.link === undefined) return null;
      return resolveLink(rin.link, ctx, depth + 1);
    }

    if (isBypassed(node)) {
      var t = outputTypeOf(node, slot);
      var src = findInputByType(node, t);
      if (!src) return null;
      return resolveLink(src.link, ctx, depth + 1);
    }

    if (!isActive(node)) return null;

    return { nodeId: node.id, slot: slot };
  }

  function resolveLink(linkId, ctx, depth) {
    if (depth === undefined) depth = 0;
    var link = ctx.linksById[String(linkId)];
    if (!link) return null;
    return resolveOrigin(link[1], link[2], ctx, depth + 1);
  }

  /* ------------------------------------------------------------------ */
  /* output node detection                                               */
  /* ------------------------------------------------------------------ */

  function isImageOutput(definition, node) {
    var type = node && node.type;
    if (definition) {
      if (definition.output_node === false) return false;
      var out = definition.output;
      var hasImage = false;
      if (typeof out === 'string') hasImage = out.indexOf('IMAGE') >= 0 || out.indexOf('MASK') >= 0 || out.indexOf('VIDEO') >= 0;
      else if (Array.isArray(out)) hasImage = out.some(function (o) { return /IMAGE|VIDEO/.test(String(o)); });
      else if (definition.output_is_list !== undefined && out === undefined) hasImage = !!definition.output_node;
      if (definition.output_node && hasImage) return true;
      if (KNOWN_IMAGE_OUTPUTS[type]) return true;
      return false;
    }
    return !!KNOWN_IMAGE_OUTPUTS[type];
  }

  function isSamplerType(type) {
    if (!type) return false;
    return /KSampler|SamplerCustom|SamplerExponential|Sampler|ModelSampling/i.test(String(type));
  }

  function upstreamHas(workflow, fromId, predicate, nodesById, linksById) {
    var seen = {};
    var stack = [fromId];
    while (stack.length) {
      var id = stack.pop();
      var key = String(id);
      if (seen[key]) continue;
      seen[key] = true;
      var node = nodesById[key];
      if (!node) continue;
      if (predicate(node)) return true;
      var inputs = node.inputs || [];
      for (var i = 0; i < inputs.length; i++) {
        var linkId = inputs[i].link;
        if (linkId === null || linkId === undefined) continue;
        var link = linksById[String(linkId)];
        if (link) stack.push(link[1]);
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* UI model                                                            */
  /* ------------------------------------------------------------------ */

  function nodeWidgets(node, definition) {
    var specs = widgetSpecs(definition);
    var aligned = alignWidgets(node, specs);
    var widgets = [];
    for (var w = 0; w < specs.length; w++) {
      var spec = specs[w];
      var widget = {
        nodeId: node.id,
        name: spec.name,
        kind: spec.kind,
        values: spec.values,
        options: spec.options || {},
        required: !!spec.required,
        index: w,
        value: coerce(spec, aligned.values[w]),
        rawValue: aligned.values[w],
        isSeed: isSeedWidget(spec)
      };
      if (widget.isSeed) {
        widget.seedControl = (aligned.controls && aligned.controls[w]) ||
          (spec.options && spec.options.control_after_generate ? 'randomize' : undefined);
      }
      widgets.push(widget);
    }
    return {
      widgets: widgets,
      note: aligned.note,
      specs: specs,
      aligned: aligned.values,
      controls: aligned.controls,
      source: aligned.source
    };
  }

  function hasImageUploadInput(definition, name) {
    if (!definition || !definition.input) return false;
    var sections = [definition.input.required, definition.input.optional];
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (!sec || !isPlainObject(sec[name])) continue;
      var spec = sec[name];
      var opts = inputOptions(spec);
      if (opts.image_upload) return true;
      if (upper(Array.isArray(spec) ? spec[0] : spec) === 'COMBO' && opts.forceInput !== true) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* API format                                                          */
  /* ------------------------------------------------------------------ */

  function apiIds(prompt) {
    return Object.keys(prompt || {}).filter(function (key) {
      return isPlainObject(prompt[key]) && typeof prompt[key].class_type === 'string';
    });
  }

  function apiUpstreamHas(prompt, fromId, predicate) {
    var seen = {};
    var stack = [String(fromId)];
    var guard = 0;
    while (stack.length && guard++ < 100000) {
      var id = stack.pop();
      if (seen[id]) continue;
      seen[id] = true;
      var entry = prompt[id];
      if (!entry) continue;
      if (predicate(entry)) return true;
      var inputs = entry.inputs || {};
      Object.keys(inputs).forEach(function (key) {
        var value = inputs[key];
        if (isLinkRef(value) && !seen[String(value[0])]) stack.push(String(value[0]));
      });
    }
    return false;
  }

  function apiWidgetsOf(promptEntry, definition) {
    var specs = widgetSpecs(definition);
    var inputs = isPlainObject(promptEntry.inputs) ? promptEntry.inputs : {};
    var widgets = [];
    for (var w = 0; w < specs.length; w++) {
      var spec = specs[w];
      if (spec.kind === 'control' || spec.kind === 'upload') continue;
      if (!Object.prototype.hasOwnProperty.call(inputs, spec.name)) continue;
      var raw = inputs[spec.name];
      if (isLinkRef(raw)) continue;
      var widget = {
        nodeId: definition && promptEntry._apiId,
        name: spec.name,
        kind: spec.kind,
        values: spec.values,
        options: spec.options || {},
        required: !!spec.required,
        index: w,
        value: coerce(spec, raw),
        rawValue: raw,
        isSeed: isSeedWidget(spec)
      };
      if (widget.isSeed && spec.options && spec.options.control_after_generate) widget.seedControl = 'randomize';
      widgets.push(widget);
    }
    return widgets;
  }

  /* API-format prompts are already complete: no object_info lookup is needed
   * to run them. Node titles from "_meta" are still exposed for editing. */
  function buildApiModel(prompt, objectInfo) {
    objectInfo = objectInfo || {};
    var result = {
      ok: true,
      exposed: [],
      loadImages: [],
      loadMasks: [],
      outputs: [],
      defaultOutputId: null,
      warnings: ['API-format workflow detected - it is sent to ComfyUI as-is.'],
      errors: [],
      nodeCount: 0,
      activeNodeCount: 0,
      hasSubgraphs: false,
      fromApi: true,
      format: 'api'
    };

    var ids = apiIds(prompt);
    result.nodeCount = ids.length;
    result.activeNodeCount = ids.length;
    if (!ids.length) {
      result.ok = false;
      result.errors.push('This JSON is not a ComfyUI workflow or API prompt (no class_type entries).');
      return result;
    }

    var activeNodeIds = {};
    ids.forEach(function (id) {
      var entry = prompt[id];
      var definition = objectInfo[entry.class_type];
      var meta = isPlainObject(entry._meta) ? entry._meta : {};
      var rawTitle = meta.title || meta.name || entry.class_type;
      var fakeNode = { id: id, type: entry.class_type, title: rawTitle, mode: 0 };
      var title = parseTitle(fakeNode, entry.class_type);
      var widgets = apiWidgetsOf({ inputs: entry.inputs, _apiId: id }, definition);
      widgets.forEach(function (w) { w.nodeId = id; });

      var isLoadImage = entry.class_type === 'LoadImage' || /LoadImage(FromPath)?$/.test(String(entry.class_type));
      var isLoadMask = /LoadImageMask|LoadMask/i.test(String(entry.class_type));
      if (!isLoadImage && !isLoadMask && definition) {
        isLoadImage = hasImageUploadInput(definition, 'image');
        isLoadMask = hasImageUploadInput(definition, 'mask');
      }
      if (isLoadImage || isLoadMask) {
        var loadEntry = {
          id: id,
          title: title.exposed ? title.label : rawTitle,
          kind: isLoadMask ? 'mask' : 'image',
          type: entry.class_type,
          widgets: widgets,
          exposed: title.exposed,
          needed: true,
          imageValue: pickValue(widgets, 'image') !== undefined ? pickValue(widgets, 'image') : pickValue(widgets, 'mask')
        };
        if (isLoadMask) result.loadMasks.push(loadEntry); else result.loadImages.push(loadEntry);
      }

      if (isImageOutput(definition, fakeNode)) {
        result.outputs.push({
          id: id,
          type: entry.class_type,
          title: rawTitle,
          afterSampler: apiUpstreamHas(prompt, id, function (e) { return isSamplerType(e.class_type); })
        });
      }

      if (title.exposed) {
        var filtered = widgets;
        if (title.only) filtered = widgets.filter(function (x) { return title.only.indexOf(x.name) >= 0; });
        else if (title.except) filtered = widgets.filter(function (x) { return title.except.indexOf(x.name) < 0; });
        result.exposed.push({
          id: id,
          type: entry.class_type,
          title: title.label,
          rawTitle: rawTitle,
          group: title.group === 'default' ? '' : title.group,
          order: title.explicitOrder ? title.order : 1000,
          collapsed: title.collapsed,
          only: title.only,
          except: title.except,
          widgets: filtered,
          allWidgets: widgets,
          isLoadImage: isLoadImage,
          needed: true
        });
      }
      if (title.exposed || isLoadImage || isLoadMask) activeNodeIds[id] = true;
    });

    result.exposed.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
    });

    for (var oi = 0; oi < result.outputs.length; oi++) {
      if (result.outputs[oi].afterSampler) { result.defaultOutputId = result.outputs[oi].id; break; }
    }
    if (result.defaultOutputId === null && result.outputs.length) result.defaultOutputId = result.outputs[0].id;
    if (!result.outputs.length) {
      result.warnings.push('No image output node found. ComfyShop will insert whatever image ComfyUI reports.');
    }
    if (!result.exposed.length) {
      result.warnings.push('No "#" titles in this API prompt - nothing is editable from Photoshop.');
    }
    return result;
  }

  /* Copy an API prompt, apply overrides and drop branches the chosen output
   * does not use. The original workflow object is never mutated. */
  /* Batch runs (x2 / x5) need a fresh seed per run: with an unchanged prompt
   * ComfyUI serves the cached result and every layer looks the same.
   * fixedSeeds holds "<nodeId>::<input>" keys the workflow pins ("fixed"
   * control); pinnedSeedNodes holds node ids the user locked in the panel. */
  function varyPromptSeeds(prompt, options, fixedSeeds) {
    var pinnedNodes = {};
    (options.pinnedSeedNodes || []).forEach(function (id) { pinnedNodes[String(id)] = true; });
    Object.keys(prompt).forEach(function (id) {
      if (pinnedNodes[id]) return;
      var inputs = prompt[id].inputs || {};
      Object.keys(inputs).forEach(function (key) {
        if (!SEED_INPUT.test(key)) return;
        if (fixedSeeds && fixedSeeds[id + '::' + key]) return;
        if (typeof inputs[key] !== 'number') return;
        inputs[key] = options.varySeeds();
      });
    });
    return prompt;
  }

  function buildApiPrompt(prompt, objectInfo, overrides, options) {
    objectInfo = objectInfo || {};
    options = options || {};
    overrides = overrides || {};
    var result = { prompt: {}, errors: [], warnings: [] };
    var ids = apiIds(prompt);
    if (!ids.length) {
      result.errors.push('This JSON is not a ComfyUI API prompt (no class_type entries).');
      return result;
    }

    ids.forEach(function (id) {
      var node = prompt[id];
      var inputs = {};
      if (isPlainObject(node.inputs)) {
        Object.keys(node.inputs).forEach(function (key) { inputs[key] = node.inputs[key]; });
      }
      var nodeOverrides = overrides[String(id)] || {};
      Object.keys(nodeOverrides).forEach(function (key) {
        if (nodeOverrides[key] !== undefined) inputs[key] = nodeOverrides[key];
      });
      var entry = { class_type: node.class_type, inputs: inputs };
      if (isPlainObject(node._meta)) entry._meta = node._meta;
      result.prompt[String(id)] = entry;
    });

    var roots = options.outputIds && options.outputIds.length ? options.outputIds.slice() : null;
    if (roots) {
      roots = roots.filter(function (id) {
        return Object.prototype.hasOwnProperty.call(result.prompt, String(id));
      });
      if (!roots.length) roots = null;
    }
    if (!roots) {
      roots = [];
      ids.forEach(function (id) {
        var node = prompt[id];
        if (isImageOutput(objectInfo[node.class_type], { type: node.class_type })) roots.push(id);
      });
    }
    if (options.prune !== false) result.prompt = pruneGraph(result.prompt, roots, result);

    if (typeof options.varySeeds === 'function') {
      result.prompt = varyPromptSeeds(result.prompt, options, null);
    }

    var kept = Object.keys(result.prompt);
    kept.forEach(function (id) {
      var inputs = result.prompt[id].inputs || {};
      Object.keys(inputs).forEach(function (name) {
        var value = inputs[name];
        if (isLinkRef(value) && !Object.prototype.hasOwnProperty.call(result.prompt, String(value[0]))) {
          result.errors.push('Node #' + id + ' input "' + name + '" points at missing node #' + value[0] + '.');
        }
      });
    });

    return result;
  }

  function collectNeeded(rootIds, nodesById, linksById) {
    var needed = {};
    var stack = (rootIds || []).map(function (id) { return String(id); });
    var guard = 0;
    while (stack.length && guard++ < 100000) {
      var id = stack.pop();
      if (needed[id]) continue;
      needed[id] = true;
      var node = nodesById[id];
      if (!node) continue;
      var inputs = node.inputs || [];
      for (var i = 0; i < inputs.length; i++) {
        var linkId = inputs[i].link;
        if (linkId === null || linkId === undefined) continue;
        var link = linksById[String(linkId)];
        if (link) stack.push(String(link[1]));
      }
    }
    return needed;
  }

  function detectOutputs(wf, objectInfo, nodesById, linksById) {
    var outputs = [];
    var nodes = wf.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.type) continue;
      if (passthroughType(node.type) || !isActive(node)) continue;
      var definition = objectInfo[node.type];
      if (!isImageOutput(definition, node)) continue;
      outputs.push({
        id: node.id,
        type: node.type,
        title: node.title || node.type,
        afterSampler: upstreamHas(wf, node.id, function (n) { return isSamplerType(n.type); }, nodesById, linksById)
      });
    }
    return outputs;
  }

  function buildModel(rawWorkflow, objectInfo) {
    objectInfo = objectInfo || {};
    if (looksLikeApiFormat(rawWorkflow)) return buildApiModel(rawWorkflow, objectInfo);

    var errors = [];
    var warnings = [];
    var wf = rawWorkflow;

    if (!wf || !Array.isArray(wf.nodes)) {
      return { ok: false, errors: ['Workflow JSON has no "nodes" array (is this a ComfyUI workflow file?).'], warnings: warnings };
    }

    var flat = flattenSubgraphs(wf);
    if (flat.expanded) {
      wf = flat.workflow;
      warnings.push('Flattened ' + flat.expanded + ' subgraph node(s) - inner nodes were inlined.');
      (flat.warnings || []).forEach(function (x) { warnings.push(x); });
    } else if (wf.definitions && Array.isArray(wf.definitions.subgraphs) && wf.definitions.subgraphs.length) {
      (flat.errors || []).forEach(function (x) { errors.push(x); });
      if (!errors.length) errors.push('This workflow uses ComfyUI subgraphs that could not be inlined. Re-save it with "Export (API)" or update ComfyUI.');
    }

    var nodesById = makeNodesIndex(wf);
    var linksById = makeLinksIndex(wf);

    var exposed = [];
    var loadImages = [];
    var loadMasks = [];
    var unknownNeeded = {};
    var unknownIgnored = 0;
    var nodes = wf.nodes;

    var outputs = detectOutputs(wf, objectInfo, nodesById, linksById);
    var needed = outputs.length ? collectNeeded(outputs.map(function (o) { return o.id; }), nodesById, linksById) : null;

    /* If any "#" node uses "#widget" input labels, the workflow opts into
     * strict mode: every "#" node then shows only its marked widgets. Old
     * workflows without widget marks keep showing all widgets. */
    var strictWidgetMarks = false;
    for (var sm = 0; sm < nodes.length; sm++) {
      var sn = nodes[sm];
      if (!sn || !sn.type || passthroughType(sn.type) || !isActive(sn)) continue;
      if (needed && !needed[String(sn.id)]) continue;
      if (!parseTitle(sn, sn.type).exposed) continue;
      var snMarks = widgetMarks(sn);
      if (!Object.keys(snMarks).length) continue;
      var snWidgets = nodeWidgets(sn, objectInfo[sn.type]).widgets;
      var hasMark = snWidgets.some(function (w) { return snMarks[String(w.name)] !== undefined; });
      if (hasMark) { strictWidgetMarks = true; break; }
    }

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.type) continue;
      if (passthroughType(node.type)) continue;
      if (!isActive(node)) continue;

      var isNeeded = !needed || !!needed[String(node.id)];
      var definition = objectInfo[node.type];
      if (!definition) {
        if (isNeeded) {
          if (!unknownNeeded[node.type]) unknownNeeded[node.type] = [];
          unknownNeeded[node.type].push(node.id);
        } else {
          unknownIgnored++;
        }
      }
      if (!isNeeded) continue;

      var title = parseTitle(node, node.type);
      var built = nodeWidgets(node, definition);
      if (built.note) warnings.push('Node #' + node.id + ' (' + node.type + '): ' + built.note);

      var widgets = built.widgets;
      var filtered = widgets;
      if (title.only) {
        filtered = widgets.filter(function (x) { return title.only.indexOf(x.name) >= 0; });
      } else if (title.except) {
        filtered = widgets.filter(function (x) { return title.except.indexOf(x.name) < 0; });
      }

      /* "#widget" labels inside a "#node": show only the marked widgets. */
      var marks = title.exposed ? widgetMarks(node) : {};
      var widgetNames = {};
      widgets.forEach(function (x) { widgetNames[String(x.name)] = true; });
      var markedNames = Object.keys(marks).filter(function (key) { return !!widgetNames[key]; });
      if (strictWidgetMarks && title.exposed) {
        filtered = filtered.filter(function (x) {
          return marks[String(x.name)] !== undefined;
        });
      }
      filtered.forEach(function (x) {
        var marked = marks[String(x.name)];
        if (marked !== undefined) {
          x.label = marked;
          x.displayName = marked;
          x.marked = true;
        }
      });

      /* image / mask upload nodes */
      var isLoadImage = node.type === 'LoadImage' || /LoadImage(FromPath)?$/.test(String(node.type));
      var isLoadMask = /LoadImageMask|LoadMask/i.test(String(node.type));
      if (!isLoadImage && !isLoadMask && definition) {
        isLoadImage = hasImageUploadInput(definition, 'image');
        isLoadMask = hasImageUploadInput(definition, 'mask');
      }
      if (isLoadImage || isLoadMask) {
        var entry = {
          id: node.id,
          title: title.exposed ? title.label : (node.title || node.type),
          kind: isLoadMask ? 'mask' : 'image',
          type: node.type,
          widgets: widgets,
          exposed: title.exposed,
          needed: isNeeded,
          markedNames: markedNames,
          strictMarks: strictWidgetMarks,
          imageLabel: marks['image'] || marks['mask'] || null,
          imageValue: pickValue(widgets, 'image') !== undefined ? pickValue(widgets, 'image') : pickValue(widgets, 'mask')
        };
        if (isLoadMask) loadMasks.push(entry); else loadImages.push(entry);
      }

      if (title.exposed) {
        exposed.push({
          id: node.id,
          type: node.type,
          title: title.label,
          rawTitle: title.raw,
          group: title.group === 'default' ? '' : title.group,
          order: title.explicitOrder ? title.order : 1000 + i,
          collapsed: title.collapsed,
          only: title.only,
          markedNames: markedNames,
          strictMarks: strictWidgetMarks,
          widgets: filtered,
          allWidgets: widgets,
          isLoadImage: isLoadImage,
          needed: isNeeded
        });
      }
    }

    var unknownList = Object.keys(unknownNeeded);
    if (unknownList.length) {
      errors.push('Missing custom nodes on the ComfyUI server: ' + unknownList.map(function (type) {
        return type + ' (node #' + unknownNeeded[type].join(', #') + ')';
      }).join('; ') + '. Install them with ComfyUI Manager, then Reload.');
    }
    if (unknownIgnored) {
      warnings.push(unknownIgnored + ' unknown node(s) are not connected to an output and were skipped.');
    }

    exposed.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
    });

    var defaultOutputId = null;
    for (var oi = 0; oi < outputs.length; oi++) {
      if (outputs[oi].afterSampler) { defaultOutputId = outputs[oi].id; break; }
    }
    if (defaultOutputId === null && outputs.length) defaultOutputId = outputs[0].id;
    if (!outputs.length) {
      errors.push('No image output node found (SaveImage / PreviewImage). Add one in ComfyUI, otherwise ComfyShop cannot know which result to insert.');
    }

    if (!exposed.length) {
      warnings.push('No "#" nodes: nothing is editable from Photoshop. Rename a node title in ComfyUI, e.g. "#Prompt", "#02 Denoise?".');
    }

    return {
      ok: !errors.length,
      workflow: wf,
      exposed: exposed,
      loadImages: loadImages,
      loadMasks: loadMasks,
      outputs: outputs,
      defaultOutputId: defaultOutputId,
      warnings: warnings,
      errors: errors,
      nodeCount: nodes.length,
      activeNodeCount: nodes.filter(isActive).length,
      neededCount: needed ? Object.keys(needed).length : nodes.length,
      hasSubgraphs: !!(rawWorkflow && rawWorkflow.definitions && rawWorkflow.definitions.subgraphs && rawWorkflow.definitions.subgraphs.length),
      fromApi: false,
      format: 'ui'
    };
  }

  function pickValue(widgets, name) {
    for (var i = 0; i < (widgets || []).length; i++) if (widgets[i].name === name) return widgets[i].value;
    return undefined;
  }

  /* ------------------------------------------------------------------ */
  /* prompt building                                                     */
  /* ------------------------------------------------------------------ */

  /*
   * overrides: { "<nodeId>": { "<widgetName>": value } }
   * options:   { outputIds: [id, ...], prune: true }
   */
  function buildPrompt(rawWorkflow, objectInfo, overrides, options) {
    objectInfo = objectInfo || {};
    options = options || {};
    var result = { prompt: {}, errors: [], warnings: [], missing: [] };
    overrides = overrides || {};

    if (looksLikeApiFormat(rawWorkflow)) return buildApiPrompt(rawWorkflow, objectInfo, overrides, options);

    var wf = rawWorkflow;
    if (!wf || !Array.isArray(wf.nodes)) {
      result.errors.push('Workflow JSON has no "nodes" array.');
      return result;
    }
    if (wf.definitions && Array.isArray(wf.definitions.subgraphs) && wf.definitions.subgraphs.length) {
      var flat = flattenSubgraphs(wf);
      if (flat.expanded) {
        wf = flat.workflow;
        result.warnings.push('Flattened ' + flat.expanded + ' subgraph node(s).');
        (flat.warnings || []).forEach(function (x) { result.warnings.push(x); });
      } else {
        (flat.errors || []).forEach(function (x) { result.errors.push(x); });
        if (!result.errors.length) result.errors.push('This workflow uses ComfyUI subgraphs that could not be inlined.');
        return result;
      }
    }

    var ctx = { nodesById: makeNodesIndex(wf), linksById: makeLinksIndex(wf) };
    var nodes = wf.nodes;

    var roots = options.outputIds && options.outputIds.length ? options.outputIds.slice() : null;
    if (roots) {
      var existingRoots = roots.filter(function (id) {
        return Object.prototype.hasOwnProperty.call(ctx.nodesById, String(id));
      });
      roots = existingRoots.length ? existingRoots : null;
    }
    if (!roots) {
      var detected = detectOutputs(wf, objectInfo, ctx.nodesById, ctx.linksById);
      if (detected.length) roots = detected.map(function (o) { return o.id; });
    }
    var needed = roots && roots.length ? collectNeeded(roots, ctx.nodesById, ctx.linksById) : null;

    var unknownIds = {};
    var unknownById = {};
    var unknownWarned = {};
    var fixedSeeds = {};

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.type) continue;
      if (passthroughType(node.type)) continue;
      if (!isActive(node)) continue;
      if (needed && !needed[String(node.id)]) continue;

      var definition = objectInfo[node.type];
      if (!definition) {
        unknownIds[String(node.id)] = node.type;
        if (!unknownWarned[node.type]) {
          unknownWarned[node.type] = true;
          if (!unknownById[node.type]) unknownById[node.type] = [];
          unknownById[node.type].push(node.id);
        } else {
          unknownById[node.type].push(node.id);
        }
        continue;
      }

      var specs = widgetSpecs(definition);
      var aligned = alignWidgets(node, specs);
      var values = aligned.values;
      var nodeOverrides = overrides[String(node.id)] || {};
      var inputs = {};

      /* 1. links (literals from primitives included) */
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

      /* 2. widgets */
      for (var w = 0; w < specs.length; w++) {
        var spec = specs[w];
        var value;
        if (Object.prototype.hasOwnProperty.call(nodeOverrides, spec.name)) {
          value = coerce(spec, nodeOverrides[spec.name]);
          if (value === undefined) value = coerce(spec, values[w]);
        } else {
          value = coerce(spec, values[w]);
        }
        if (value === undefined) {
          if (spec.required && inputs[spec.name] === undefined) {
            result.missing.push({ nodeId: node.id, nodeType: node.type, input: spec.name });
          }
          continue;
        }
        if (inputs[spec.name] === undefined) inputs[spec.name] = value;

        /* Remember seeds the workflow itself pins ("fixed" control), so batch
         * runs do not override a deliberate choice. */
        if (SEED_INPUT.test(spec.name) && aligned.controls && aligned.controls[w] === 'fixed') {
          fixedSeeds[String(node.id) + '::' + spec.name] = true;
        }
      }

      /* 2b. DynamicCombo sub-inputs. ComfyUI expects the selected option and
       * its parameters as flat "parent.child" keys; without them the backend
       * drops the whole combo and fails inside execute(). */
      if (specs.some(function (item) { return !!item.dynamic; })) {
        var rawByName = widgetValueMap(node);
        for (var d = 0; d < specs.length; d++) {
          var dynamicSpec = specs[d];
          if (!dynamicSpec.dynamic) continue;
          var selected = inputs[dynamicSpec.name];
          if (selected === undefined || isLinkRef(selected)) continue;
          var nested = dynamicNestedSpecs(dynamicSpec, selected);
          for (var dn = 0; dn < nested.length; dn++) {
            var nestedSpec = nested[dn];
            var nestedRaw = Object.prototype.hasOwnProperty.call(rawByName, nestedSpec.name)
              ? rawByName[nestedSpec.name] : undefined;
            var nestedValue;
            if (Object.prototype.hasOwnProperty.call(nodeOverrides, nestedSpec.name)) {
              nestedValue = coerce(nestedSpec, nodeOverrides[nestedSpec.name]);
              if (nestedValue === undefined) nestedValue = coerce(nestedSpec, nestedRaw);
            } else {
              nestedValue = coerce(nestedSpec, nestedRaw);
            }
            if (nestedValue === undefined) {
              if (nestedSpec.required) {
                result.missing.push({ nodeId: node.id, nodeType: node.type, input: nestedSpec.name });
              }
              continue;
            }
            if (inputs[nestedSpec.name] === undefined) inputs[nestedSpec.name] = nestedValue;
          }
        }
      }

      /* 3. required inputs with neither widget nor link */
      if (definition.input && definition.input.required) {
        Object.keys(definition.input.required).forEach(function (name) {
          if (inputs[name] !== undefined) return;
          var spec2 = definition.input.required[name];
          var opts2 = inputOptions(spec2);
          if (opts2 && opts2.forceInput) return;
          var type2 = Array.isArray(spec2) ? spec2[0] : spec2;
          if (typeof type2 === 'string' && PRIMITIVE_TYPES[type2]) {
            if (opts2['default'] !== undefined) {
              inputs[name] = coerce({ kind: lower(type2), options: opts2, values: null }, opts2['default']);
            } else if (spec2 && spec2[1] && spec2[1].default !== undefined) {
              inputs[name] = coerce({ kind: lower(type2), options: spec2[1], values: null }, spec2[1].default);
            } else {
              result.missing.push({ nodeId: node.id, nodeType: node.type, input: name });
            }
          }
        });
      }

      var title = parseTitle(node, node.type);
      var entry = { class_type: node.type, inputs: inputs };
      if (title.raw) entry._meta = { title: title.raw.replace(/^#+\s*/, '') };
      result.prompt[String(node.id)] = entry;
    }

    /* 4. prune branches the requested output(s) never reach */
    if (options.prune !== false) result.prompt = pruneGraph(result.prompt, roots, result);

    /* 4b. batch runs (x2 / x5): give every seed a new value, otherwise the
     * server returns the cached identical picture. */
    if (typeof options.varySeeds === 'function') {
      result.prompt = varyPromptSeeds(result.prompt, options, fixedSeeds);
    }

    var kept = Object.keys(result.prompt);

    /* 5. dangling references (only inside what is actually sent) */
    kept.forEach(function (id) {
      var inputs = result.prompt[id].inputs || {};
      Object.keys(inputs).forEach(function (key) {
        var value = inputs[key];
        if (!isLinkRef(value)) return;
        var target = String(value[0]);
        if (Object.prototype.hasOwnProperty.call(result.prompt, target)) return;
        if (unknownIds[target]) {
          result.errors.push('Node #' + id + ' input "' + key + '" comes from node #' + target +
            ' of type "' + unknownIds[target] + '", which is not installed on the ComfyUI server.');
        } else {
          result.errors.push('Node #' + id + ' input "' + key + '" points at missing node #' + target +
            ' (it is muted, deleted, or its custom node is not installed).');
        }
      });
    });

    /* A selected output that cannot be built (custom save node) is an error,
     * even though the rest of the graph was kept as a fallback. */
    (roots || []).forEach(function (root) {
      var id = String(root);
      if (!Object.prototype.hasOwnProperty.call(result.prompt, id) && unknownIds[id]) {
        result.errors.push('The selected output node #' + id + ' has type "' + unknownIds[id] +
          '", which is not installed on the ComfyUI server.');
      }
    });

    var unknownNeeded = {};
    kept.forEach(function (id) {
      var inputs = result.prompt[id].inputs || {};
      Object.keys(inputs).forEach(function (key) {
        var value = inputs[key];
        if (isLinkRef(value) && unknownIds[String(value[0])]) {
          unknownNeeded[unknownIds[String(value[0])]] = true;
        }
      });
    });
    Object.keys(unknownNeeded).forEach(function (type) {
      if (result.errors.join('\n').indexOf('"' + type + '"') >= 0) return;
      result.errors.push('Missing custom node "' + type + '" is required by the selected output.');
    });

    if (result.missing.length) {
      var keptSet = {};
      kept.forEach(function (id) { keptSet[id] = true; });
      result.missing = result.missing.filter(function (m) { return keptSet[String(m.nodeId)]; });
      if (result.missing.length) {
        result.errors.push('Missing required input values: ' + result.missing.map(function (m) {
          return 'node #' + m.nodeId + ' (' + m.nodeType + ') input "' + m.input + '"';
        }).join(', ') + '. Fill them in ComfyUI, or rename the node to "#' + result.missing[0].input + '" to edit it from Photoshop.');
      }
    }

    return result;
  }

  /* Keep only nodes reachable from `roots` (walking upstream). */
  function pruneGraph(prompt, roots, result) {
    if (!roots || !roots.length) return prompt;
    var needed = {};
    var stack = roots.map(function (r) { return String(r); });
    var guard = 0;
    while (stack.length && guard++ < 100000) {
      var id = stack.pop();
      if (needed[id]) continue;
      var entry = prompt[id];
      if (!entry) continue;
      needed[id] = true;
      Object.keys(entry.inputs).forEach(function (key) {
        var v = entry.inputs[key];
        if (Array.isArray(v) && v.length === 2) stack.push(String(v[0]));
      });
    }
    var out = {};
    Object.keys(prompt).forEach(function (id) {
      if (needed[id]) out[id] = prompt[id];
      else if (result) result.pruned = (result.pruned || 0) + 1;
    });
    /* if the roots were bogus keep everything rather than sending nothing */
    return Object.keys(out).length ? out : prompt;
  }

  /* ------------------------------------------------------------------ */
  /* Photoshop layer tokens (sd-ppp style control by layer name)         */
  /* ------------------------------------------------------------------ */
  /*
   * A layer named  "#cs steps=25"  or  "#cs prompt += cinematic"  sets a
   * parameter of the exposed node whose label/widget name matches.
   * Scope it to one node: "#cs KSampler.seed=12".
   */
  function parseLayerTokens(layerNames) {
    var tokens = [];
    (layerNames || []).forEach(function (name) {
      var m = String(name).match(/#cs[:\s]+([^\s]+)\s*([+-]?=)\s*(.*)$/i);
      if (!m) return;
      tokens.push({ path: m[1].trim(), op: m[2], value: m[3].trim(), raw: String(name) });
    });
    return tokens;
  }

  function mainWidgetOf(node) {
    var widgets = node.widgets || [];
    for (var i = 0; i < widgets.length; i++) {
      if (widgets[i].kind === 'text' || widgets[i].kind === 'string') return widgets[i];
    }
    return widgets[0] || null;
  }

  function applyLayerTokens(model, tokens) {
    var applied = [];
    var unmatched = [];
    (tokens || []).forEach(function (token) {
      var scope = null;
      var key = token.path;
      var dot = token.path.indexOf('.');
      if (dot > 0) { scope = token.path.slice(0, dot).toLowerCase(); key = token.path.slice(dot + 1); }

      var target = null;
      var nodes = model.exposed || [];
      var byNodeLabel = null;
      for (var i = 0; i < nodes.length && !target; i++) {
        var node = nodes[i];
        if (scope && lower(node.title) !== scope && String(node.id) !== scope) continue;
        for (var w = 0; w < (node.widgets || []).length; w++) {
          var widget = node.widgets[w];
          if (lower(widget.name) === lower(key) || lower(widget.label || '') === lower(key)) {
            target = { node: node, widget: widget };
            break;
          }
        }
        if (!target && !scope && (lower(node.title) === lower(key) || String(node.id) === key)) {
          byNodeLabel = { node: node, widget: mainWidgetOf(node) };
        }
      }
      if (!target) target = byNodeLabel;
      if (!target || !target.widget) { unmatched.push(token.path); return; }

      var value = token.value;
      var kind = target.widget.kind;
      if (token.op === '+=') value = String(target.widget.value === undefined ? '' : target.widget.value) + ' ' + value;
      else if (token.op === '-=') value = String(target.widget.value === undefined ? '' : target.widget.value).replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim();
      else if (kind === 'int') value = parseInt(value, 10);
      else if (kind === 'float') value = parseFloat(value);
      else if (kind === 'boolean') value = /^(1|true|yes|on)$/i.test(value);

      applied.push({ nodeId: target.node.id, name: target.widget.name, value: value });
    });
    return { applied: applied, unmatched: unmatched };
  }

  return {
    parseTitle: parseTitle,
    looksLikeApiFormat: looksLikeApiFormat,
    isApiFormat: looksLikeApiFormat,
    apiToUI: apiToUI,
    flattenSubgraphs: flattenSubgraphs,
    buildModel: buildModel,
    buildPrompt: buildPrompt,
    widgetSpecs: widgetSpecs,
    alignWidgets: alignWidgets,
    coerce: coerce,
    isImageOutput: isImageOutput,
    isActive: isActive,
    passthroughType: passthroughType,
    IMAGE_KEYS: IMAGE_KEYS,
    parseLayerTokens: parseLayerTokens,
    applyLayerTokens: applyLayerTokens
  };
});
