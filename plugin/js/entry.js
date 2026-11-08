/*
 * ComfyShop - UXP entrypoints.
 * The panel UI lives in js/app.js; the workflow/ComfyUI logic is in
 * convert.js / comfy.js and the Photoshop operations in ps.js.
 */
(function () {
  'use strict';

  var entrypoints = require('uxp').entrypoints;
  var App = (typeof globalThis !== 'undefined' ? globalThis : window).CSApp;

  function panelController() {
    return {
      create: function () {
        try {
          return App.mount();
        } catch (e) {
          console.error('ComfyShop panel create failed', e);
          var box = document.createElement('div');
          box.textContent = 'ComfyShop failed to start: ' + (e && (e.message || e));
          box.style.padding = '10px';
          return box;
        }
      },
      show: function (event) {
        try {
          App.show(event);
        } catch (e) {
          console.error('ComfyShop panel show failed', e);
        }
      },
      hide: function () {
        try { App.hide(); } catch (e) { /* ignore */ }
      },
      destroy: function () { },
      invokeMenu: function () { }
    };
  }

  entrypoints.setup({
    plugin: {
      create: function () { },
      destroy: function () { }
    },
    panels: {
      main: panelController()
    },
    commands: {
      generate: function () { App.commandGenerate(); },
      selftest: function () { App.commandSelfTest(); }
    }
  });
})();
