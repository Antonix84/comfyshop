/*
 * ComfyShop - Photoshop (UXP) side.
 *
 * Responsibilities:
 *   - export the current document / active layer / selection as a PNG file
 *   - insert a generated PNG back into the original document as a new layer
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
    return core.executeAsModal(fn, { commandName: commandName || 'ComfyShop' });
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

  function layerContains(layer, id) {
    if (layer.id === id) return true;
    var children = layer.layers;
    if (!children) return false;
    for (var i = 0; i < children.length; i++) {
      if (layerContains(children[i], id)) return true;
    }
    return false;
  }

  /* Show only the given layer (and the groups containing it). */
  function isolateLayer(layers, keepId) {
    var found = false;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer.id === keepId) {
        layer.visible = true;
        found = true;
        continue;
      }
      if (layer.layers && layerContains(layer, keepId)) {
        layer.visible = true;
        if (isolateLayer(layer.layers, keepId)) found = true;
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
      left: Math.round(b.left),
      top: Math.round(b.top),
      right: Math.round(b.right),
      bottom: Math.round(b.bottom),
      width: Math.round(b.right - b.left),
      height: Math.round(b.bottom - b.top)
    };
  }

  function documentInfo() {
    var doc = app && app.activeDocument;
    if (!doc) return null;
    var info = {
      id: doc.id,
      name: doc.name,
      width: Math.round(doc.width),
      height: Math.round(doc.height),
      mode: doc.mode,
      bits: doc.bitsPerChannel,
      layers: doc.layers ? doc.layers.length : 0
    };
    try {
      var active = doc.activeLayers && doc.activeLayers[0];
      if (active) {
        info.activeLayerName = active.name;
        info.activeLayerId = active.id;
      }
    } catch (e) { /* ignore */ }
    try {
      if (doc.selection && doc.selection.bounds) {
        info.selection = boundsOf(doc.selection);
      }
    } catch (e) { /* ignore */ }
    return info;
  }

  /* Export the requested source to a PNG in Photoshop's temp folder.
   *
   * kind: 'document' | 'layer' | 'selection'
   * Returns { entry, name, width, height, origin:{x,y}, kind }.
   */
  async function exportSource(kind) {
    kind = kind || 'document';
    var source = activeDocument();
    var sourceId = source.id;
    var origin = { x: 0, y: 0 };
    var entry = null;

    var result = await withModal(async function () {
      var duplicate = await source.duplicate(uniqueName('ComfyShop export'));
      try {
        if (kind === 'selection') {
          var sel = null;
          try { sel = duplicate.selection && duplicate.selection.bounds; } catch (e) { sel = null; }
          if (sel) {
            var b = boundsOf(duplicate.selection);
            if (b && b.width > 0 && b.height > 0) {
              origin = { x: b.left, y: b.top };
              await duplicate.crop({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
            }
          }
        } else if (kind === 'layer') {
          var active = source.activeLayers && source.activeLayers[0];
          var keepId = active ? active.id : null;
          var keepBounds = active ? boundsOf(active) : null;
          if (keepBounds) origin = { x: keepBounds.left, y: keepBounds.top };
          if (keepId !== null) {
            isolateLayer(duplicate.layers, keepId);
          }
        }

        await normalizeDocument(duplicate);
        await duplicate.flatten();
        entry = await getTempFile(uniqueName('comfyshop_input') + '.png');
        await duplicate.saveAs.png(entry, { compression: 6 }, true);
      } finally {
        try { await duplicate.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e) { /* ignore */ }
        try { if (app.documents.length) app.activeDocument = source; } catch (e) { /* ignore */ }
      }
      return duplicate;
    }, 'ComfyShop export');

    if (!entry) throw new Error('Export failed: no PNG was written.');
    var width = 0;
    var height = 0;
    try {
      width = Math.round(source.width);
      height = Math.round(source.height);
    } catch (e) { /* ignore */ }

    return {
      entry: entry,
      path: entry.nativePath,
      kind: kind,
      origin: origin,
      docWidth: width,
      docHeight: height,
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
   * Returns { layerId, layerName, bounds }.
   */
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
            _options: { dialogOptions: 'dontDisplay' }
          }], {});
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

        // Cross-document duplication can keep absolute coordinates. Move the
        // layer so its top-left sits at the requested origin.
        var b = boundsOf(layer);
        if (b) {
          var dx = Math.round(Number(placement.x) || 0) - b.left;
          var dy = Math.round(Number(placement.y) || 0) - b.top;
          if (dx !== 0 || dy !== 0) {
            try {
              await batchPlay([{
                _obj: 'move',
                _target: [{ _ref: 'layer', _id: layerId }],
                to: {
                  _obj: 'offset',
                  horizontal: { _unit: 'pixelsUnit', _value: dx },
                  vertical: { _unit: 'pixelsUnit', _value: dy }
                },
                _options: { dialogOptions: 'dontDisplay' }
              }], {});
            } catch (e) { /* leave the layer at its natural position */ }
          }
        }

        return {
          layerId: layerId,
          layerName: layerName,
          bounds: boundsOf(layer),
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

  function findLayerById(layers, id) {
    for (var i = 0; i < (layers || []).length; i++) {
      var layer = layers[i];
      if (layer.id === id) return layer;
      var child = findLayerById(layer.layers, id);
      if (child) return child;
    }
    return null;
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
    report.exported = { path: exported.path, width: exported.docWidth, height: exported.docHeight };
    var inserted = await insertFile(exported.entry, { name: 'ComfyShop self test', origin: { x: 0, y: 0 } });
    report.inserted = inserted;
    await deleteEntry(exported.entry);
    return report;
  }

  return {
    app: app,
    withModal: withModal,
    documentInfo: documentInfo,
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

