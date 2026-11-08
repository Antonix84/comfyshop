/*
 * ComfyShop - Photoshop UXP panel.
 *
 * Plain DOM, no framework, no build step. The panel:
 *   - lists ComfyUI workflow JSON files from F:\AI\ComfyUI\workflows
 *   - shows every node whose title starts with "#" as an editable parameter
 *   - uploads the current Photoshop document (or layer/selection) to ComfyUI
 *   - runs the workflow 1/2/5/10 times and inserts each result as a new layer
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

  var settings = {
    host: DEFAULT_HOST,
    sourceKind: 'document',
    lastWorkflow: ''
  };

  // key -> {values, usePs, randomSeeds, outputId}
  var workflowStates = {};

  var state = {
    workflows: [],
    workflowName: '',
    workflow: null,
    objectInfo: null,
    objectInfoHost: '',
    model: null,
    outputId: null,
    values: {},
    usePs: {},
    randomSeeds: {},
    connected: false,
    connecting: false,
    running: false,
    cancelRequested: false,
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
    workflowStates[state.workflowName] = {
      values: state.values,
      usePs: state.usePs,
      randomSeeds: state.randomSeeds,
      outputId: state.outputId
    };
    STORAGE.set(WORKFLOW_STATE_KEY, workflowStates);
  }

  function applyWorkflowState(name) {
    var s = workflowStates[name] || {};
    state.values = s.values || {};
    state.usePs = s.usePs || {};
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
      if (cfg.sourceKind) settings.sourceKind = String(cfg.sourceKind);
      if (cfg.workflow) settings.lastWorkflow = String(cfg.workflow);
      if (cfg.values && typeof cfg.values === 'object') {
        var wf = settings.lastWorkflow;
        if (wf) {
          workflowStates[wf] = workflowStates[wf] || {};
          workflowStates[wf].values = cfg.values;
        }
      }
      if (cfg.usePs && typeof cfg.usePs === 'object') {
        var wf2 = settings.lastWorkflow;
        if (wf2) {
          workflowStates[wf2] = workflowStates[wf2] || {};
          workflowStates[wf2].usePs = cfg.usePs;
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

    /* run controls: Stop on the left, then x1/x2/x5/x10 */
    var runRow = append(root, el('div', 'cs-run-row cs-run-top'));
    var stopBtn = append(runRow, el('button', 'danger small', 'Stop'));
    stopBtn.disabled = true;
    var run1 = append(runRow, el('button', 'primary', 'x1'));
    var run2 = append(runRow, el('button', 'primary', 'x2'));
    var run5 = append(runRow, el('button', 'primary', 'x5'));
    var run10 = append(runRow, el('button', 'primary', 'x10'));

    var toolbar = append(root, el('div', 'cs-section'));

    /* workflow: label row, then a full-width dropdown */
    var wfHead = append(toolbar, el('div', 'cs-row wf-head'));
    append(wfHead, el('span', 'cs-label', 'Workflow'));
    var reloadBtn = append(wfHead, el('button', 'small', 'Reload'));
    var wfRow = append(toolbar, el('div', 'cs-row'));
    var wfDropdown = append(wfRow, createDropdown({
      onChange: function (name) { selectWorkflow(name); }
    }));

    /* source */
    var srcRow = append(toolbar, el('div', 'cs-row'));
    append(srcRow, el('span', 'cs-label', 'Send'));
    var srcDropdown = append(srcRow, createDropdown({
      options: [
        { value: 'document', label: 'Document (flattened)' },
        { value: 'layer', label: 'Active layer' },
        { value: 'selection', label: 'Selection area' }
      ],
      value: settings.sourceKind,
      onChange: function (kind) {
        settings.sourceKind = kind;
        saveSettings();
        updateDocHint();
      }
    }));
    var docHint = append(toolbar, el('div', 'cs-hint'));

    /* body */
    var body = append(root, el('div', 'cs-body'));
    var preview = append(body, el('div', 'cs-preview'));
    var previewImg = append(preview, el('img'));
    var previewCaption = append(preview, el('div', 'cs-preview-caption'));
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
      srcDropdown: srcDropdown,
      docHint: docHint,
      body: body,
      preview: preview,
      previewImg: previewImg,
      previewCaption: previewCaption,
      paramsHost: paramsHost,
      run1: run1,
      run2: run2,
      run5: run5,
      run10: run10,
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
    e.reloadBtn.addEventListener('click', function () { refreshWorkflowList(); });

    e.run1.addEventListener('click', function () { generateBatch(1); });
    e.run2.addEventListener('click', function () { generateBatch(2); });
    e.run5.addEventListener('click', function () { generateBatch(5); });
    e.run10.addEventListener('click', function () { generateBatch(10); });
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
    setDisabled(e.connectBtn, state.connected || state.connecting || state.running);
    setDisabled(e.disconnectBtn, !state.connected || state.running);
    setDisabled(e.hostInput, state.running);
    setDisabled(e.wfDropdown, !state.connected || state.running);
    setDisabled(e.reloadBtn, !state.connected || state.running);
    setDisabled(e.srcDropdown, state.running);
    setDisabled(e.run1, offline || state.running || !state.model);
    setDisabled(e.run2, offline || state.running || !state.model);
    setDisabled(e.run5, offline || state.running || !state.model);
    setDisabled(e.run10, offline || state.running || !state.model);
    setDisabled(e.stopBtn, !state.running);
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
      initImageFlags();
      renderParams();
      setStatus('ready', 'ok');
      log('Loaded ' + name + ' (' + state.model.nodeCount + ' nodes, ' + state.model.exposed.length + ' parameters)');
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

  function initImageFlags() {
    var imgs = state.model.loadImages || [];
    for (var i = 0; i < imgs.length; i++) {
      var id = String(imgs[i].id);
      if (!Object.prototype.hasOwnProperty.call(state.usePs, id)) {
        state.usePs[id] = imgs.length === 1 ? true : i === 0;
      }
    }
    saveWorkflowState();
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

  async function connect() {
    if (state.connected || state.connecting || state.running) return;
    state.connecting = true;
    updateConnectionUI();
    settings.host = (state.els.hostInput.value || '').trim() || DEFAULT_HOST;
    saveSettings();

    try {
      setStatus('connecting', 'busy');
      debugLog('connect: ' + settings.host);
      var stats = await Comfy.systemStats(settings.host);
      var info = await Comfy.objectInfo(settings.host);
      state.objectInfo = info;
      state.objectInfoHost = Comfy.normalizeHost(settings.host);
      state.connected = true;
      var version = (stats.system && stats.system.comfyui_version) || '?';
      setStatus('connected ' + version, 'ok');
      log('Connected to ' + Comfy.normalizeHost(settings.host) + ' (ComfyUI ' + version + ')');
      debugLog('connect ok version=' + version + ' nodes=' + Object.keys(info).length);
      try { state.els.settingsPanel.classList.remove('visible'); } catch (e) { /* ignore */ }
      await refreshWorkflowList();
    } catch (e) {
      state.connected = false;
      state.objectInfo = null;
      state.objectInfoHost = '';
      state.model = null;
      setStatus('offline', 'bad');
      log('Cannot reach ComfyUI: ' + friendlyError(e), 'err');
      debugLog('connect failed: ' + (e && (e.stack || e.message || e)));
      renderParams();
    } finally {
      state.connecting = false;
      updateConnectionUI();
      updateDocHint();
    }
  }

  function disconnect() {
    if (state.connecting) return;
    state.connected = false;
    state.objectInfo = null;
    state.objectInfoHost = '';
    state.model = null;
    setStatus('offline', 'bad');
    log('Disconnected.');
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
    try { info = PS.documentInfo(); } catch (e) { info = null; }
    if (!info) {
      hint.textContent = 'No open document - generation will not run.';
      hint.className = 'cs-hint cs-error';
      return;
    }
    var sel = info.selection ? ', selection ' + info.selection.width + 'x' + info.selection.height : '';
    hint.className = 'cs-hint';
    hint.textContent = info.name + ' (' + info.width + 'x' + info.height + ')' + sel;
  }

  /* ------------------------------------------------------------------ */
  /* parameters                                                         */
  /* ------------------------------------------------------------------ */

  function renderParams() {
    var host = state.els.paramsHost;
    if (!host) return;
    clear(host);

    if (!state.connected) {
      append(host, el('div', 'cs-hint', 'Not connected. Click Connect to load the workflow and its parameters.'));
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
    var exposedIds = {};
    exposed.forEach(function (n) { exposedIds[String(n.id)] = true; });

    if (!exposed.length) {
      append(host, el('div', 'cs-hint',
        'No parameters: rename nodes in ComfyUI so their titles start with "#" to expose them here.'));
    }

    exposed.forEach(function (node) { host.appendChild(renderNodeCard(node)); });

    var extraImages = (state.model.loadImages || []).filter(function (img) {
      return !exposedIds[String(img.id)];
    });
    if (extraImages.length) {
      var card = append(host, el('div', 'cs-card'));
      var head = append(card, el('div', 'cs-card-head'));
      append(head, el('div', 'cs-card-title', 'Image inputs'));
      var body = append(card, el('div', 'cs-card-body'));
      extraImages.forEach(function (img) { body.appendChild(renderImageInput(img, false)); });
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

    if (node.isLoadImage) {
      var imageWidget = null;
      for (var j = 0; j < widgets.length; j++) if (widgets[j].name === 'image') imageWidget = widgets[j];
      body.appendChild(renderImageInput({
        id: node.id,
        title: node.title,
        imageValue: pickWidget(node, 'image'),
        widgets: imageWidget ? [imageWidget] : []
      }, true));
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
    var nameEl = append(head, el('div', 'cs-field-name', widget.name));
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
      ta.rows = 3;
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
      input.addEventListener('change', function () { setValue(node.id, widget, input.value); });
    }
    return wrap;
  }

  function renderImageInput(img, insideCard) {
    var wrap = el('div', 'cs-field cs-field-block');
    var head = append(wrap, el('div', 'cs-field-head'));
    append(head, el('div', 'cs-field-name', insideCard ? 'image' : (img.title || ('LoadImage #' + img.id))));

    var toggleWrap = el('label', 'cs-check');
    var toggle = append(toggleWrap, el('input'));
    toggle.type = 'checkbox';
    toggle.checked = state.usePs[String(img.id)] !== false;
    if (!Object.prototype.hasOwnProperty.call(state.usePs, String(img.id))) toggle.checked = true;
    append(toggleWrap, document.createTextNode('take from Photoshop'));
    append(head, toggleWrap);

    var note = append(wrap, el('div', 'cs-hint'));
    var fileRow = null;

    function refreshNote() {
      if (toggle.checked) {
        note.textContent = 'Uses the "' + settings.sourceKind + '" from the active document.';
        if (fileRow) fileRow.style.display = 'none';
      } else {
        note.textContent = 'Uses the image set in the workflow.';
        if (fileRow) fileRow.style.display = '';
      }
    }

    if (img.widgets && img.widgets.length) {
      fileRow = el('div', 'cs-row');
      var widget = null;
      for (var i = 0; i < img.widgets.length; i++) if (img.widgets[i].name === 'image') widget = img.widgets[i];
      if (widget) {
        append(fileRow, createDropdown({
          options: widget.values || [],
          value: getValue(img.id, widget),
          onChange: function (v) { setValue(img.id, widget, v); }
        }));
        append(wrap, fileRow);
      }
    }

    toggle.addEventListener('change', function () {
      state.usePs[String(img.id)] = toggle.checked;
      saveWorkflowState();
      refreshNote();
    });
    refreshNote();
    return wrap;
  }

  function randomSeed() { return Math.floor(Math.random() * 0x7fffffff); }

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
      if (state.usePs[String(img.id)] === false) {
        var widget = null;
        for (var i = 0; i < (img.widgets || []).length; i++) if (img.widgets[i].name === 'image') widget = img.widgets[i];
        if (widget) put(img.id, 'image', getValue(img.id, widget));
        else if (img.imageValue !== undefined) put(img.id, 'image', img.imageValue);
      }
    });

    return overrides;
  }

  function chooseOutputImages(images, outputId) {
    if (!images || !images.length) return [];
    var filtered = images.filter(function (img) { return String(img.nodeId) === String(outputId); });
    return filtered.length ? filtered : images;
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

  async function prepareSource() {
    var loadImages = state.model.loadImages || [];
    var useImages = loadImages.filter(function (img) { return state.usePs[String(img.id)] !== false; });
    if (!useImages.length) return { uploaded: null, exportResult: null, useImages: [] };

    setStatus('exporting', 'busy');
    log('Exporting ' + settings.sourceKind + '...');
    var exportResult = await PS.exportSource(settings.sourceKind);
    debugLog('exported ' + exportResult.path + ' origin=' + JSON.stringify(exportResult.origin));

    var bytes = await PS.readEntryBytes(exportResult.entry);
    var uploadName = 'comfyshop_' + Date.now() + '.png';
    log('Uploading ' + uploadName + ' (' + (bytes.byteLength || bytes.length || 0) + ' bytes)...');
    var uploaded = await Comfy.uploadImage(settings.host, bytes, uploadName, { overwrite: true });
    debugLog('uploaded as ' + JSON.stringify(uploaded));
    await PS.deleteEntry(exportResult.entry);
    exportResult.entry = null;
    return { uploaded: uploaded, exportResult: exportResult, useImages: useImages };
  }

  async function runOne(prep, index, total) {
    var runStarted = Date.now();
    var host = Comfy.normalizeHost(settings.host);
    var overrides = collectOverrides(state.model, total > 1);

    if (prep.uploaded) {
      var imageRef = prep.uploaded.subfolder ? (prep.uploaded.subfolder + '/' + prep.uploaded.name) : prep.uploaded.name;
      prep.useImages.forEach(function (img) {
        var id = String(img.id);
        overrides[id] = overrides[id] || {};
        overrides[id].image = imageRef;
      });
    }

    var built = Convert.buildPrompt(state.workflow, state.objectInfo, overrides);
    if (built.errors.length) throw new Error(built.errors.join('\n'));

    setStatus('queued ' + (index + 1) + '/' + total, 'busy');
    log('Queueing prompt ' + (index + 1) + '/' + total + ' (' + Object.keys(built.prompt).length + ' nodes)...');

    var result = await Comfy.runPrompt(host, built.prompt, Comfy.randomId(), {
      timeoutMs: 30 * 60 * 1000,
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

    var image = images[0];
    log('Downloading ' + image.filename + '...');
    var arrayBuffer = await Comfy.fetchImage(host, image);

    setStatus('inserting layer ' + (index + 1) + '/' + total, 'busy');
    var temp = await PS.getTempFile('comfyshop_result_' + Date.now() + '.png');
    await PS.writeEntryBytes(temp, arrayBuffer);
    var size = pngSize(arrayBuffer);
    debugLog('inserting ' + image.filename + ' ' + size.width + 'x' + size.height);

    var baseName = String(state.workflowName || 'ComfyShop').replace(/\.json$/i, '');
    if (total > 1) baseName += ' ' + (index + 1);
    var origin = prep.exportResult ? prep.exportResult.origin : { x: 0, y: 0 };
    var inserted = await PS.insertFile(temp, {
      name: baseName,
      origin: origin,
      width: size.width,
      height: size.height
    });
    await PS.deleteEntry(temp);

    var seconds = ((Date.now() - runStarted) / 1000).toFixed(1);
    var time = new Date().toLocaleTimeString().replace(/:/g, '-');
    var layerName = baseName + ' ' + time + ' ' + seconds + 's';
    try {
      await PS.renameLayer(inserted.layerId, layerName);
      inserted.layerName = layerName;
    } catch (e) {
      debugLog('rename layer failed: ' + (e && (e.message || e)));
    }
    debugLog('inserted layer ' + inserted.layerId + ' "' + inserted.layerName + '" bounds=' + JSON.stringify(inserted.bounds));

    showPreview(arrayBuffer, inserted.layerName);
    state.lastResult = { layerName: inserted.layerName, image: image, index: index + 1 };
    log('Inserted layer "' + inserted.layerName + '".', 'ok');
    return inserted;
  }

  async function generateBatch(count) {
    if (state.running) return null;
    if (!state.connected) { log('Connect to ComfyUI first.', 'err'); return null; }
    if (!state.model || !state.workflow) { log('No workflow selected.', 'err'); return null; }
    if (!PS.documentInfo()) { log('Open a document in Photoshop first.', 'err'); return null; }
    if (state.model.errors && state.model.errors.length) {
      log(friendlyError(new Error(state.model.errors[0])), 'err');
      return null;
    }

    setRunning(true);
    state.cancelRequested = false;
    state.batch = { total: count, done: 0 };
    setProgress(0);
    var started = Date.now();
    var prep = null;
    debugLog('generateBatch start count=' + count + ' workflow=' + state.workflowName + ' source=' + settings.sourceKind);

    try {
      await ensureObjectInfo();
      state.model = Convert.buildModel(state.workflow, state.objectInfo);
      if (state.model.errors && state.model.errors.length) throw new Error(state.model.errors[0]);

      prep = await prepareSource();

      for (var i = 0; i < count; i++) {
        if (state.cancelRequested) break;
        await runOne(prep, i, count);
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
      }
      return null;
    } finally {
      if (prep && prep.exportResult && prep.exportResult.entry) {
        try { await PS.deleteEntry(prep.exportResult.entry); } catch (e) { /* ignore */ }
      }
      setRunning(false);
      updateDocHint();
    }
  }

  function showPreview(arrayBuffer, caption) {
    try {
      var bytes = new Uint8Array(arrayBuffer);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      state.els.previewImg.src = 'data:image/png;base64,' + btoa(binary);
      state.els.previewCaption.textContent = caption;
      state.els.preview.classList.add('visible');
    } catch (e) {
      log('Preview unavailable: ' + (e.message || e));
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
    state.els.srcDropdown.setValue(settings.sourceKind, false);
    if (!initialized) {
      initialized = true;
      setTimeout(function () {
        initPaths()
          .then(function () {
            applyExternalConfig();
            state.els.hostInput.value = settings.host;
            state.els.srcDropdown.setValue(settings.sourceKind, false);
            return refreshWorkflowList();
          })
          .then(function () {
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
