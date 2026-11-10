/*
 * ComfyShop - Photoshop (UXP) side.
 *
 * Responsibilities:
 *   - export the current document / active layer / selection as a PNG file
 *   - insert a generated image back into the original document as a new layer
 *
 * Selection and layer bounds are read from the source document before it is
 * duplicated, and layer/selection exports keep transparency.
 *
 * All mutating operations run inside Photoshop's modal execution scope.
 */
(function (root, factory) {
  if (typeof document !== 'undefined' && root) { root.CSPhotoshop = factory(); return; }
  if (typeof module === 'object' && module.exports) { module.exports = factory; return; }
  root.CSPhotoshop = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  deps = deps || {};
  var photoshop = deps.photoshop || (typeof require === 'function' ? require('photoshop') : null);
  var uxpStorage = null;
  try {
    uxpStorage = (typeof require === 'function' ? require('uxp') : null).storage;
  } catch (e) { /* not in UXP */ }

  var app = photoshop && photoshop.app;
  var core = photoshop && photoshop.core;
  var action = photoshop && photoshop.action;
  var constants = photoshop && photoshop.constants;

  function batchPlay(commands, options) {
    return action.batchPlay(commands, options || {});
  }

  function withModal(fn, commandName) {
    return core.executeAsModal(fn, { commandName: commandName || 'ComfyShop', interactive: false });
  }

  function pixelDescriptor(value) {
    return { _unit: 'pixelsUnit', _value: value };
  }

  function activeDocument() {
    var doc = app && app.activeDocument;
    if (!doc) throw new Error('Open a document in Photoshop first.');
    return doc;
  }

  function uniqueName(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  }

  async function getTempFile(name) {
    var lfs = uxpStorage.localFileSystem;
    var folder = await lfs.getTemporaryFolder();
    return folder.createFile(name, { overwrite: true });
  }

  async function readEntryBytes(entry) {
    var formats = uxpStorage.formats;
    if (formats && formats.binary) {
      return entry.read({ format: formats.binary });
    }
    return entry.read();
  }

  async function writeEntryBytes(entry, bytes) {
    var formats = uxpStorage.formats;
    if (formats && formats.binary) {
      await entry.write(bytes, { format: formats.binary });
    } else {
      await entry.write(bytes);
    }
  }

  async function deleteEntry(entry) {
    try { await entry.delete(); } catch (e) { /* ignore */ }
  }

  /* Convert a duplicated document to plain 8 bit RGB so ComfyUI can read it. */
  async function normalizeDocument(doc) {
    var DocumentMode = constants.DocumentMode;
    var BitsPerChannelType = constants.BitsPerChannelType;
    try {
      if (DocumentMode && doc.mode !== DocumentMode.RGB) {
        await doc.changeMode(DocumentMode.RGB);
      }
    } catch (e) { /* e.g. 32-bit/gray - continue and let saveAs complain */ }
    try {
      if (BitsPerChannelType && doc.bitsPerChannel !== BitsPerChannelType.EIGHT) {
        doc.bitsPerChannel = BitsPerChannelType.EIGHT;
      }
    } catch (e) { /* ignore */ }
  }

  function walkLayers(layers, visit, depth) {
    depth = depth || 0;
    for (var i = 0; i < (layers || []).length; i++) {
      var layer = layers[i];
      visit(layer, depth);
      if (layer.layers && layer.layers.length) walkLayers(layer.layers, visit, depth + 1);
    }
  }

  function findLayerById(layers, id) {
    var found = null;
    walkLayers(layers, function (layer) {
      if (!found && layer.id === id) found = layer;
    });
    return found;
  }

  function layerPathOf(doc, layerId) {
    var path = null;
    function visit(layers, stack) {
      for (var i = 0; i < (layers || []).length; i++) {
        var layer = layers[i];
        var next = stack.concat([i]);
        if (layer.id === layerId) { path = next; return true; }
        if (layer.layers && layer.layers.length && visit(layer.layers, next)) return true;
      }
      return false;
    }
    visit(doc.layers, []);
    return path ? { path: path } : null;
  }

  /* A duplicated document usually keeps layer ids, but when it does not, the
   * layer name plus its position in the layer tree is used as a fallback. */
  function isolateLayer(layers, keepId, keepName, keepPath) {
    var found = false;
    for (var i = 0; i < (layers || []).length; i++) {
      var layer = layers[i];
      var isPathMatch = keepPath && keepPath[0] === i;
      var childPath = isPathMatch ? keepPath.slice(1) : null;
      var keep = layer.id === keepId || (keepName && layer.name === keepName && isPathMatch);
      if (keep) {
        layer.visible = true;
        found = true;
        continue;
      }
      if (layer.layers && layer.layers.length && childPath && childPath.length) {
        if (isolateLayer(layer.layers, keepId, keepName, childPath)) {
          layer.visible = true;
          found = true;
        } else {
          layer.visible = false;
        }
      } else {
        layer.visible = false;
      }
    }
    return found;
  }

  function boundsOf(obj) {
    if (!obj || !obj.bounds) return null;
    var b = obj.bounds;
    return {
      left: Math.round(Number(b.left) || 0),
      top: Math.round(Number(b.top) || 0),
      right: Math.round(Number(b.right) || 0),
      bottom: Math.round(Number(b.bottom) || 0),
      width: Math.max(0, Math.round(Number(b.right) - Number(b.left))),
      height: Math.max(0, Math.round(Number(b.bottom) - Number(b.top)))
    };
  }

  function rectOf(obj) {
    var b = boundsOf(obj);
    if (!b || b.width <= 0 || b.height <= 0) return null;
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  }

  function selectionBounds(doc) {
    try {
      var b = doc.selection && doc.selection.bounds;
      return b ? rectOf({ bounds: b }) : null;
    } catch (e) {
      return null;
    }
  }

  /* Make a crop rect smaller (never larger than the document). */
  function clampRect(rect, doc) {
    if (!rect) return null;
    var w = Math.round(Number(doc.width) || 0);
    var h = Math.round(Number(doc.height) || 0);
    var left = Math.max(0, Math.min(w, Math.round(rect.left)));
    var top = Math.max(0, Math.min(h, Math.round(rect.top)));
    var right = Math.max(left, Math.min(w, Math.round(rect.right)));
    var bottom = Math.max(top, Math.min(h, Math.round(rect.bottom)));
    if (right - left < 1 || bottom - top < 1) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function evenRect(rect, doc) {
    if (!rect) return rect;
    var w = rect.width;
    var h = rect.height;
    if (w % 2) w -= 1;
    if (h % 2) h -= 1;
    if (w < 1 || h < 1) return rect;
    return clampRect({ left: rect.left, top: rect.top, right: rect.left + w, bottom: rect.top + h }, doc);
  }

  async function cropDocument(doc, rect) {
    try {
      await deselect(doc);
      await batchPlay([{
        _obj: 'crop',
        rect: {
          top: pixelDescriptor(rect.top),
          left: pixelDescriptor(rect.left),
          bottom: pixelDescriptor(rect.bottom),
          right: pixelDescriptor(rect.right)
        },
        useSelectedLayer: false,
        _options: { dialogOptions: 'dontDisplay' }
      }], { documentID: doc.id });
      return true;
    } catch (e) {
      /* Never fall back to doc.crop(): on some documents it opens a modal
       * "selection is empty" error. The caller handles a failed crop. */
      return false;
    }
  }

  async function deselect(doc) {
    try {
      if (doc && doc.selection) await doc.selection.deselect();
    } catch (e) { /* no selection / not supported */ }
  }

  /* Trim transparent padding instead of using the crop command. Crop can
   * show a modal "selected area is empty" error on some layer documents. */
  async function trimTransparent(doc) {
    try {
      await deselect(doc);
      await batchPlay([{
        _obj: 'trim',
        trimType: 'transparent',
        top: true,
        left: true,
        bottom: true,
        right: true,
        _options: { dialogOptions: 'dontDisplay' }
      }], { documentID: doc.id });
      return true;
    } catch (e) {
      return false;
    }
  }

  function documentInfo() {
    var doc = app && app.activeDocument;
    if (!doc) return null;
    var info = {
      id: doc.id,
      name: doc.name,
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      resolution: doc.resolution,
      mode: doc.mode,
      bits: doc.bitsPerChannel,
      layers: doc.layers ? doc.layers.length : 0
    };

    try {
      var active = doc.activeLayers && doc.activeLayers[0];
      if (active) {
        info.activeLayerName = active.name;
        info.activeLayerId = active.id;
        info.activeLayerBounds = boundsOf(active);
      }
    } catch (e) { /* ignore */ }
    try {
      info.selection = selectionBounds(doc);
    } catch (e) { /* ignore */ }
    return info;
  }

  /* Lightweight active-document check used by the panel's document hint. */
  function documentInfoLight() {
    var doc = app && app.activeDocument;
    if (!doc) return null;
    return { name: doc.name, width: Math.round(doc.width), height: Math.round(doc.height) };
  }

  /* Export the requested source to a PNG in Photoshop's temp folder.
   *
   * kind: 'document' | 'layer' | 'selection'
   * options: { alpha: bool, alignToEven: bool, maxSize: int }
   * Returns { entry, path, kind, origin, width, height, docWidth, docHeight }.
   */
  async function exportSource(kind, options) {
    kind = kind || 'document';
    options = options || {};
    var source = activeDocument();
    var sourceId = source.id;

    /* Everything that only exists in the source document must be captured
     * before duplicating: the duplicate does not reliably keep the selection,
     * and layer ids/paths may change. */
    var selRect = kind === 'selection' ? selectionBounds(source) : null;
    var active = source.activeLayers && source.activeLayers[0];
    var keepId = active ? active.id : null;
    var keepName = active ? active.name : null;
    var keepPath = keepId !== null ? layerPathOf(source, keepId) : null;
    var keepBounds = active ? boundsOf(active) : null;

    if (kind === 'selection' && !selRect) throw new Error('There is no active selection in this document.');
    if (kind === 'layer' && keepId === null) throw new Error('Select a layer first.');

    var entry = null;
    var meta = { origin: { x: 0, y: 0 }, crop: null, width: 0, height: 0 };

    await withModal(async function () {
      var duplicate = await source.duplicate(uniqueName('ComfyShop export'));
      try {
        var origin = { x: 0, y: 0 };
        var crop = null;

        if (kind === 'selection') {
          crop = options.alignToEven ? evenRect(selRect, duplicate) : clampRect(selRect, duplicate);
          if (!crop) throw new Error('The selection is empty or outside the canvas.');
          origin = { x: crop.left, y: crop.top };
          if (!await cropDocument(duplicate, crop)) throw new Error('Photoshop could not crop the selection area.');
        } else if (kind === 'layer') {
          if (!isolateLayer(duplicate.layers, keepId, keepName, keepPath && keepPath.path)) {
            throw new Error('The active layer could not be isolated for export.');
          }
          if (keepBounds) {
            var dupW = Math.round(duplicate.width);
            var dupH = Math.round(duplicate.height);
            var fullCanvas = keepBounds.left <= 0 && keepBounds.top <= 0 &&
              keepBounds.right >= dupW && keepBounds.bottom >= dupH;
            if (fullCanvas) {
              crop = null;
              origin = { x: 0, y: 0 };
            } else {
              crop = keepBounds;
              origin = { x: keepBounds.left, y: keepBounds.top };
              if (!await trimTransparent(duplicate)) {
                /* Empty/edge layers may not trim; keep the full transparent
                 * canvas instead of showing a Photoshop error dialog. */
                crop = null;
                origin = { x: 0, y: 0 };
              }
            }
          }
        } else {
          await duplicate.flatten();
        }

        await normalizeDocument(duplicate);

        if (options.maxSize) {
          var dw = Math.round(duplicate.width);
          var dh = Math.round(duplicate.height);
          var scale = Math.min(1, options.maxSize / Math.max(dw, dh));
          if (scale < 1) {
            await batchPlay([{
              _obj: 'imageResize',
              width: pixelDescriptor(Math.max(2, Math.round(dw * scale))),
              height: pixelDescriptor(Math.max(2, Math.round(dh * scale))),
              constrainProportions: true,
              resizeImageMode: 'bicubicInterpolation',
              _options: { dialogOptions: 'dontDisplay' }
            }], { documentID: duplicate.id });
          }
        }

        entry = await getTempFile(uniqueName('comfyshop_input') + '.png');
        await duplicate.saveAs.png(entry, { compression: 6 }, true);
        meta = {
          origin: origin,
          crop: crop,
          width: Math.round(duplicate.width),
          height: Math.round(duplicate.height)
        };
      } finally {
        try { await duplicate.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e) { /* ignore */ }
        try {
          for (var d = 0; d < app.documents.length; d++) {
            if (app.documents[d].id === sourceId) { app.activeDocument = app.documents[d]; break; }
          }
        } catch (e) { /* ignore */ }
      }
    }, 'ComfyShop export');

    if (!entry) throw new Error('Export failed: no PNG was written.');

    return {
      entry: entry,
      path: entry.nativePath,
      kind: kind,
      origin: meta.origin,
      crop: meta.crop,
      width: meta.width,
      height: meta.height,
      docWidth: Math.round(source.width),
      docHeight: Math.round(source.height),
      sourceDocId: sourceId
    };
  }

  /* Insert an image file into the active document as a new layer.
   *
   * A generated PNG is opened as a temporary document, its single raster
   * layer is duplicated into the target document, and the temporary document
   * is closed. This avoids File > Place / placeEvent, which leaves Photoshop
   * waiting in Free Transform mode when called from a UXP panel.
   *
   * options: { origin:{x,y}, name, width, height }
   *   width/height: target size in the destination document (the generated
   *   image is scaled to it when they differ).
   * Returns { layerId, layerName, bounds }.
   */

  function descriptorValue(v) {
    if (v && typeof v === 'object' && v._value !== undefined) return Number(v._value);
    return Number(v);
  }

  function firstResult(result) {
    return Array.isArray(result) ? result[0] : result;
  }

  async function layerBounds(layerId, docId) {
    var info = firstResult(await batchPlay([{
      _obj: 'get',
      _target: [{ _ref: 'layer', _id: layerId }],
      property: ['bounds']
    }], { documentID: docId, showDialogs: false }));
    var b = info && info.bounds;
    if (!b) return null;
    return {
      left: Math.round(descriptorValue(b.left)),
      top: Math.round(descriptorValue(b.top)),
      right: Math.round(descriptorValue(b.right)),
      bottom: Math.round(descriptorValue(b.bottom)),
      width: Math.round(descriptorValue(b.right) - descriptorValue(b.left)),
      height: Math.round(descriptorValue(b.bottom) - descriptorValue(b.top))
    };
  }

  async function scaleLayerTo(layerId, width, height, docId) {
    if (!width || !height) return false;
    try {
      var box = await layerBounds(layerId, docId);
      if (!box || !box.width || !box.height) return false;
      var sx = (width / box.width) * 100;
      var sy = (height / box.height) * 100;
      if (Math.abs(sx - 100) < 0.5 && Math.abs(sy - 100) < 0.5) return false;
      await batchPlay([{
        _obj: 'transform',
        _target: [{ _ref: 'layer', _id: layerId }],
        layer: [{ _ref: 'layer', _id: layerId }],
        numberOfLayers: 1,
        freeTransformCenterpoint: { _offset: 'center' },
        transformContent: 'both',
        transformQuiet: true,
        xx: { _unit: 'percentUnit', _value: sx },
        yy: { _unit: 'percentUnit', _value: sy },
        _options: { dialogOptions: 'dontDisplay' }
      }], { documentID: docId });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function moveLayerTo(layerId, x, y, docId) {
    try {
      var box = await layerBounds(layerId, docId);
      if (!box) return;
      var dx = Math.round((Number(x) || 0) - box.left);
      var dy = Math.round((Number(y) || 0) - box.top);
      if (!dx && !dy) return;
      await batchPlay([{
        _obj: 'move',
        _target: [{ _ref: 'layer', _id: layerId }],
        to: {
          _obj: 'offset',
          horizontal: pixelDescriptor(dx),
          vertical: pixelDescriptor(dy)
        },
        _options: { dialogOptions: 'dontDisplay' }
      }], { documentID: docId });
    } catch (e) { /* leave the layer where it landed */ }
  }

  async function insertFile(entry, options) {
    options = options || {};
    var placement = options.origin || { x: 0, y: 0 };
    var layerName = options.name || ('ComfyShop ' + new Date().toLocaleTimeString());

    return withModal(async function () {
      var target = activeDocument();
      var targetId = target.id;
      var temp = null;

      try {
        temp = await app.open(entry);
      } catch (e) {
        throw new Error('Cannot open the generated image: ' + (e && (e.message || e)));
      }

      try {
        if (!temp || !temp.layers || !temp.layers.length) {
          throw new Error('The generated image opened but has no layer.');
        }

        var tempLayer = temp.activeLayers && temp.activeLayers[0];
        if (!tempLayer) tempLayer = temp.layers[0];

        // Duplicate the raster layer straight into the original document.
        try {
          await batchPlay([{
            _obj: 'duplicate',
            _target: [{ _ref: 'layer', _id: tempLayer.id }],
            to: { _ref: 'document', _id: targetId },
            moveInPlace: true,
            _options: { dialogOptions: 'dontDisplay' }
          }], { documentID: temp.id });
        } catch (dupError) {
          // DOM fallback if the raw descriptor is rejected.
          var targetDoc = null;
          for (var t = 0; t < app.documents.length; t++) {
            if (app.documents[t].id === targetId) { targetDoc = app.documents[t]; break; }
          }
          if (!targetDoc) throw dupError;
          await tempLayer.duplicate(targetDoc);
        }

        // Re-acquire the target document (opening the temp doc changed focus).
        var doc = null;
        for (var i = 0; i < app.documents.length; i++) {
          if (app.documents[i].id === targetId) { doc = app.documents[i]; break; }
        }
        if (!doc) throw new Error('The original document was closed during insertion.');
        app.activeDocument = doc;

        var layer = doc.activeLayers && doc.activeLayers[0];
        if (!layer) throw new Error('Photoshop duplicated the image but no layer was created.');

        var layerId = layer.id;
        try { layer.name = layerName; } catch (e) { /* ignore */ }

        if (options.width && options.height) {
          await scaleLayerTo(layerId, Number(options.width), Number(options.height), targetId);
        }
        await moveLayerTo(layerId, placement.x, placement.y, targetId);

        var finalBounds = await layerBounds(layerId, targetId);
        if (!finalBounds) {
          var finalLayer = findLayerById(doc.layers, layerId);
          finalBounds = finalLayer ? boundsOf(finalLayer) : null;
        }

        return {
          layerId: layerId,
          layerName: layerName,
          bounds: finalBounds,
          documentName: doc.name,
          documentId: doc.id
        };
      } finally {
        if (temp) {
          try { await temp.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e) { /* ignore */ }
        }
        try {
          for (var j = 0; j < app.documents.length; j++) {
            if (app.documents[j].id === targetId) { app.activeDocument = app.documents[j]; break; }
          }
        } catch (e) { /* ignore */ }
      }
    }, 'ComfyShop insert');
  }

  /* Rename a layer after the result has been inserted. */
  async function renameLayer(layerId, name) {
    return withModal(async function () {
      var doc = activeDocument();
      var layer = findLayerById(doc.layers, layerId);
      if (!layer) throw new Error('Layer ' + layerId + ' was not found.');
      layer.name = name;
      return { layerId: layerId, layerName: name };
    }, 'ComfyShop rename layer');
  }

  /* Open a file as a new Photoshop document (used by the automated test). */
  async function openEntry(entry) {
    return withModal(async function () {
      return app.open(entry);
    }, 'ComfyShop open');
  }

  /* Small helper used by the diagnostics command. */
  async function selfTest() {
    var report = {};
    report.document = documentInfo();
    if (!report.document) throw new Error('No open document for self test.');
    var exported = await exportSource('document');
    report.exported = {
      path: exported.path,
      width: exported.width,
      height: exported.height,
      docWidth: exported.docWidth,
      docHeight: exported.docHeight,
      origin: exported.origin,
      crop: exported.crop
    };
    var inserted = await insertFile(exported.entry, {
      name: 'ComfyShop self test',
      origin: exported.origin,
      width: exported.width,
      height: exported.height
    });
    report.inserted = inserted;
    await deleteEntry(exported.entry);
    return report;
  }

  return {
    app: app,
    withModal: withModal,
    documentInfo: documentInfo,
    documentInfoLight: documentInfoLight,
    exportSource: exportSource,
    insertFile: insertFile,
    getTempFile: getTempFile,
    readEntryBytes: readEntryBytes,
    writeEntryBytes: writeEntryBytes,
    deleteEntry: deleteEntry,
    renameLayer: renameLayer,
    openEntry: openEntry,
    selfTest: selfTest
  };
});

