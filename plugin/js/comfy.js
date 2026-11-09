/*
 * ComfyShop - thin ComfyUI HTTP/WebSocket client.
 *
 * No dependencies. Works in the Photoshop UXP panel (window.CSComfy) and in
 * Node 18+ (module.exports) so the pipeline can be tested outside Photoshop.
 */
(function (root, factory) {
  if (typeof document !== "undefined" && root) { root.CSComfy = factory(); return; }
  if (typeof module === "object" && module.exports) { module.exports = factory(); return; }
  root.CSComfy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeHost(host) {
    var h = String(host || '').trim();
    if (!h) h = 'http://127.0.0.1:7861';
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h.replace(/\/+$/, '');
  }

  function wsUrl(host) {
    return normalizeHost(host).replace(/^http/i, 'ws');
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randomId() {
    var s = '';
    var chars = 'abcdef0123456789';
    for (var i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  function isPlain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /* ComfyUI answers /prompt with { error, node_errors } - turn that blob
   * into something a human can act on instead of a wall of JSON. */
  function formatPromptError(json) {
    var lines = [];
    var err = json && json.error;
    if (err && (err.message || err.type)) lines.push(String(err.message || err.type));
    if (err && err.details) lines.push(String(err.details));
    var nodeErrors = json && json.node_errors;
    if (isPlain(nodeErrors)) {
      Object.keys(nodeErrors).forEach(function (nodeId) {
        var errs = nodeErrors[nodeId] || {};
        var meta = (errs._meta && (errs._meta.name || errs._meta.type)) || ('node #' + nodeId);
        (errs.errors || []).forEach(function (e) {
          var bits = [meta];
          if (e.type) bits.push(e.type);
          if (e.message) bits.push(String(e.message));
          if (e.input_name) bits.push('input "' + e.input_name + '"');
          if (e.value !== undefined && e.value !== null) bits.push('value: ' + JSON.stringify(e.value));
          if (Array.isArray(e.input_config)) bits.push('expected: ' + JSON.stringify(e.input_config[0]));
          lines.push('- ' + bits.join(': '));
        });
      });
    }
    return lines.filter(Boolean).join('\n');
  }

  async function readError(res) {
    var text = '';
    try { text = await res.text(); } catch (e) { /* ignore */ }
    var parsed = null;
    var friendly = '';
    try {
      parsed = JSON.parse(text);
      friendly = formatPromptError(parsed);
    } catch (e) { /* not json */ }
    var detail = friendly || text;
    var error = new Error('ComfyUI HTTP ' + res.status +
      (detail ? ': ' + String(detail).slice(0, 600) : ''));
    error.status = res.status;
    error.details = parsed || text;
    error.nodeErrors = parsed && parsed.node_errors;
    return error;
  }

  async function getJson(host, path) {
    var res = await fetch(normalizeHost(host) + path, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw await readError(res);
    return res.json();
  }

  async function postJson(host, path, body) {
    var res = await fetch(normalizeHost(host) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw await readError(res);
    var text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function systemStats(host) {
    return getJson(host, '/system_stats');
  }

  async function objectInfo(host) {
    return getJson(host, '/object_info');
  }

  /* UXP has no TextEncoder - encode UTF-8 by hand. */
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0xD800 || c >= 0xE000) {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return new Uint8Array(bytes);
  }

  function toUint8(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') {
      return utf8Bytes(value);
    }
    throw new Error('Unsupported binary value type');
  }

  function concatBytes(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  /* Upload an image to ComfyUI's input folder.
   * Returns { name, subfolder, type } where name is what LoadImage expects. */
  async function uploadImage(host, bytes, fileName, options) {
    options = options || {};
    var boundary = '----ComfyShop' + Date.now().toString(16) + randomId().slice(0, 8);
    var chunks = [];

    function field(name, value) {
      chunks.push(utf8Bytes('--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
    }

    field('type', options.type || 'input');
    field('overwrite', options.overwrite === false ? 'false' : 'true');
    if (options.subfolder) field('subfolder', options.subfolder);

    var name = fileName || ('comfyshop_' + Date.now() + '.png');
    var mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png';
    chunks.push(utf8Bytes('--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="image"; filename="' + name + '"\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n'));
    chunks.push(toUint8(bytes));
    chunks.push(utf8Bytes('\r\n--' + boundary + '--\r\n'));

    var body = concatBytes(chunks);
    var url = normalizeHost(host) + '/upload/image';
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: body
    });
    if (!res.ok) {
      /* very old servers only expose /input */
      var fallback = await fetch(normalizeHost(host) + '/input', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: body
      });
      if (!fallback.ok) throw await readError(res);
      var fallbackInfo = await fallback.json();
      return {
        name: fallbackInfo.name || name,
        subfolder: fallbackInfo.subfolder || options.subfolder || '',
        type: fallbackInfo.type || 'input'
      };
    }
    var info = await res.json();
    return {
      name: info.name || name,
      subfolder: info.subfolder || options.subfolder || '',
      type: info.type || 'input'
    };
  }

  async function queuePrompt(host, prompt, clientId) {
    return postJson(host, '/prompt', { prompt: prompt, client_id: clientId || randomId() });
  }

  async function history(host, promptId) {
    return getJson(host, '/history/' + encodeURIComponent(promptId));
  }

  async function queueState(host) {
    return getJson(host, '/queue');
  }

  async function interrupt(host) {
    return postJson(host, '/interrupt', {});
  }

  /* Remove a queued/running prompt, then interrupt the worker. */
  async function cancelPrompt(host, promptId) {
    try {
      await postJson(host, '/queue', { delete: promptId ? [promptId] : [] });
    } catch (e) { /* older servers only support /interrupt */ }
    try { return await interrupt(host); } catch (e) { return {}; }
  }

  async function clearQueue(host) {
    try { return await postJson(host, '/queue', { clear: true }); } catch (e) { return {}; }
  }

  async function deleteQueueItems(host) {
    return clearQueue(host);
  }

  var IMAGE_KEYS = ['images', 'gifs', 'videos'];

  var IMAGE_KEYS = ['images', 'gifs', 'videos'];

  function openSocket(host, clientId) {
    var socket = { ws: null, handler: null, queue: [], ready: Promise.resolve(false) };
    if (typeof WebSocket === 'undefined') return socket;

    var resolveReady = function () { };
    socket.ready = new Promise(function (resolve) { resolveReady = resolve; });
    var settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      if (socket.timer) { clearTimeout(socket.timer); socket.timer = null; }
      resolveReady(value);
    }

    try {
      var ws = new WebSocket(wsUrl(host) + '/ws?clientId=' + encodeURIComponent(clientId || 'comfyshop'));
      socket.ws = ws;
      if ('binaryType' in ws) { try { ws.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ } }
      socket.timer = setTimeout(function () { settle(false); }, 2000);
      ws.onopen = function () { settle(true); };
      ws.onerror = function () { settle(false); };
      ws.onclose = function () { settle(false); };
      ws.onmessage = function (event) {
        var payload = event && event.data !== undefined ? event.data : event;
        if (payload && typeof payload !== 'string') {
          try { payload = String(payload); } catch (e) { return; }
        }
        if (socket.handler) {
          socket.handler(payload);
        } else {
          socket.queue.push(payload);
          if (socket.queue.length > 300) socket.queue.shift();
        }
      };
    } catch (e) {
      socket.ws = null;
      settle(false);
    }
    return socket;
  }

  function closeSocket(socket) {
    if (!socket || !socket.ws) return;
    try { socket.ws.close(); } catch (e) { /* ignore */ }
    socket.ws = null;
  }

  function imagesOf(historyEntry) {
    var images = [];
    if (!historyEntry || !historyEntry.outputs) return images;
    var outputs = historyEntry.outputs;
    Object.keys(outputs).forEach(function (nodeId) {
      var out = outputs[nodeId] || {};
      IMAGE_KEYS.forEach(function (key) {
        var list = out[key];
        if (!Array.isArray(list)) return;
        list.forEach(function (img) {
          if (!img || !img.filename) return;
          images.push({
            nodeId: nodeId,
            key: key,
            filename: img.filename,
            subfolder: img.subfolder || '',
            type: img.type || 'output',
            format: img.format || '',
            animated: !!img.animated
          });
        });
      });
    });
    return images;
  }

  function viewUrl(host, image) {
    var params = '?filename=' + encodeURIComponent(image.filename) +
      '&subfolder=' + encodeURIComponent(image.subfolder || '') +
      '&type=' + encodeURIComponent(image.type || 'output');
    return normalizeHost(host) + '/view' + params;
  }

  async function fetchImage(host, image) {
    var res = await fetch(viewUrl(host, image));
    if (!res.ok) throw await readError(res);
    return res.arrayBuffer();
  }

  /* Wait until ComfyUI finishes the given prompt.
   *
   * Uses the websocket for progress and completion; history polling is a
   * safety net (and the only mechanism if websockets are unavailable).
   *
   * handlers: { onProgress(percent, nodeId), onExecuting(nodeId), onStatus(text),
   *             onQueued(position), timeoutMs, shouldCancel(), socket }
   */
  async function waitForPrompt(host, promptId, clientId, handlers) {
    handlers = handlers || {};
    var finished = null;
    var wsDone = false;
    var pollsWithoutHistory = 0;
    var socket = handlers.socket || openSocket(host, clientId);

    function report(pct, node) {
      if (handlers.onProgress) {
        try { handlers.onProgress(pct, node); } catch (e) { /* ignore */ }
      }
    }

    function status(text) {
      if (handlers.onStatus) {
        try { handlers.onStatus(text); } catch (e) { /* ignore */ }
      }
    }

    function finish(value, error) {
      if (finished) return;
      finished = { value: value, error: error };
    }

    function handleWsPayload(raw) {
      if (typeof raw !== 'string') return;
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (raw.indexOf('"type"') < 0 && raw.indexOf('"type":') < 0) return;
      var data = msg.data || {};
      if (data.prompt_id && promptId && String(data.prompt_id) !== String(promptId)) return;

      switch (msg.type) {
        case 'execution_start':
          report(1, null);
          status('started');
          break;
        case 'executing':
          if (data.node) {
            if (handlers.onExecuting) {
              try { handlers.onExecuting(data.node); } catch (e) { /* ignore */ }
            }
            report(null, data.node);
          } else if (data.node === null) {
            /* older servers report the end of execution this way */
            wsDone = true;
          }
          break;
        case 'progress': {
          var max = Number(data.max) || 0;
          var value = Number(data.value) || 0;
          if (max > 0) {
            report(Math.max(1, Math.min(99, Math.round((value / max) * 100))), data.node);
          }
          break;
        }
        case 'execution_cached':
          status('cached');
          break;
        case 'status': {
          var info = data.status && data.status.exec_info;
          if (handlers.onQueued) {
            try { handlers.onQueued(info ? Number(info.queue_remaining) || 0 : 0); } catch (e) { /* ignore */ }
          }
          break;
        }
        case 'execution_error': {
          var err = new Error(data.exception_message || data.exception_type || 'ComfyUI execution error');
          err.details = data;
          err.nodeId = data.node_id;
          err.nodeType = data.node_type;
          finish(null, err);
          break;
        }
        case 'execution_success':
          /* history may lag one tick behind - the poll loop picks it up */
          wsDone = true;
          report(100, null);
          break;
        case 'execution_interrupted':
          finish(null, Object.assign(new Error('Cancelled.'), { cancelled: true, details: data }));
          break;
        default:
          break;
      }
    }

    /* Attach after creation so messages that arrived while /prompt was being
     * queued are replayed instead of lost. */
    socket.handler = handleWsPayload;
    var pending = socket.queue;
    socket.queue = [];
    pending.forEach(handleWsPayload);

    var deadline = Date.now() + (handlers.timeoutMs || 30 * 60 * 1000);
    while (!finished) {
      if (Date.now() > deadline) {
        finish(null, new Error('Timed out waiting for ComfyUI. Check the ComfyUI console.'));
        break;
      }
      if (handlers.shouldCancel && handlers.shouldCancel()) {
        try { await cancelPrompt(host, promptId); } catch (e) { /* ignore */ }
        finish(null, Object.assign(new Error('Cancelled.'), { cancelled: true }));
        break;
      }
      await sleep(wsDone ? 200 : 650);
      if (finished) break;

      try {
        var h = await history(host, promptId);
        var entry = h && h[promptId];
        if (entry) {
          var entryStatus = entry.status || {};
          if (entryStatus.status_str === 'error') {
            var message = 'ComfyUI execution failed.';
            (entryStatus.messages || []).forEach(function (m) {
              if (m && m[0] === 'execution_error' && m[1]) {
                message = m[1].exception_message || message;
                if (m[1].node_id) {
                  message += ' (node #' + m[1].node_id + ' ' + (m[1].node_type || '') + ')';
                }
              }
            });
            var historyError = new Error(message);
            historyError.details = entryStatus;
            finish(null, historyError);
          } else {
            var imgs = imagesOf(entry);
            if (imgs.length || entryStatus.completed) {
              finish({ entry: entry, images: imgs }, null);
            }
          }
        } else if (wsDone) {
          if (++pollsWithoutHistory > 25) finish({ entry: null, images: [] }, null);
        }
      } catch (e) {
        if (wsDone) {
          if (++pollsWithoutHistory > 25) finish({ entry: null, images: [] }, null);
        }
      }
    }

    closeSocket(socket);
    if (finished.error) throw finished.error;
    return finished.value;
  }

  /* Full run helper used by the panel and the CLI test harness. */
  async function runPrompt(host, prompt, clientId, handlers) {
    handlers = handlers || {};
    var socket = openSocket(host, clientId);
    /* Give the websocket a moment to connect before the prompt is queued so
     * the very first execution events are not missed. */
    try { await socket.ready; } catch (e) { /* polling still works */ }

    var queued;
    try {
      queued = await postJson(host, '/prompt', {
        prompt: prompt,
        client_id: clientId || randomId()
      });
    } catch (e) {
      closeSocket(socket);
      if (e && e.nodeErrors) {
        e.message = 'ComfyUI rejected the workflow:\n' + formatPromptError({ node_errors: e.nodeErrors });
      }
      throw e;
    }

    if (!queued || !queued.prompt_id) {
      closeSocket(socket);
      var err = new Error('ComfyUI did not return a prompt_id.');
      err.details = queued;
      throw err;
    }

    var waitHandlers = {};
    Object.keys(handlers).forEach(function (key) { waitHandlers[key] = handlers[key]; });
    waitHandlers.socket = socket;
    try {
      var res = await waitForPrompt(host, queued.prompt_id, clientId, waitHandlers);
      res.promptId = queued.prompt_id;
      res.number = queued.number;
      return res;
    } finally {
      closeSocket(socket);
    }
  }

  return {
    normalizeHost: normalizeHost,
    sleep: sleep,
    randomId: randomId,
    formatPromptError: formatPromptError,
    getJson: getJson,
    systemStats: systemStats,
    objectInfo: objectInfo,
    uploadImage: uploadImage,
    queuePrompt: queuePrompt,
    history: history,
    queueState: queueState,
    interrupt: interrupt,
    cancelPrompt: cancelPrompt,
    clearQueue: clearQueue,
    deleteQueueItems: deleteQueueItems,
    imagesOf: imagesOf,
    viewUrl: viewUrl,
    fetchImage: fetchImage,
    waitForPrompt: waitForPrompt,
    runPrompt: runPrompt
  };
});


