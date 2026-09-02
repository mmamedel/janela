// The end-to-end battery, page side.
//
// Appended to a scaffolded project's index.html as a CLASSIC (non-module)
// script. Vite leaves such a script untransformed, so one fixture drives the
// vanilla template and all four framework templates without per-framework
// edits — and it uses the injected `window.janela` global rather than the
// `janela/api` import, so it needs no bundler resolution of its own. (The
// framework's own code exercises the typed-client import path; see the
// framework-mounted assertion.)
//
// Every assertion emits exactly one line:
//   JANELA_TEST {"name":"...","pass":true,"value":...}
// The runner requires that EVERY expected name is seen. A page that throws
// still exits 0 and still prints "run returned 0", so a missing line — not a
// non-zero exit — is how a broken build gets caught.

(function () {
  var cfg = window.__JANELA_TEST_CONFIG || {};
  var UNICODE = "— çãé 🚀";
  var seen = [];

  function report(name, pass, value) {
    seen.push(name);
    var line = "JANELA_TEST " + JSON.stringify({ name: name, pass: !!pass, value: value });
    return window.janela.invoke("log", line);
  }

  function percentile(sorted, p) {
    if (sorted.length === 0) return -1;
    var i = Math.floor((sorted.length - 1) * p);
    return sorted[i];
  }

  function sameArray(a, b) {
    if (!a || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  window.addEventListener("load", function () {
    run().then(
      function () {
        return window.janela.invoke("log", "JANELA_TEST_DONE " + JSON.stringify(seen));
      },
      function (e) {
        // Never let a throw end the run silently: name the failure, then still
        // print DONE so the runner can distinguish "crashed here" from "hung".
        return window.janela
          .invoke("log", "JANELA_TEST_ERROR " + JSON.stringify(String(e && e.stack ? e.stack : e)))
          .then(function () {
            return window.janela.invoke("log", "JANELA_TEST_DONE " + JSON.stringify(seen));
          });
      },
    ).then(function () {
      return window.janela.invoke("quit", null);
    });
  });

  async function run() {
    // 1. The global bridge itself.
    await report(
      "global-bridge",
      typeof window.janela === "object" &&
        typeof window.janela.invoke === "function" &&
        typeof window.janela.listen === "function",
      typeof window.janela,
    );

    // The framework templates render through createClient<App>; the vanilla
    // template has no framework. Only asserted when the runner says so.
    if (cfg.framework) {
      var text = document.body ? document.body.textContent || "" : "";
      await report("framework-mounted", text.indexOf("Hello,") >= 0, text.slice(0, 60));
    }

    // Warm up. The FIRST invoke of a run includes webview startup, and has
    // repeatedly masqueraded as the metric being measured.
    for (var w = 0; w < 20; w++) await window.janela.invoke("ping", { seq: w });

    // 2/3. A sync command must answer while an async one is pending, and the
    // async one must resolve afterwards.
    var t0 = Date.now();
    var pending = window.janela.invoke("wait", { ms: cfg.asyncMs || 300 });
    var syncStart = Date.now();
    var pong = await window.janela.invoke("ping", { seq: 999 });
    var syncLatency = Date.now() - syncStart;
    var syncAnsweredAt = Date.now() - t0;
    await report(
      "sync-while-async-pending",
      pong === 999 && syncLatency <= (cfg.syncLatencyMaxMs || 150),
      { syncLatency: syncLatency, answeredAt: syncAnsweredAt, pong: pong },
    );

    var asyncValue = await pending;
    var asyncAt = Date.now() - t0;
    await report(
      "async-resolves-later",
      typeof asyncValue === "string" &&
        asyncValue.length > 0 &&
        asyncAt >= (cfg.asyncMs || 300) - 30 &&
        asyncAt > syncAnsweredAt,
      { resolvedAt: asyncAt, syncAnsweredAt: syncAnsweredAt },
    );

    // 4. Timers fire in DUE order, not registration order (registered 80,20,50).
    var order = await window.janela.invoke("sleepOrder", null);
    await report("sleep-due-order", sameArray(order, ["s20", "s50", "s80"]), order);

    // 5. defer() runs on the next turn — before a 50ms sleep, with no timer.
    var dorder = await window.janela.invoke("deferOrder", null);
    await report("defer-next-turn", sameArray(dorder, ["defer", "sleep50"]), dorder);

    // 6. commandAsync's reject must reject the page's promise.
    var rejected = false;
    var reason = null;
    try {
      await window.janela.invoke("boom", null);
    } catch (e) {
      rejected = true;
      reason = String(e && e.message ? e.message : e);
    }
    await report("async-reject", rejected, reason);

    // 7/8. emit → listen delivers a typed value; the disposer really works.
    var got = [];
    var off = window.janela.listen("added", function (v) {
      got.push(v);
    });
    await window.janela.invoke("emitNow", { value: 42 });
    await window.janela.invoke("ping", { seq: 1000 }); // let delivery settle
    var afterFirst = got.slice();
    await report(
      "emit-listen",
      afterFirst.length === 1 && afterFirst[0] === 42 && typeof afterFirst[0] === "number",
      afterFirst,
    );

    if (typeof off === "function") off();
    await window.janela.invoke("emitNow", { value: 99 });
    await window.janela.invoke("ping", { seq: 1001 });
    await report("unlisten-stops", got.length === afterFirst.length, got);

    // 9/10. File round trip, including astral-plane characters both ways.
    var payload = UNICODE + " roundtrip " + UNICODE;
    var wrote = await window.janela.invoke("fsWrite", { path: cfg.scratchFile, data: payload });
    var readBack = await window.janela.invoke("fsRead", { path: cfg.scratchFile });
    await report("fs-roundtrip", wrote.ok === true && readBack.ok === true, {
      wrote: wrote,
      length: readBack.length,
    });
    await report("fs-unicode", readBack.text === payload, {
      expectedLength: payload.length,
      gotLength: readBack.length,
      got: String(readBack.text).slice(0, 40),
    });

    // 11/12. Errors arrive as values, not throws.
    var missing = await window.janela.invoke("fsRead", { path: cfg.missingFile });
    await report(
      "fs-missing-error",
      missing.ok === false && typeof missing.error === "string" && missing.error.length > 0,
      missing.error,
    );

    var dir = await window.janela.invoke("fsRead", { path: cfg.scratchDir });
    await report(
      "fs-directory-error",
      dir.ok === false && typeof dir.error === "string" && dir.error.length > 0,
      dir.error,
    );

    // 13/14. A large read must not stall the window: keep pinging throughout
    // and bound the tail, rather than pinning an exact figure.
    var lat = [];
    var reading = window.janela.invoke("bigRead", { path: cfg.bigFile });
    var stop = false;
    reading.then(function () {
      stop = true;
    });
    var seq = 0;
    while (!stop) {
      var s = Date.now();
      await window.janela.invoke("ping", { seq: seq++ });
      lat.push(Date.now() - s);
    }
    var big = await reading;
    await report("large-read-correct", big.ok === true && big.length === cfg.bigFileLength, {
      length: big.length,
      expected: cfg.bigFileLength,
      readMs: big.ms,
    });

    lat.sort(function (a, b) {
      return a - b;
    });
    var p50 = percentile(lat, 0.5);
    var p99 = percentile(lat, 0.99);
    await report(
      "large-read-bounded",
      lat.length >= 5 && p99 <= (cfg.drainP99MaxMs || 50),
      { samples: lat.length, p50: p50, p99: p99, max: lat[lat.length - 1] },
    );
  }
})();
