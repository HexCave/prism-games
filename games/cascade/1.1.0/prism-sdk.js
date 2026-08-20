/**
 * Prism SDK — the only interface a game needs to talk to the launcher.
 *
 * A game runs in an iframe on the content origin. Its parent is the Prism host
 * page (same origin), which relays to the launcher extension. Everything below
 * is a thin promise wrapper over that relay.
 *
 *   await Prism.ready()            -> saved record, or null:
 *                                     { progress, score, updatedAt, version }
 *   Prism.save(progress, { score })
 *   await Prism.load()             -> saved progress
 *   Prism.exit()                   -> back to the library
 *   Prism.on('pause'|'resume', fn) -> launcher hid/showed the game
 *
 *   await Prism.ad.interstitial(where) -> { shown }
 *   await Prism.ad.rewarded(where)     -> { granted }
 */
(function (global) {
  'use strict';

  var host = global.parent;
  var pending = Object.create(null);
  var seq = 0;
  var handlers = { pause: [], resume: [] };
  var readyState = null;

  if (host === global) {
    // Opened directly (e.g. a developer hitting the file over `prism dev`).
    // Fall back to localStorage so the game is still playable standalone.
    return void (global.Prism = standalone());
  }

  global.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.__prism !== 1) return;
    if (msg.id && pending[msg.id]) {
      var entry = pending[msg.id];
      delete pending[msg.id];
      msg.error ? entry.reject(new Error(msg.error)) : entry.resolve(msg.payload);
      return;
    }
    if (msg.type === 'pause' || msg.type === 'resume') emit(msg.type);
  });

  function emit(name) {
    for (var i = 0; i < handlers[name].length; i++) {
      try { handlers[name][i](); } catch (err) { console.error('[prism] handler failed', err); }
    }
  }

  function send(type, payload) {
    var id = ++seq;
    host.postMessage({ __prism: 1, dir: 'up', id: id, type: type, payload: payload }, '*');
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('prism: "' + type + '" timed out')); }
      }, 10000);
    });
  }

  // Saves are coalesced: games that call save() every frame should not flood
  // the relay, but the last write before exit must never be lost.
  var saveTimer = null, queued = null;
  function flush() {
    if (!queued) return Promise.resolve();
    var payload = queued;
    queued = null;
    clearTimeout(saveTimer);
    saveTimer = null;
    return send('save', payload);
  }


  /**
   * Advertising.
   *
   * There are no ads in the Prism launcher, and there is nothing to show when
   * the player is offline, so both calls resolve to a no-op here. A rewarded
   * no-op still *grants* — refusing the reward because there was no ad to watch
   * would punish the player for the host's lack of an ad network.
   *
   * A portal build installs a real provider before the game boots:
   *
   *   Prism.ad.install({
   *     interstitial: (where) => portal.showAd().then(() => ({ shown: true })),
   *     rewarded: (where) => portal.showRewarded().then((ok) => ({ granted: ok }))
   *   });
   *
   * Anything a provider throws is swallowed: an ad failing, being blocked, or
   * never loading must never stop the game. That is also a submission
   * requirement — a blocked ad call may not block the game loop.
   */
  function makeAds() {
    var provider = null;

    var call = function (kind, where, fallback) {
      if (!provider || typeof provider[kind] !== 'function') return Promise.resolve(fallback);
      var attempt;
      try {
        attempt = Promise.resolve(provider[kind](where));
      } catch (err) {
        return Promise.resolve(fallback);
      }
      // A provider that never settles must not strand the game either.
      return Promise.race([
        attempt.catch(function () { return fallback; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, 12000); })
      ]).then(function (result) { return result || fallback; });
    };

    return {
      install: function (implementation) { provider = implementation || null; },
      get available() { return Boolean(provider); },
      interstitial: function (where) {
        return call('interstitial', where, { shown: false, provider: 'none' });
      },
      rewarded: function (where) {
        return call('rewarded', where, { granted: true, provider: 'none' });
      }
    };
  }

  global.Prism = {
    version: 1,
    ad: makeAds(),

    ready: function () {
      if (!readyState) {
        readyState = send('ready').then(function (state) { return state || null; });
      }
      return readyState;
    },

    save: function (progress, opts) {
      queued = { progress: progress, score: opts && opts.score };
      if (!saveTimer) saveTimer = setTimeout(flush, 400);
      return Promise.resolve();
    },

    flush: flush,

    load: function () {
      return send('load');
    },

    exit: function () {
      return flush().then(function () { send('exit'); });
    },

    on: function (name, fn) {
      if (handlers[name]) handlers[name].push(fn);
      return this;
    }
  };

  // A game that stops without exiting (tab closed, launcher navigated away)
  // still gets its pending save through.
  global.addEventListener('pagehide', flush);

  function standalone() {
    var KEY = 'prism:standalone:' + location.pathname;
    var read = function () {
      try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; }
    };
    return {
      version: 1,
      standalone: true,
      ad: makeAds(),
      ready: function () { return Promise.resolve(read()); },
      save: function (progress, opts) {
        try {
          localStorage.setItem(KEY, JSON.stringify({
            progress: progress, score: opts && opts.score, updatedAt: Date.now()
          }));
        } catch (e) { /* private mode: progress is simply not kept */ }
        return Promise.resolve();
      },
      flush: function () { return Promise.resolve(); },
      load: function () { return Promise.resolve(read()); },
      exit: function () {},
      on: function () { return this; }
    };
  }
})(window);
