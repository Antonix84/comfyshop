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

  async function readError(res) {
    var text = '';
    try { text = await res.text(); } catch (e) { /* ignore */ }
    var detail = text;
    try {
      var json = JSON.parse(text);
      if (json && json.error) {
        detail = (json.error.message || json.error.type || '') + ' ' + text;
      }
    } catch (e) { /* not json */ }
    return new Error('ComfyUI HTTP ' + res.status + (detail ? ': ' + String(detail).slice(0, 600) : ''));
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
    if (!res.ok) throw await readError(res);
    return res.json();
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

  async function deleteQueueItems(host) {
    return postJson(host, '/queue', { clear: true });
  }

  function imagesOf(historyEntry) {
    var images = [];
    if (!historyEntry || !historyEntry.outputs) return images;
    var outputs = historyEntry.outputs;
    Object.keys(outputs).forEach(function (nodeId) {
      var out = outputs[nodeId];
      if (out && Array.isArray(out.images)) {
        out.images.forEach(function (img) {
          images.push({ nodeId: nodeId, filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output', animated: !!img.animated });
        });
      }
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
   * handlers: { onProgress(percent, nodeId), onExecuting(nodeId), onStatus(text) }
   */
  async function waitForPrompt(host, promptId, clientId, handlers) {
    handlers = handlers || {};
    var finished = null;
    var progress = {};
    var ws = null;
    var wsDone = false;
    var wsPollsAfterDone = 0;

    function report(pct, node) {
      if (handlers.onProgress) {
        try { handlers.onProgress(pct, node); } catch (e) { /* ignore */ }
      }
    }

    function finish(value, error) {
      if (finished) return;
      finished = { value: value, error: error };
    }

    if (typeof WebSocket !== 'undefined') {
      try {
        ws = new WebSocket(wsUrl(host) + '/ws?clientId=' + encodeURIComponent(clientId || 'comfyshop'));
        ws.onmessage = function (event) {
          var msg;
          try { msg = JSON.parse(event.data); } catch (e) { return; }
          var data = msg.data || {};
          if (data.prompt_id && promptId && data.prompt_id !== promptId) return;

          if (msg.type === 'execution_start') {
            report(1, null);
            if (handlers.onStatus) handlers.onStatus('started');
          } else if (msg.type === 'executing') {
            if (data.node) {
              if (handlers.onExecuting) handlers.onExecuting(data.node);
              report(null, data.node);
            } else if (data.node === null) {
              // execution finished (older servers signal this way)
            }
          } else if (msg.type === 'progress') {
            var max = data.max || 0;
            var value = data.value || 0;
            if (max > 0) {
              var pct = Math.max(1, Math.min(99, Math.round((value / max) * 100)));
              report(pct, data.node);
            }
          } else if (msg.type === 'executed') {
            if (data.node) {
              progress[data.node] = true;
            }
          } else if (msg.type === 'execution_error') {
            var err = new Error(data.exception_message || data.exception_type || 'ComfyUI execution error');
            err.details = data;
            finish(null, err);
          } else if (msg.type === 'execution_success') {
            // History may not be written yet - the polling loop below picks
            // up the actual outputs.
            wsDone = true;
            report(100, null);
          }
        };
        ws.onerror = function () { /* polling fallback will handle it */ };
      } catch (e) {
        ws = null;
      }
    }

    var deadline = Date.now() + (handlers.timeoutMs || 30 * 60 * 1000);
    var lastStatus = null;
    var pollsWithoutHistory = 0;
    while (!finished) {
      if (Date.now() > deadline) {
        finish(null, new Error('Timed out waiting for ComfyUI result.'));
        break;
      }
      await sleep(wsDone ? 250 : 700);

      if (!finished) {
        try {
          var h = await history(host, promptId);
          if (h && h[promptId]) {
            var entry = h[promptId];
            if (entry.status && entry.status.status_str === 'error') {
              var msg = 'ComfyUI execution failed.';
              var messages = entry.status.messages || [];
              for (var i = 0; i < messages.length; i++) {
                if (messages[i][0] === 'execution_error' && messages[i][1]) {
                  msg = messages[i][1].exception_message || msg;
                }
              }
              var error = new Error(msg);
              error.details = entry.status;
              finish(null, error);
            } else {
              var imgs = imagesOf(entry);
              if (imgs.length || (entry.status && entry.status.completed)) {
                finish({ entry: entry, images: imgs }, null);
              }
            }
          } else if (wsDone) {
            pollsWithoutHistory++;
            if (pollsWithoutHistory > 20) {
              finish({ entry: null, images: [] }, null);
            }
          }
        } catch (e) {
          lastStatus = e.message;
          if (wsDone) {
            pollsWithoutHistory++;
            if (pollsWithoutHistory > 20) finish({ entry: null, images: [] }, null);
          }
        }
      }
    }

    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
      ws = null;
    }

    if (finished.error) throw finished.error;
    return finished.value;
  }

  /* Full run helper used by the panel and the CLI test harness. */
  async function runPrompt(host, prompt, clientId, handlers) {
    handlers = handlers || {};
    var queued = await queuePrompt(host, prompt, clientId);
    if (!queued || !queued.prompt_id) {
      var err = new Error('ComfyUI did not return a prompt_id.');
      err.details = queued;
      throw err;
    }
    var res = await waitForPrompt(host, queued.prompt_id, clientId, handlers);
    res.promptId = queued.prompt_id;
    res.number = queued.number;
    return res;
  }

  return {
    normalizeHost: normalizeHost,
    sleep: sleep,
    randomId: randomId,
    getJson: getJson,
    systemStats: systemStats,
    objectInfo: objectInfo,
    uploadImage: uploadImage,
    queuePrompt: queuePrompt,
    history: history,
    queueState: queueState,
    interrupt: interrupt,
    deleteQueueItems: deleteQueueItems,
    imagesOf: imagesOf,
    viewUrl: viewUrl,
    fetchImage: fetchImage,
    waitForPrompt: waitForPrompt,
    runPrompt: runPrompt
  };
});


