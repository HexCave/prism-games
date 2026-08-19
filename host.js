/**
 * Prism host — runs on the content origin, embedded by the launcher extension.
 *
 * The extension cannot execute downloaded game code itself (extension pages are
 * locked to `script-src 'self'`), and it cannot write to this origin's cache.
 * So this page owns both: it caches game files here and runs the game in a
 * nested same-origin iframe, relaying save/load traffic to the launcher.
 *
 *   extension  <--postMessage-->  host (this file)  <--postMessage-->  game
 */
(function () {
  'use strict';

  var GAME_CACHE = 'prism-games-v1';
  var COMPLETE_MARKER = '.prism-complete';
  var ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  var VERSION_RE = /^\d+\.\d+\.\d+$/;
  var CONCURRENCY = 6;

  var frame = null;
  var current = null;
  var swReady = false;

  var stage = document.getElementById('stage');
  var status = document.getElementById('status');

  // ---------------------------------------------------------------- service worker

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker.register('sw.js', { scope: './' })
      .then(function () { return navigator.serviceWorker.ready; })
      .then(function () { return true; })
      .catch(function (err) {
        // Some privacy configurations block workers in embedded contexts. Games
        // still run straight from the network; they just cannot go offline.
        console.warn('[prism] service worker unavailable:', err && err.message);
        return false;
      });
  }

  // ---------------------------------------------------------------- cache

  function gameBase(id, version) {
    if (!ID_RE.test(id) || !VERSION_RE.test(version)) throw new Error('bad game reference');
    return new URL('games/' + id + '/' + version + '/', location.href).href;
  }

  function listInstalled() {
    if (!self.caches) return Promise.resolve([]);
    return caches.open(GAME_CACHE).then(function (cache) {
      return cache.keys().then(function (requests) {
        var out = [];
        requests.forEach(function (request) {
          var match = request.url.match(/games\/([^/]+)\/([^/]+)\/\.prism-complete$/);
          if (match) out.push({ id: match[1], version: match[2] });
        });
        return Promise.all(out.map(function (entry) {
          return cache.match(gameBase(entry.id, entry.version) + COMPLETE_MARKER)
            .then(function (response) { return response ? response.json() : null; })
            .then(function (info) {
              return { id: entry.id, version: entry.version, bytes: info && info.bytes, at: info && info.at };
            });
        }));
      });
    });
  }

  /**
   * Stream a file into the cache, reporting bytes as they arrive.
   *
   * Reading the body by hand rather than handing the response straight to the
   * cache is what makes the progress bar honest: several games are a single
   * ~900 KB bundle, and per-file progress on those would jump from 0 to done.
   */
  function fetchWithProgress(url, onBytes) {
    return fetch(url, { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      if (!response.body || typeof response.body.getReader !== 'function') return response;

      var reader = response.body.getReader();
      var chunks = [];

      return (function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            // Only the content type is carried over. Copying the upstream
            // headers wholesale would risk replaying decoded bytes with the
            // original content-encoding still attached.
            return new Response(new Blob(chunks), {
              status: 200,
              headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' }
            });
          }
          chunks.push(result.value);
          onBytes(result.value.length);
          return pump();
        });
      })();
    });
  }

  function download(id, version, onProgress) {
    var base = gameBase(id, version);
    if (!self.caches) return Promise.reject(new Error('This browser has no Cache Storage available.'));

    return caches.open(GAME_CACHE).then(function (cache) {
      return fetch(base + 'manifest.json', { cache: 'no-cache' })
        .then(function (response) {
          if (!response.ok) throw new Error('Version ' + version + ' is not published (HTTP ' + response.status + ').');
          return response.json();
        })
        .then(function (manifest) {
          var files = manifest.files.slice();
          var total = manifest.totalBytes || files.reduce(function (sum, f) { return sum + (f.bytes || 0); }, 0);
          var loaded = 0;
          var index = 0;
          var lastReport = 0;

          function report(force) {
            var now = Date.now();
            if (!force && now - lastReport < 120) return;
            lastReport = now;
            onProgress({ loaded: loaded, total: total, files: files.length });
          }

          report(true);

          function next() {
            if (index >= files.length) return Promise.resolve();
            var file = files[index++];
            var url = base + file.path;
            return fetchWithProgress(url, function (bytes) { loaded += bytes; report(false); })
              .then(function (response) { return cache.put(url, response); })
              .then(function () {
                report(true);
                return next();
              });
          }

          var workers = [];
          for (var i = 0; i < Math.min(CONCURRENCY, files.length); i++) workers.push(next());

          return Promise.all(workers)
            .then(function () {
              return cache.put(base + COMPLETE_MARKER, new Response(
                JSON.stringify({ bytes: total, files: files.length, at: Date.now(), entry: manifest.entry }),
                { headers: { 'content-type': 'application/json' } }
              ));
            })
            .then(function () {
              return { id: id, version: version, bytes: total, files: files.length, entry: manifest.entry };
            })
            .catch(function (err) {
              // Never leave a half-written version behind: without the marker it
              // reads as "not installed", but the stray files would waste quota.
              return remove(id, version).then(function () { throw err; });
            });
        });
    });
  }

  function remove(id, version) {
    var base = gameBase(id, version);
    if (!self.caches) return Promise.resolve();
    return caches.open(GAME_CACHE).then(function (cache) {
      return cache.keys().then(function (requests) {
        return Promise.all(requests
          .filter(function (request) { return request.url.indexOf(base) === 0; })
          .map(function (request) { return cache.delete(request); }));
      });
    });
  }

  function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().then(function (info) {
      return { usage: info.usage, quota: info.quota };
    }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- game frame

  function play(id, version, entry) {
    stop();
    var base = gameBase(id, version);
    current = { id: id, version: version };
    frame = document.createElement('iframe');
    frame.className = 'game';
    frame.title = id;
    frame.allow = 'fullscreen; gamepad; autoplay; xr-spatial-tracking; accelerometer';
    frame.src = base + (entry || 'index.html');
    frame.addEventListener('load', function () {
      // Hand the game the keyboard straight away — nobody should have to click
      // an empty canvas before the arrow keys do anything.
      try { frame.contentWindow.focus(); } catch (err) { /* not fatal */ }
      toParent({ __prismHost: 1, event: 'gameLoaded', payload: { id: id, version: version } });
    });
    stage.appendChild(frame);
    status.hidden = true;
    return { id: id, version: version };
  }

  function stop() {
    if (frame) { frame.remove(); frame = null; }
    current = null;
  }

  function toGame(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }

  // ---------------------------------------------------------------- extension relay

  var parentWindow = window.parent;
  var connected = parentWindow !== window;

  function toParent(message) {
    if (connected) parentWindow.postMessage(message, '*');
  }

  function reply(id, ok, payload) {
    toParent({ __prismHost: 1, id: id, ok: ok, payload: ok ? payload : undefined, error: ok ? undefined : String(payload && payload.message || payload) });
  }

  var commands = {
    ping: function () {
      return Promise.resolve({ swReady: swReady, version: 1 });
    },
    /**
     * The launcher reads the catalog through here rather than fetching it
     * directly. A request made from the extension would never pass through this
     * origin's service worker, so there would be no offline copy to fall back
     * on — and it would depend on this endpoint sending CORS headers, which the
     * extension should not have to assume.
     */
    catalog: function () {
      return fetch(new URL('index.json', location.href).href, { cache: 'no-cache' })
        .then(function (response) {
          if (!response.ok) throw new Error('catalog request failed (HTTP ' + response.status + ')');
          return response.json();
        });
    },
    list: function () { return listInstalled(); },
    estimate: function () { return estimate(); },
    download: function (payload, id) {
      return download(payload.id, payload.version, function (progress) {
        toParent({ __prismHost: 1, event: 'progress', payload: { id: payload.id, version: payload.version, loaded: progress.loaded, total: progress.total } });
      });
    },
    remove: function (payload) {
      return remove(payload.id, payload.version).then(function () { return { removed: true }; });
    },
    play: function (payload) {
      return Promise.resolve(play(payload.id, payload.version, payload.entry));
    },
    stop: function () { stop(); return Promise.resolve({ stopped: true }); },
    pause: function () { toGame({ __prism: 1, type: 'pause' }); return Promise.resolve({}); },
    resume: function () { toGame({ __prism: 1, type: 'resume' }); return Promise.resolve({}); },
    sdkReply: function (payload) {
      toGame({ __prism: 1, id: payload.id, payload: payload.payload, error: payload.error });
      return Promise.resolve({});
    }
  };

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message) return;

    // From the launcher.
    if (message.__prismHost === 1 && message.type) {
      var handler = commands[message.type];
      if (!handler) return reply(message.id, false, new Error('unknown command: ' + message.type));
      try {
        Promise.resolve(handler(message.payload || {}, message.id))
          .then(function (result) { reply(message.id, true, result); })
          .catch(function (err) { reply(message.id, false, err); });
      } catch (err) {
        reply(message.id, false, err);
      }
      return;
    }

    // From the running game: relay upward, tagged with which game is asking so
    // the launcher never writes one game's progress into another's record.
    if (message.__prism === 1 && message.dir === 'up' && current) {
      toParent({
        __prismHost: 1,
        event: 'sdk',
        payload: { id: message.id, type: message.type, payload: message.payload, game: current.id, version: current.version }
      });
    }
  });

  registerWorker().then(function (ready) {
    swReady = ready;
    toParent({ __prismHost: 1, event: 'hostReady', payload: { swReady: ready, version: 1 } });
  });
})();
