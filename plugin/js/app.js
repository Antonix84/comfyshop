/*
 * ComfyShop - Photoshop UXP panel.
 *
 * Plain DOM, no framework, no build step. The panel:
 *   - lists ComfyUI workflow JSON files from the connected server
 *   - shows every node whose title starts with "#" as an editable parameter
 *     (inside such a node only widgets marked with "#" are shown when the
 *     workflow uses widget marks)
 *   - shows one Send all / Send layer block with a preview per "#" image input
 *   - captures the active Photoshop document or layer on Send
 *   - runs the workflow 1/2/5 times and inserts each result as a new layer
 *   - connects on startup and keeps reconnecting after a connection loss
 */
(function (root, factory) {
  if (typeof document !== 'undefined' && root) { root.CSApp = factory(); return; }
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.CSApp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var root0 = typeof globalThis !== 'undefined' ? globalThis : window;
  var PS = root0.CSPhotoshop;
  var Comfy = root0.CSComfy;
  var Convert = root0.CSConvert;

  var fs = require('fs');
  var uxp = require('uxp');

  var DEFAULT_HOST = 'http://127.0.0.1:7861';
  var SETTINGS_KEY = 'comfyshop.settings.v4';
  var WORKFLOW_STATE_KEY = 'comfyshop.workflows.v4';

  /* Text fields (prompt etc.) used to stop at 256 characters. */
  var TEXT_MAX_LENGTH = 768;

  /* Connection watchdog: while connected check every 10 s, while offline
   * retry every 7 s. One small /system_stats request per tick is cheap. */
  var WATCH_INTERVAL_MS = 10000;
  var RECONNECT_INTERVAL_MS = 7000;

  /* view URL -> data URL, used only if UXP cannot render the remote image. */
  var previewCache = {};
  /* node id -> local data URL shown while an outgoing image is uploading. */
  var sourcePreviews = {};
  var docWatchTimer = null;

  var settings = {
    host: DEFAULT_HOST,
    lastWorkflow: ''
  };

  // key -> {values, randomSeeds, outputId}
  var workflowStates = {};
  /* Sent images are intentionally session-only: a fresh Photoshop start
   * shows empty source previews again. */
  var sessionSentImages = {};

  var state = {
    workflows: [],
    workflowName: '',
    workflow: null,
    objectInfo: null,
    objectInfoHost: '',
    model: null,
    outputId: null,
    values: {},
    randomSeeds: {},
    sentImages: {},
    connected: false,
    connecting: false,
    running: false,
    sending: false,
    cancelRequested: false,
    autoConnect: true,
    watchTimer: null,
    lastResult: null,
    panelRoot: null,
    batch: { total: 0, done: 0 },
    els: {}
  };

  /* ------------------------------------------------------------------ */
  /* logging                                                            */
  /* ------------------------------------------------------------------ */

  var debugLogPath = null;
  var debugBuffer = [];

  function findLogPath() {
    if (debugLogPath) return debugLogPath;
    try {
      var os = require('os');
      var base = os.tmpdir() + '\\Adobe\\UXP\\PluginsStorage\\PHSP';
      var versions = fs.readdirSync(base);
      for (var i = 0; i < versions.length; i++) {
        var dir = base + '\\' + versions[i] + '\\External\\com.comfyshop.panel\\PluginData';
        try {
          fs.readdirSync(dir);
          debugLogPath = dir + '\\comfyshop.log';
          return debugLogPath;
        } catch (e) { /* try next */ }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function flushDebugLog() {
    if (!debugLogPath) return;
    try { fs.writeFileSync(debugLogPath, debugBuffer.join('\n') + '\n'); } catch (e) { /* ignore */ }
  }

  function debugLog(message) {
    debugBuffer.push(new Date().toISOString() + ' ' + message);
    if (debugBuffer.length > 500) debugBuffer.shift();
    if (!debugLogPath) findLogPath();
    flushDebugLog();
  }

  async function initPaths() {
    try {
      var lfs = uxp.storage.localFileSystem;
      var folder = await lfs.getTemporaryFolder();
      if (folder && folder.nativePath) {
        debugLogPath = folder.nativePath + '\\comfyshop.log';
        flushDebugLog();
        debugLog('initPaths: ' + folder.nativePath);
        return folder.nativePath;
      }
    } catch (e) {
      debugLog('initPaths failed: ' + (e && (e.message || e)));
    }
    findLogPath();
    return debugLogPath;
  }

  /* ------------------------------------------------------------------ */
  /* persistence                                                        */
  /* ------------------------------------------------------------------ */

  var STORAGE = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  function loadSettings() {
    var saved = STORAGE.get(SETTINGS_KEY, null);
    if (saved) {
      for (var k in saved) {
        if (Object.prototype.hasOwnProperty.call(saved, k)) settings[k] = saved[k];
      }
    }
    workflowStates = STORAGE.get(WORKFLOW_STATE_KEY, {}) || {};
  }

  function saveSettings() {
    STORAGE.set(SETTINGS_KEY, settings);
  }

  function saveWorkflowState() {
    if (!state.workflowName) return;
    sessionSentImages[state.workflowName] = state.sentImages;
    workflowStates[state.workflowName] = {
      values: state.values,
      randomSeeds: state.randomSeeds,
      outputId: state.outputId
    };
    STORAGE.set(WORKFLOW_STATE_KEY, workflowStates);
  }

  function applyWorkflowState(name) {
    var s = workflowStates[name] || {};
    state.values = s.values || {};
    state.sentImages = sessionSentImages[name] || {};
    state.randomSeeds = s.randomSeeds || {};
    state.outputId = s.outputId || null;
  }

  /* Read the optional PluginData/settings.json written by a test or by hand. */
  function applyExternalConfig() {
    if (!debugLogPath) return;
    var file = debugLogPath.replace(/\\comfyshop\.log$/, '\\settings.json');
    try {
      var cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg.host) settings.host = String(cfg.host);
      if (cfg.workflow) settings.lastWorkflow = String(cfg.workflow);
      if (cfg.values && typeof cfg.values === 'object') {
        var wf = settings.lastWorkflow;
        if (wf) {
          workflowStates[wf] = workflowStates[wf] || {};
          workflowStates[wf].values = cfg.values;
        }
      }
      debugLog('external config: workflow=' + settings.lastWorkflow);
    } catch (e) {
      debugLog('external config skipped: ' + (e && (e.message || e)));
    }
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function append(parent, child) {
    if (child) parent.appendChild(child);
    return child;
  }

  function friendlyError(err) {
    if (!err) return 'Unknown error';
    var msg = err.message || String(err);
    if (err.details && err.details.node_errors) {
      try { msg += '\n' + JSON.stringify(err.details.node_errors, null, 2).slice(0, 2000); } catch (e) { /* ignore */ }
    }
    return msg;
  }

  function isNetworkError(err) {
    var msg = String((err && (err.message || err)) || '');
    return /failed to fetch|network error|econnrefused|econnreset|connection (lost|refused|closed)|websocket|not connected/i.test(msg);
  }

  function setDisabled(node, disabled) {
    if (!node) return;
    if (typeof node.setDisabled === 'function') node.setDisabled(disabled);
    else node.disabled = !!disabled;
  }

  /* Compact dropdown. Native <select> popups in UXP ignore the panel font
   * size and render huge, so the list is a small custom popup appended to
   * document.body (which also keeps it from being clipped by the panel). */
  var openDropdown = null;

  function createDropdown(opts) {
    opts = opts || {};
    var items = [];
    var value = opts.value;
    var disabled = false;
    var onChange = opts.onChange || function () { };

    var root = el('div', 'cs-dd');
    var btn = append(root, el('button', 'cs-dd-btn'));
    btn.type = 'button';
    var label = append(btn, el('span', 'cs-dd-label'));
    append(btn, el('span', 'cs-dd-caret', '\u25BE'));
    var menu = el('div', 'cs-dd-menu');
    menu.style.display = 'none';

    function normalize(option) {
      if (option && typeof option === 'object' && !Array.isArray(option)) {
        return { value: option.value, label: option.label === undefined ? option.value : option.label };
      }
      return { value: option, label: option };
    }

    function findItem(v) {
      for (var i = 0; i < items.length; i++) {
        if (String(items[i].value) === String(v)) return items[i];
      }
      return null;
    }

    function renderLabel() {
      var item = findItem(value);
      label.textContent = item ? String(item.label) : (value === undefined || value === null || value === '' ? '\u2014' : String(value));
      btn.title = label.textContent;
    }

    function renderMenu() {
      clear(menu);
      if (!items.length) {
        append(menu, el('div', 'cs-dd-empty', '(empty)'));
        return;
      }
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var item = append(menu, el('div', 'cs-dd-item', String(it.label)));
        item.title = String(it.label);
        if (String(it.value) === String(value)) item.classList.add('selected');
        (function (itemValue) {
          item.addEventListener('click', function (event) {
            event.stopPropagation();
            setValue(itemValue, true);
            close();
          });
        })(it.value);
      }
    }

    function positionMenu() {
      var r = btn.getBoundingClientRect();
      menu.style.left = Math.round(r.left) + 'px';
      menu.style.width = Math.max(80, Math.round(r.width)) + 'px';
      menu.style.top = Math.round(r.bottom + 2) + 'px';
      menu.style.display = 'block';
      var h = menu.offsetHeight || 0;
      if (r.bottom + h + 4 > window.innerHeight) {
        menu.style.top = Math.max(4, Math.round(r.top - h - 2)) + 'px';
      }
    }

    function onDocClick(event) {
      if (root.contains(event.target) || menu.contains(event.target)) return;
      close();
    }

    function open() {
      if (disabled) return;
      if (openDropdown && openDropdown !== api) openDropdown.close();
      renderMenu();
      if (!menu.parentNode) document.body.appendChild(menu);
      positionMenu();
      openDropdown = api;
      setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
    }

    function close() {
      menu.style.display = 'none';
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      document.removeEventListener('click', onDocClick, true);
      if (openDropdown === api) openDropdown = null;
    }

    function setValue(v, fire) {
      value = v;
      renderLabel();
      if (fire && onChange) onChange(v);
    }

    function setOptions(list) {
      items = [];
      var src = list || [];
      for (var i = 0; i < src.length; i++) items.push(normalize(src[i]));
      if (value !== undefined && value !== null && !findItem(value)) {
        items.unshift({ value: value, label: value });
      }
      renderMenu();
    }

    var api = {
      close: close
    };

    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      if (menu.style.display === 'block') close();
      else open();
    });

    root.getValue = function () { return value; };
    root.setValue = setValue;
    root.setOptions = setOptions;
    root.setDisabled = function (b) {
      disabled = !!b;
      btn.disabled = disabled;
      root.classList.toggle('disabled', disabled);
      if (disabled) close();
    };
    root.setOptions(opts.options || []);
    root.setValue(value, false);
    return root;
  }

  /* ------------------------------------------------------------------ */
  /* UI construction                                                    */
  /* ------------------------------------------------------------------ */

  function build() {
    var root = el('div');
    root.id = 'cs-root';

    var header = append(root, el('div', 'cs-header'));
    var logo = append(header, el('div', 'cs-logo'));
    logo.appendChild(document.createTextNode('Comfy'));
    append(logo, el('span', null, 'Shop'));
    var status = append(header, el('div', 'cs-status'));
    var dot = append(status, el('div', 'cs-dot'));
    var statusText = append(status, el('span', null, 'offline'));
    var settingsBtn = append(header, el('button', 'small', 'Settings'));
    settingsBtn.title = 'ComfyShop settings';

    var hostInput = el('input');
    hostInput.type = 'text';
    hostInput.value = settings.host;
    hostInput.placeholder = DEFAULT_HOST;
    hostInput.id = 'cs-settings-host';
    var connectBtn = el('button', 'small primary', 'Connect');
    var disconnectBtn = el('button', 'small', 'Disconnect');

    var settingsPanel = append(root, el('div', 'cs-settings'));
    settingsPanel.appendChild(buildSettings(hostInput, connectBtn, disconnectBtn));

    /* run controls: two buttons per row, x10 is gone */
    var runTop = append(root, el('div', 'cs-run-top'));
    var runRow1 = append(runTop, el('div', 'cs-run-row'));
    var stopBtn = append(runRow1, el('button', 'danger small', 'Stop'));
    stopBtn.disabled = true;
    var run1 = append(runRow1, el('button', 'primary', 'x1'));
    var runRow2 = append(runTop, el('div', 'cs-run-row'));
    var run2 = append(runRow2, el('button', 'primary', 'x2'));
    var run5 = append(runRow2, el('button', 'primary', 'x5'));

    var toolbar = append(root, el('div', 'cs-section'));

    /* workflow: label row, then a full-width dropdown */
    var wfHead = append(toolbar, el('div', 'cs-row wf-head'));
    append(wfHead, el('span', 'cs-label', 'Workflow'));
    var reloadBtn = append(wfHead, el('button', 'small', 'Reload'));
    reloadBtn.title = 'Reload the workflow and reset all parameters to its stored values';
    var wfRow = append(toolbar, el('div', 'cs-row'));
    var wfDropdown = append(wfRow, createDropdown({
      onChange: function (name) { selectWorkflow(name); }
    }));

    var docHint = append(toolbar, el('div', 'cs-hint'));

    /* body */
    var body = append(root, el('div', 'cs-body'));
    var sourcesHost = append(body, el('div', 'cs-sources'));
    var paramsHost = append(body, el('div', 'cs-params'));

    /* footer: progress + log only */
    var footer = append(root, el('div', 'cs-footer'));
    var progress = append(footer, el('div', 'cs-progress'));
    var progressFill = append(progress, el('div', 'cs-progress-fill'));
    var logBox = append(footer, el('div', 'cs-log'));

    state.els = {
      root: root,
      settingsPanel: settingsPanel,
      settingsBtn: settingsBtn,
      dot: dot,
      statusText: statusText,
      hostInput: hostInput,
      connectBtn: connectBtn,
      disconnectBtn: disconnectBtn,
      wfDropdown: wfDropdown,
      reloadBtn: reloadBtn,
      docHint: docHint,
      sourcesHost: sourcesHost,
      body: body,
      paramsHost: paramsHost,
      run1: run1,
      run2: run2,
      run5: run5,
      stopBtn: stopBtn,
      progressFill: progressFill,
      logBox: logBox
    };

    bindEvents();
    updateConnectionUI();
    return root;
  }

  function buildSettings(hostInput, connectBtn, disconnectBtn) {
    var wrap = el('div');

    var hostRow = append(wrap, el('div', 'cs-row'));
    append(hostRow, el('span', 'cs-label wide', 'Server'));
    append(hostRow, hostInput);

    var actions = append(wrap, el('div', 'cs-row cs-settings-actions'));
    append(actions, connectBtn);
    append(actions, disconnectBtn);

    var note = append(wrap, el('div', 'cs-hint'));
    note.textContent = 'Workflows are read from the ComfyUI server.';

    return wrap;
  }

  function bindEvents() {
    var e = state.els;

    e.settingsBtn.addEventListener('click', function () {
      e.settingsPanel.classList.toggle('visible');
    });

    e.connectBtn.addEventListener('click', function () { connect(); });
    e.disconnectBtn.addEventListener('click', function () { disconnect(); });
    e.reloadBtn.addEventListener('click', function () { resetWorkflow(); });

    e.run1.addEventListener('click', function () { generateBatch(1); });
    e.run2.addEventListener('click', function () { generateBatch(2); });
    e.run5.addEventListener('click', function () { generateBatch(5); });
    e.stopBtn.addEventListener('click', function () { stopRun(); });
  }

  /* ------------------------------------------------------------------ */
  /* logging / status                                                   */
  /* ------------------------------------------------------------------ */

  function log(message, kind) {
    var box = state.els.logBox;
    if (!box) return;
    var line = el('div', kind || null);
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    box.appendChild(line);
    while (box.childNodes.length > 100) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setStatus(text, kind) {
    if (state.els.statusText) state.els.statusText.textContent = text;
    if (state.els.dot) state.els.dot.className = 'cs-dot' + (kind ? ' ' + kind : '');
  }

  function setProgress(pct) {
    var fill = state.els.progressFill;
    if (!fill) return;
    fill.style.width = (pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct))) + '%';
  }

  function setRunning(running) {
    state.running = running;
    updateConnectionUI();
  }

  function updateConnectionUI() {
    var e = state.els;
    var offline = !state.connected;
    setDisabled(e.connectBtn, state.connected || state.connecting || state.running || state.sending);
    setDisabled(e.disconnectBtn, state.running || state.connecting || state.sending || (!state.connected && !state.autoConnect));
    setDisabled(e.hostInput, state.running || state.sending);
    setDisabled(e.wfDropdown, !state.connected || state.running || state.sending);
    setDisabled(e.reloadBtn, !state.connected || state.running || state.sending);
    setDisabled(e.run1, offline || state.running || state.sending || !state.model);
    setDisabled(e.run2, offline || state.running || state.sending || !state.model);
    setDisabled(e.run5, offline || state.running || state.sending || !state.model);
    setDisabled(e.stopBtn, !state.running);
    renderSourceBlocks();
  }

  /* ------------------------------------------------------------------ */
  /* workflows                                                          */
  /* ------------------------------------------------------------------ */

  /* Workflows live on the ComfyUI server, so the panel works with a remote
   * server and does not need a local folder setting. */
  async function listWorkflows() {
    var files = await Comfy.getJson(settings.host, '/userdata?dir=workflows');
    var out = [];
    for (var i = 0; i < (files || []).length; i++) {
      if (/\.json$/i.test(files[i])) out.push(String(files[i]));
    }
    out.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
    return out;
  }

  function pickDefaultWorkflow(files) {
    if (settings.lastWorkflow && files.indexOf(settings.lastWorkflow) >= 0) return settings.lastWorkflow;
    return files[0] || '';
  }

  async function resetWorkflow() {
    var name = state.workflowName || settings.lastWorkflow;
    if (name) {
      /* Reload means "forget my edits and use the values stored in the
       * workflow JSON again". Uploaded photo references are forgotten too. */
      delete workflowStates[name];
      delete sessionSentImages[name];
      STORAGE.set(WORKFLOW_STATE_KEY, workflowStates);
      state.values = {};
      state.randomSeeds = {};
      state.sentImages = {};
      state.outputId = null;
      log('Reloading "' + name + '" - parameters reset to workflow values.');
    }
    await refreshWorkflowList();
  }

  async function refreshWorkflowList() {
    try {
      if (!state.connected) {
        state.workflows = [];
        state.els.wfDropdown.setOptions([]);
        state.model = null;
        renderParams();
        updateConnectionUI();
        return;
      }
      state.workflows = await listWorkflows();
      debugLog('workflows: ' + state.workflows.length + ' last=' + settings.lastWorkflow);
      var dropdown = state.els.wfDropdown;
      dropdown.setOptions(state.workflows);
      var wanted = settings.lastWorkflow;
      if (!wanted || state.workflows.indexOf(wanted) < 0) wanted = pickDefaultWorkflow(state.workflows);
      if (wanted) {
        dropdown.setValue(wanted, false);
        await selectWorkflow(wanted, true);
      } else {
        state.model = null;
        renderParams();
      }
    } catch (e) {
      log(friendlyError(e), 'err');
      setStatus('workflow error', 'bad');
      state.model = null;
      renderParams();
    }
    updateDocHint();
  }

  async function selectWorkflow(name) {
    if (!name) return;
    if (state.workflowName) sessionSentImages[state.workflowName] = state.sentImages;
    state.workflowName = name;
    settings.lastWorkflow = name;
    saveSettings();
    applyWorkflowState(name);

    try {
      if (!state.connected) throw new Error('Connect to ComfyUI first.');
      var url = '/userdata/' + encodeURIComponent('workflows/' + name);
      state.workflow = await Comfy.getJson(settings.host, url);
    } catch (e) {
      log('Cannot load ' + name + ': ' + friendlyError(e), 'err');
      setStatus('load error', 'bad');
      state.model = null;
      renderParams();
      updateConnectionUI();
      return;
    }

    if (!state.connected) {
      state.model = null;
      renderParams();
      updateConnectionUI();
      return;
    }

    try {
      await ensureObjectInfo();
      state.model = Convert.buildModel(state.workflow, state.objectInfo);
      if (!state.outputId || !state.model.outputs.some(function (o) { return String(o.id) === String(state.outputId); })) {
        state.outputId = state.model.defaultOutputId;
      }
      renderParams();
      setStatus('ready', 'ok');
      log('Loaded ' + name + ' (' + state.model.nodeCount + ' nodes, ' + state.model.exposed.length + ' parameters)');
      (state.model.warnings || []).forEach(function (warning) { log(warning, 'warn'); });
      debugLog('selectWorkflow: ' + name + ' exposed=' + state.model.exposed.length +
        ' images=' + state.model.loadImages.length + ' outputs=' + state.model.outputs.length +
        ' errors=' + (state.model.errors || []).join('|'));
    } catch (e) {
      debugLog('selectWorkflow failed: ' + (e && (e.stack || e.message || e)));
      log('Cannot analyse workflow: ' + friendlyError(e), 'err');
      setStatus('workflow error', 'bad');
      state.model = null;
      renderParams();
    }
    updateConnectionUI();
    updateDocHint();
  }

  async function ensureObjectInfo() {
    var host = Comfy.normalizeHost(settings.host);
    if (state.objectInfo && state.objectInfoHost === host) return state.objectInfo;
    if (!state.connected) throw new Error('Connect to ComfyUI first.');
    setStatus('loading nodes', 'busy');
    var info = await Comfy.objectInfo(host);
    state.objectInfo = info;
    state.objectInfoHost = host;
    return info;
  }

  /* ------------------------------------------------------------------ */
  /* connection                                                         */
  /* ------------------------------------------------------------------ */

  async function connect(silent) {
    if (state.connected || state.connecting || state.running) return;
    state.connecting = true;
    state.autoConnect = true;
    updateConnectionUI();
    settings.host = (state.els.hostInput.value || '').trim() || DEFAULT_HOST;
    saveSettings();

    try {
      setStatus(silent ? 'reconnecting' : 'connecting', 'busy');
      debugLog('connect: ' + settings.host);
      var stats = await Comfy.systemStats(settings.host);
      var info = await Comfy.objectInfo(settings.host);
      state.objectInfo = info;
      state.objectInfoHost = Comfy.normalizeHost(settings.host);
      state.connected = true;
      var version = (stats.system && stats.system.comfyui_version) || '?';
      setStatus('connected ' + version, 'ok');
      log((silent ? 'Reconnected to ' : 'Connected to ') +
        Comfy.normalizeHost(settings.host) + ' (ComfyUI ' + version + ')');
      debugLog('connect ok version=' + version + ' nodes=' + Object.keys(info).length);
      try { state.els.settingsPanel.classList.remove('visible'); } catch (e) { /* ignore */ }
      await refreshWorkflowList();
    } catch (e) {
      state.connected = false;
      state.objectInfo = null;
      state.objectInfoHost = '';
      state.model = null;
      if (silent) {
        /* Automatic retries must not flood the log. */
        setStatus('reconnecting', 'busy');
        debugLog('connect retry failed: ' + (e && (e.stack || e.message || e)));
      } else {
        setStatus('offline', 'bad');
        log('Cannot reach ComfyUI: ' + friendlyError(e), 'err');
        debugLog('connect failed: ' + (e && (e.stack || e.message || e)));
      }
      renderParams();
    } finally {
      state.connecting = false;
      updateConnectionUI();
      updateDocHint();
      scheduleWatchdog(state.connected ? WATCH_INTERVAL_MS : RECONNECT_INTERVAL_MS);
    }
  }

  /* ------------------------------------------------------------------ */
  /* connection watchdog                                                */
  /* ------------------------------------------------------------------ */

  function stopWatchdog() {
    if (state.watchTimer) {
      clearTimeout(state.watchTimer);
      state.watchTimer = null;
    }
  }

  function scheduleWatchdog(delay) {
    stopWatchdog();
    if (!state.autoConnect) return;
    state.watchTimer = setTimeout(function () {
      state.watchTimer = null;
      watchdogTick();
    }, Math.max(1000, delay || WATCH_INTERVAL_MS));
  }

  function startWatchdog() {
    state.autoConnect = true;
    scheduleWatchdog(state.connected ? WATCH_INTERVAL_MS : RECONNECT_INTERVAL_MS);
  }

  async function watchdogTick() {
    if (!state.autoConnect) return;

    /* Do not fight a running generation; health check afterwards. */
    if (state.running) {
      scheduleWatchdog(WATCH_INTERVAL_MS);
      return;
    }

    if (!state.connected) {
      if (!state.connecting) await connect(true);
      scheduleWatchdog(state.connected ? WATCH_INTERVAL_MS : RECONNECT_INTERVAL_MS);
      return;
    }

    try {
      /* One tiny request per tick - negligible CPU load. */
      await Comfy.systemStats(settings.host);
      scheduleWatchdog(WATCH_INTERVAL_MS);
    } catch (e) {
      debugLog('watchdog: connection lost: ' + (e && (e.message || e)));
      markOffline();
      scheduleWatchdog(RECONNECT_INTERVAL_MS);
    }
  }

  function markOffline() {
    if (!state.connected) return;
    state.connected = false;
    state.objectInfo = null;
    state.objectInfoHost = '';
    state.model = null;
    setStatus('reconnecting', 'busy');
    log('Connection lost - retrying every ' + Math.round(RECONNECT_INTERVAL_MS / 1000) + 's.', 'warn');
    debugLog('connection lost');
    renderParams();
    updateConnectionUI();
    updateDocHint();
  }

  function disconnect() {
    if (state.connecting) return;
    state.autoConnect = false;
    stopWatchdog();
    state.connected = false;
    state.objectInfo = null;
    state.objectInfoHost = '';
    state.model = null;
    setStatus('offline', 'bad');
    log('Disconnected. Auto-reconnect is off until you press Connect.');
    debugLog('disconnect');
    renderParams();
    updateConnectionUI();
  }

  /* ------------------------------------------------------------------ */
  /* document hint                                                      */
  /* ------------------------------------------------------------------ */

  function updateDocHint() {
    var hint = state.els.docHint;
    if (!hint) return;
    var info = null;
    try { info = PS.documentInfoLight ? PS.documentInfoLight() : PS.documentInfo(); } catch (e) { info = null; }
    var text = info
      ? info.name + ' (' + info.width + 'x' + info.height + ')'
      : 'No open document - generation will not run.';
    var cls = info ? 'cs-hint' : 'cs-hint cs-error';
    if (hint.textContent !== text) hint.textContent = text;
    if (hint.className !== cls) hint.className = cls;
  }

  /* ------------------------------------------------------------------ */
  /* parameters                                                         */
  /* ------------------------------------------------------------------ */

  function renderParams() {
    var host = state.els.paramsHost;
    if (!host) return;
    clear(host);
    renderSourceBlocks();

    if (!state.connected) {
      append(host, el('div', 'cs-hint', state.autoConnect
        ? 'Not connected - trying to reconnect automatically...'
        : 'Not connected. Click Connect to load the workflow and its parameters.'));
      return;
    }
    if (!state.model) {
      append(host, el('div', 'cs-hint', 'Choose a workflow.'));
      return;
    }

    if (state.model.errors && state.model.errors.length) {
      var errCard = append(host, el('div', 'cs-card'));
      var errHead = append(errCard, el('div', 'cs-card-head'));
      append(errHead, el('div', 'cs-card-title', 'Workflow problem'));
      var errBody = append(errCard, el('div', 'cs-card-body'));
      state.model.errors.forEach(function (msg) { append(errBody, el('div', 'cs-error', msg)); });
    }

    var exposed = state.model.exposed || [];
    if (!exposed.length) {
      append(host, el('div', 'cs-hint',
        'No parameters: rename nodes in ComfyUI so their titles start with "#" to expose them here.'));
    }

    var renderedCards = 0;
    exposed.forEach(function (node) {
      /* LoadImage-only nodes are represented by their source block above. */
      var hasWidgets = (node.widgets || []).some(function (w) {
        return !(node.isLoadImage && w.name === 'image');
      });
      if (!hasWidgets) return;
      /* In strict mode only marked widgets are shown; skip empty cards. */
      if (node.strictMarks && (!node.widgets || !node.widgets.length)) return;
      host.appendChild(renderNodeCard(node));
      renderedCards++;
    });
    var anyParamWidgets = exposed.some(function (node) {
      return (node.widgets || []).some(function (w) {
        return !(node.isLoadImage && w.name === 'image');
      });
    });
    if (anyParamWidgets && !renderedCards) {
      append(host, el('div', 'cs-hint',
        'No parameters are marked with "#". Rename widget labels in ComfyUI, e.g. "#megapixels".'));
    }

    if (state.model.outputs && state.model.outputs.length > 1) {
      var outRow = append(host, el('div', 'cs-row'));
      append(outRow, el('span', 'cs-label', 'Result from'));
      var options = state.model.outputs.map(function (o) {
        return { value: String(o.id), label: (o.title || o.type) + ' (#' + o.id + ')' };
      });
      append(outRow, createDropdown({
        options: options,
        value: String(state.outputId),
        onChange: function (v) {
          state.outputId = v;
          saveWorkflowState();
        }
      }));
    }
  }

  function renderNodeCard(node) {
    var card = el('div', 'cs-card');
    var head = append(card, el('div', 'cs-card-head'));
    append(head, el('div', 'cs-card-title', node.title || ('Node ' + node.id)));
    append(head, el('div', 'cs-card-type', node.type));
    var body = append(card, el('div', 'cs-card-body'));

    var widgets = node.widgets || [];
    var rendered = 0;
    for (var i = 0; i < widgets.length; i++) {
      if (node.isLoadImage && widgets[i].name === 'image') continue;
      body.appendChild(renderWidget(node, widgets[i]));
      rendered++;
    }

    if (!rendered) append(body, el('div', 'cs-hint', 'This node has no editable parameters.'));
    return card;
  }

  function pickWidget(node, name) {
    var ws = node.widgets || [];
    for (var i = 0; i < ws.length; i++) if (ws[i].name === name) return ws[i].value;
    return undefined;
  }

  function valueKey(nodeId, name) { return String(nodeId) + '::' + name; }

  function getValue(nodeId, widget) {
    var key = valueKey(nodeId, widget.name);
    if (Object.prototype.hasOwnProperty.call(state.values, key)) return state.values[key];
    return widget.value;
  }

  function setValue(nodeId, widget, value) {
    state.values[valueKey(nodeId, widget.name)] = value;
    saveWorkflowState();
  }

  function seedRandomEnabled(nodeId, widget, force) {
    var key = String(nodeId);
    if (Object.prototype.hasOwnProperty.call(state.randomSeeds, key)) return !!state.randomSeeds[key];
    if (force) return true;
    return widget.seedControl === 'randomize';
  }

  function renderWidget(node, widget) {
    var wrap = el('div', 'cs-field');
    var head = append(wrap, el('div', 'cs-field-head'));
    var shownName = widget.displayName || widget.label || widget.name;
    var nameEl = append(head, el('div', 'cs-field-name', shownName));
    nameEl.title = widget.name;
    var value = getValue(node.id, widget);
    var kind = widget.kind;

    if (widget.isSeed) {
      wrap.className = 'cs-field cs-field-seed';
      var seedInput = append(wrap, el('input'));
      seedInput.type = 'text';
      seedInput.value = value === undefined ? '' : String(value);
      seedInput.addEventListener('change', function () { setValue(node.id, widget, seedInput.value); });

      var randomBtn = append(wrap, el('button', 'small random', 'R'));
      randomBtn.title = 'Randomize now';
      var eachWrap = append(wrap, el('label', 'cs-check'));
      var each = append(eachWrap, el('input'));
      each.type = 'checkbox';
      each.checked = seedRandomEnabled(node.id, widget);
      append(eachWrap, document.createTextNode('each'));

      randomBtn.addEventListener('click', function () {
        var seed = randomSeed();
        seedInput.value = String(seed);
        setValue(node.id, widget, seed);
      });
      each.addEventListener('change', function () {
        state.randomSeeds[String(node.id)] = each.checked;
        saveWorkflowState();
      });
      return wrap;
    }

    if (kind === 'combo') {
      append(wrap, createDropdown({
        options: widget.values || [],
        value: value,
        onChange: function (v) { setValue(node.id, widget, v); }
      }));
      return wrap;
    }

    if (kind === 'text') {
      wrap.className = 'cs-field cs-field-block';
      var ta = append(wrap, el('textarea'));
      ta.value = value === undefined ? '' : String(value);
      ta.rows = 8;
      limitTextInput(ta, ta.value.length);
      ta.addEventListener('change', function () { setValue(node.id, widget, ta.value); });
      return wrap;
    }

    if (kind === 'boolean') {
      var cb = append(wrap, el('input'));
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.addEventListener('change', function () { setValue(node.id, widget, cb.checked); });
      return wrap;
    }

    var input = append(wrap, el('input'));
    if (kind === 'int' || kind === 'float') {
      input.type = 'number';
      var opts = widget.options || {};
      input.step = kind === 'float' ? String(opts.step !== undefined ? opts.step : '0.01') : '1';
      if (opts.min !== undefined) input.min = String(opts.min);
      if (opts.max !== undefined) input.max = String(opts.max);
      input.value = value === undefined ? '' : String(value);
      input.addEventListener('change', function () {
        var v = input.value === '' ? undefined : Number(input.value);
        setValue(node.id, widget, v);
      });
    } else {
      input.type = 'text';
      input.value = value === undefined ? '' : String(value);
      limitTextInput(input, input.value.length);
      input.addEventListener('change', function () { setValue(node.id, widget, input.value); });
    }
    return wrap;
  }

  /* Raise the character limit and make sure UXP does not fall back to its
   * small default for prompt/text fields. Longer values that are already
   * stored in the workflow are preserved. */
  function limitTextInput(node, currentLength) {
    var limit = Math.max(TEXT_MAX_LENGTH, Number(currentLength) || 0);
    try { node.maxLength = limit; } catch (e) { /* ignore */ }
    try { node.setAttribute('maxlength', String(limit)); } catch (e) { /* ignore */ }
  }

  function imageMime(name) {
    if (/\.jpe?g$/i.test(String(name))) return 'image/jpeg';
    if (/\.webp$/i.test(String(name))) return 'image/webp';
    if (/\.gif$/i.test(String(name))) return 'image/gif';
    if (/\.bmp$/i.test(String(name))) return 'image/bmp';
    if (/\.tiff?$/i.test(String(name))) return 'image/tiff';
    return 'image/png';
  }

  function arrayBufferToDataUrl(arrayBuffer, mime) {
    var bytes = new Uint8Array(arrayBuffer);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:' + (mime || 'image/png') + ';base64,' + btoa(binary);
  }

  /* Some UXP builds refuse http(s) URLs in <img>. Fetch the thumbnail as a
   * data URL only when the direct URL failed. */
  async function loadPreviewFallback(imgEl, ref) {
    var url = Comfy.viewUrl(settings.host, ref);
    if (previewCache[url]) {
      imgEl.src = previewCache[url];
      return;
    }
    try {
      var buffer = await Comfy.fetchImage(settings.host, ref);
      var data = arrayBufferToDataUrl(buffer, imageMime(ref.filename));
      previewCache[url] = data;
      imgEl.src = data;
    } catch (e) {
      try { imgEl.style.visibility = 'hidden'; } catch (e2) { /* ignore */ }
    }
  }

  /* Which image inputs get their own Send block?
   * The first input always gets one. Additional inputs appear when their
   * node is marked with "#" (exposed) or the image widget itself is marked. */
  function sourceImages() {
    var imgs = (state.model && state.model.loadImages) || [];
    return imgs.filter(function (img, index) {
      if (index === 0) return true;
      if (img.exposed) return true;
      var marks = img.markedNames || [];
      return marks.indexOf('image') >= 0 || marks.indexOf('mask') >= 0;
    });
  }

  function sentImageRef(sent) {
    if (!sent || !sent.name) return null;
    return { filename: sent.name, subfolder: sent.subfolder || '', type: sent.type || 'input' };
  }

  function renderSourceBlocks() {
    var host = state.els.sourcesHost;
    if (!host) return;
    clear(host);
    if (!state.connected || !state.model) return;
    var imgs = sourceImages();
    if (!imgs.length) return;
    for (var i = 0; i < imgs.length; i++) {
      host.appendChild(renderSourceBlock(imgs[i], i + 1, imgs.length > 1));
    }
  }

  function renderSourceBlock(img, order, showOrder) {
    var id = String(img.id);
    var sent = state.sentImages[id];
    var card = el('div', 'cs-card cs-source-card');
    var head = append(card, el('div', 'cs-card-head'));
    var title = (showOrder ? 'Photo ' + order + ': ' : '') + (img.title || ('Load Image #' + img.id));
    append(head, el('div', 'cs-card-title', title));
    var body = append(card, el('div', 'cs-card-body'));

    var row = append(body, el('div', 'cs-run-row cs-send-row cs-source-actions'));
    var allBtn = append(row, el('button', 'small', 'Send all'));
    allBtn.title = 'Send the flattened active document';
    var layerBtn = append(row, el('button', 'small', 'Send layer'));
    layerBtn.title = 'Send the active layer';
    setDisabled(allBtn, state.running || state.connecting || state.sending);
    setDisabled(layerBtn, state.running || state.connecting || state.sending);
    if (sent && sent.kind === 'document') allBtn.classList.add('active');
    if (sent && sent.kind === 'layer') layerBtn.classList.add('active');
    allBtn.addEventListener('click', function () { sendImageSource(img, 'document'); });
    layerBtn.addEventListener('click', function () { sendImageSource(img, 'layer'); });

    var preview = append(body, el('div', 'cs-source-preview'));
    var previewImg = append(preview, el('img'));
    var caption = append(body, el('div', 'cs-hint'));
    var pending = sourcePreviews[id];
    if (pending) {
      previewImg.style.visibility = 'visible';
      previewImg.src = pending;
      caption.textContent = 'Sending...';
      return card;
    }
    var ref = sentImageRef(sent);
    if (ref) {
      previewImg.onload = function () { previewImg.style.visibility = 'visible'; };
      previewImg.onerror = function () {
        previewImg.onerror = null;
        previewImg.style.visibility = 'hidden';
        loadPreviewFallback(previewImg, ref);
      };
      previewImg.style.visibility = 'hidden';
      previewImg.src = Comfy.viewUrl(settings.host, ref);
      caption.textContent = 'Sent: ' + sent.kind +
        (sent.width && sent.height ? ' (' + sent.width + 'x' + sent.height + ')' : '');
    } else {
      preview.style.display = 'none';
      caption.textContent = 'Nothing sent yet. The active document is sent automatically on the next run, or press Send all / Send layer now.';
    }
    return card;
  }

  async function sendImageSource(img, kind) {
    if (state.running || state.connecting || state.sending) return false;
    if (!state.connected) {
      log('Connect to ComfyUI first.', 'err');
      setStatus('error', 'bad');
      return false;
    }
    return await uploadSourceImage(img, kind);
  }

  /* Capture and upload one image input. The caller has already checked the
   * panel state; returns true when the upload succeeded. */
  async function uploadSourceImage(img, kind) {
    state.sending = true;
    updateConnectionUI();
    var id = String(img.id);
    var title = img.title || ('Image #' + img.id);
    var exportResult = null;
    var uploadedOk = false;
    try {
      setStatus('exporting ' + kind, 'busy');
      log('Sending ' + kind + ' as "' + title + '"...');
      exportResult = await PS.exportSource(kind);
      var bytes = await PS.readEntryBytes(exportResult.entry);
      try {
        sourcePreviews[id] = arrayBufferToDataUrl(bytes, 'image/png');
        renderSourceBlocks();
      } catch (e) { /* preview is optional */ }
      var uploadName = 'comfyshop_src_' + id + '_' + Date.now() + '.png';
      var uploaded = await Comfy.uploadImage(settings.host, bytes, uploadName, { overwrite: true });
      state.sentImages[id] = {
        name: uploaded.name,
        subfolder: uploaded.subfolder || '',
        type: uploaded.type || 'input',
        kind: kind,
        origin: exportResult.origin || { x: 0, y: 0 },
        width: exportResult.width || exportResult.docWidth || 0,
        height: exportResult.height || exportResult.docHeight || 0,
        docWidth: exportResult.docWidth || 0,
        docHeight: exportResult.docHeight || 0,
        sentAt: Date.now()
      };
      saveWorkflowState();
      setStatus('ready', 'ok');
      log('Sent ' + kind + ' for "' + title + '".', 'ok');
      uploadedOk = true;
    } catch (e) {
      log('Send failed: ' + friendlyError(e), 'err');
      setStatus('error', 'bad');
    } finally {
      state.sending = false;
      delete sourcePreviews[id];
      if (exportResult && exportResult.entry) {
        try { await PS.deleteEntry(exportResult.entry); } catch (e) { /* ignore */ }
      }
      updateConnectionUI();
    }
    return uploadedOk;
  }

  function randomSeed() { return Math.floor(Math.random() * 0x7fffffff); }

  /* Nodes whose seed the user pinned by clearing the "each" checkbox: batch
   * runs keep that seed exactly as entered. */
  function pinnedSeedNodes() {
    var out = [];
    var map = state.randomSeeds || {};
    Object.keys(map).forEach(function (id) {
      if (!map[id]) out.push(String(id));
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* generation                                                         */
  /* ------------------------------------------------------------------ */

  function collectOverrides(model, forceRandomSeeds) {
    var overrides = {};

    function put(nodeId, name, value) {
      var id = String(nodeId);
      overrides[id] = overrides[id] || {};
      overrides[id][name] = value;
    }

    model.exposed.forEach(function (node) {
      node.widgets.forEach(function (widget) {
        if (widget.name === 'image' && node.isLoadImage) return;
        var raw = getValue(node.id, widget);
        if (raw === undefined) return;
        if (widget.isSeed && seedRandomEnabled(node.id, widget, forceRandomSeeds)) raw = randomSeed();
        if (widget.kind === 'int') put(node.id, widget.name, Math.round(Number(raw)));
        else if (widget.kind === 'float') put(node.id, widget.name, Number(raw));
        else if (widget.kind === 'boolean') put(node.id, widget.name, !!raw);
        else put(node.id, widget.name, raw);
      });
    });

    model.loadImages.forEach(function (img) {
      var sent = state.sentImages[String(img.id)];
      if (sent && sent.name) {
        put(img.id, 'image', sent.subfolder ? (sent.subfolder + '/' + sent.name) : sent.name);
      }
    });

    return overrides;
  }

  function chooseOutputImages(images, outputId) {
    if (!images || !images.length) return [];
    var filtered = images.filter(function (img) { return String(img.nodeId) === String(outputId); });
    if (filtered.length) images = filtered;
    /* gifs/videos can be reported by custom save nodes; Photoshop can only
     * insert still images, so prefer those when both are returned. */
    var still = images.filter(function (img) {
      return img.key === 'images' || !img.key || /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(String(img.filename));
    });
    return still.length ? still : images;
  }

  function pngSize(arrayBuffer) {
    try {
      var b = new Uint8Array(arrayBuffer);
      if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
        return {
          width: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0,
          height: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0
        };
      }
    } catch (e) { /* ignore */ }
    return { width: 0, height: 0 };
  }

  function firstSentMeta() {
    var images = (state.model && state.model.loadImages) || [];
    if (!images.length) return null;
    return state.sentImages[String(images[0].id)] || null;
  }

  async function runOne(index, total) {
    var runStarted = Date.now();
    var host = Comfy.normalizeHost(settings.host);
    var overrides = collectOverrides(state.model, total > 1);

    var built = Convert.buildPrompt(state.workflow, state.objectInfo, overrides, {
      outputIds: state.outputId ? [state.outputId] : null,
      /* x2 / x5 must not repeat the same picture: every seed in the prompt is
       * re-rolled per run, including samplers that are not "#" nodes. */
      varySeeds: total > 1 ? randomSeed : null,
      pinnedSeedNodes: total > 1 ? pinnedSeedNodes() : null
    });
    if (built.errors.length) throw new Error(built.errors.join('\n'));
    (built.warnings || []).forEach(function (warning) { log(warning, 'warn'); });

    setStatus('queued ' + (index + 1) + '/' + total, 'busy');
    log('Queueing prompt ' + (index + 1) + '/' + total + ' (' + Object.keys(built.prompt).length + ' nodes)...');

    var result = await Comfy.runPrompt(host, built.prompt, Comfy.randomId(), {
      timeoutMs: 30 * 60 * 1000,
      shouldCancel: function () { return state.cancelRequested; },
      onProgress: function (pct) {
        if (pct !== null && pct !== undefined) {
          setProgress(((index + pct / 100) / total) * 100);
        }
      },
      onExecuting: function (node) {
        if (!state.cancelRequested) setStatus('node ' + node + ' (' + (index + 1) + '/' + total + ')', 'busy');
      }
    });

    if (state.cancelRequested) return null;

    var images = chooseOutputImages(result.images, state.outputId);
    if (!images.length) throw new Error('ComfyUI finished but returned no images.');
    debugLog('result images: ' + images.map(function (i) { return i.nodeId + ':' + i.filename; }).join(', '));

    var baseName = String(state.workflowName || 'ComfyShop').replace(/\.json$/i, '');
    if (total > 1) baseName += ' ' + (index + 1);

    var seconds = ((Date.now() - runStarted) / 1000).toFixed(1);
    var time = new Date().toLocaleTimeString().replace(/:/g, '-');
    var runName = baseName + ' ' + time + ' ' + seconds + 's';
    var meta = firstSentMeta();
    var origin = meta && meta.origin ? meta.origin : { x: 0, y: 0 };
    var targetWidth = meta && meta.width ? meta.width : (meta ? meta.docWidth : 0);
    var targetHeight = meta && meta.height ? meta.height : (meta ? meta.docHeight : 0);

    var lastInserted = null;

    for (var n = 0; n < images.length; n++) {
      var image = images[n];
      log('Downloading ' + image.filename + '...');
      var arrayBuffer = await Comfy.fetchImage(host, image);
      var size = pngSize(arrayBuffer);
      debugLog('inserting ' + image.filename + ' ' + size.width + 'x' + size.height);

      setStatus('inserting layer ' + (index + 1) + '/' + total +
        (images.length > 1 ? ' (' + (n + 1) + '/' + images.length + ')' : ''), 'busy');

      var temp = await PS.getTempFile('comfyshop_result_' + Date.now() + '_' + n + '.png');
      try {
        await PS.writeEntryBytes(temp, arrayBuffer);
        lastInserted = await PS.insertFile(temp, {
          name: runName + (images.length > 1 ? ' ' + (n + 1) : ''),
          origin: origin,
          width: targetWidth || size.width,
          height: targetHeight || size.height
        });
      } finally {
        try { await PS.deleteEntry(temp); } catch (e) { /* ignore */ }
      }

      debugLog('inserted layer ' + lastInserted.layerId + ' "' + lastInserted.layerName +
        '" bounds=' + JSON.stringify(lastInserted.bounds));
      state.lastResult = { layerName: lastInserted.layerName, image: image, index: index + 1 };
      log('Inserted layer "' + lastInserted.layerName + '".', 'ok');
    }

    return lastInserted;
  }

  async function generateBatch(count) {
    if (state.running) return null;
    if (state.sending) { log('Wait for the image to finish sending.', 'err'); return null; }
    if (!state.connected) { log('Connect to ComfyUI first.', 'err'); return null; }
    if (!state.model || !state.workflow) { log('No workflow selected.', 'err'); return null; }
    var docInfo = PS.documentInfoLight ? PS.documentInfoLight() : PS.documentInfo();
    if (!docInfo) {
      log('Open a document in Photoshop first.', 'err');
      setStatus('error', 'bad');
      return null;
    }
    if (state.model.errors && state.model.errors.length) {
      log(friendlyError(new Error(state.model.errors[0])), 'err');
      return null;
    }

    setRunning(true);
    state.cancelRequested = false;
    state.batch = { total: count, done: 0 };
    setProgress(0);
    var started = Date.now();
    debugLog('generateBatch start count=' + count + ' workflow=' + state.workflowName);

    try {
      await ensureObjectInfo();
      state.model = Convert.buildModel(state.workflow, state.objectInfo);
      if (state.model.errors && state.model.errors.length) throw new Error(state.model.errors[0]);

      /* Fresh start: an image input that was never sent would silently use the
       * picture stored in the workflow. Capture the active document instead
       * ("Send all"), and stop with a red status if that is impossible.
       * Partly sent workflows keep the manual choice and only warn. */
      var imgs = sourceImages();
      var unsent = imgs.filter(function (img) {
        return !state.sentImages[String(img.id)];
      });
      if (imgs.length && unsent.length === imgs.length) {
        log('Nothing sent yet - sending the active document automatically...');
        for (var u = 0; u < unsent.length; u++) {
          var sentOk = await uploadSourceImage(unsent[u], 'document');
          if (!sentOk) {
            setStatus('error', 'bad');
            setProgress(0);
            log('Generation cancelled: send the image manually and try again.', 'err');
            return null;
          }
        }
      } else {
        unsent.forEach(function (img) {
          log('Image "' + (img.title || ('#' + img.id)) + '" was not sent - using the workflow image.', 'warn');
        });
      }

      for (var i = 0; i < count; i++) {
        if (state.cancelRequested) break;
        await runOne(i, count);
        if (state.cancelRequested) break;
        state.batch.done = i + 1;
        setProgress(((i + 1) / count) * 100);
      }

      var seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (state.cancelRequested && state.batch.done < count) {
        setStatus('stopped', 'bad');
        log('Stopped after ' + state.batch.done + ' of ' + count + ' image(s).', 'err');
      } else {
        setProgress(100);
        setStatus('done', 'ok');
        log('Generated ' + state.batch.done + '/' + count + ' image(s) in ' + seconds + 's.', 'ok');
      }
      saveWorkflowState();
      updateDocHint();
      debugLog('generateBatch: done ' + state.batch.done + '/' + count + ' in ' + seconds + 's');
      return state.batch.done;
    } catch (err) {
      if (state.cancelRequested) {
        setStatus('stopped', 'bad');
        log('Stopped.', 'err');
      } else {
        debugLog('generateBatch failed: ' + (err && (err.stack || err.message || err)));
        setStatus('error', 'bad');
        log(friendlyError(err), 'err');
        if (isNetworkError(err)) markOffline();
      }
      return null;
    } finally {
      setRunning(false);
      updateDocHint();
    }
  }

  async function stopRun() {
    if (!state.running) return;
    state.cancelRequested = true;
    setStatus('cancelling', 'busy');
    log('Cancelling...');
    try { await Comfy.interrupt(settings.host); } catch (e) { log('Cancel failed: ' + friendlyError(e), 'err'); }
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */

  var initialized = false;

  function mount() {
    if (state.panelRoot) return state.panelRoot;
    debugLog('mount: start');
    loadSettings();
    var root = build();
    state.panelRoot = root;
    state.els.hostInput.value = settings.host;
    if (!docWatchTimer) {
      docWatchTimer = setInterval(updateDocHint, 1500);
    }
    if (!initialized) {
      initialized = true;
      setTimeout(function () {
        initPaths()
          .then(function () {
            applyExternalConfig();
            state.els.hostInput.value = settings.host;
            /* Auto-connect on startup with the saved server address. */
            return state.connected ? refreshWorkflowList() : connect();
          })
          .then(function () {
            startWatchdog();
            updateDocHint();
          })
          .catch(function (e) {
            debugLog('init failed: ' + (e && (e.stack || e.message || e)));
            log(friendlyError(e), 'err');
          });
      }, 50);
    }
    return root;
  }

  function ensureMounted() {
    if (!state.panelRoot) {
      mount();
      try {
        if (state.panelRoot && !state.panelRoot.parentNode) document.body.appendChild(state.panelRoot);
      } catch (e) { /* ignore */ }
    }
    return state.panelRoot;
  }

  function show(event) {
    var root = ensureMounted();
    var container = null;
    if (event && event.appendChild) container = event;
    else if (event && event.node && event.node.appendChild) container = event.node;
    if (container && root.parentNode !== container) container.appendChild(root);
    updateDocHint();
    return root;
  }

  function hide() { /* nothing to tear down */ }

  function showAlertSafe(message) {
    try {
      if (PS && PS.app && typeof PS.app.showAlert === 'function') {
        PS.app.showAlert({ message: String(message) }).catch(function () { });
        return;
      }
    } catch (e) { /* fall through */ }
    try { alert(message); } catch (e) { /* ignore */ }
  }

  function commandGenerate() {
    (async function () {
      try {
        ensureMounted();
        loadSettings();
        if (!state.connected) await connect();
        if (!state.model && settings.lastWorkflow) await selectWorkflow(settings.lastWorkflow);
        var done = await generateBatch(1);
        if (done) showAlertSafe('ComfyShop: generated ' + done + ' layer(s).');
      } catch (e) {
        showAlertSafe('ComfyShop error:\n' + friendlyError(e));
      }
    })();
  }

  function commandSelfTest() {
    (async function () {
      try {
        ensureMounted();
        var report = await PS.selfTest();
        showAlertSafe('ComfyShop self test OK:\n' + JSON.stringify(report, null, 2));
      } catch (e) {
        showAlertSafe('ComfyShop self test failed:\n' + friendlyError(e));
      }
    })();
  }

  return {
    mount: mount,
    show: show,
    hide: hide,
    commandGenerate: commandGenerate,
    commandSelfTest: commandSelfTest,
    _state: state
  };
});
