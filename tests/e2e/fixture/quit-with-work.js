// Scenario 2: quit while real work is in flight.
//
// Kicks off a file read and a 5s timer on the host, then quits immediately.
// Neither continuation may keep the process alive, and the exit code must be
// 0. If either one fires after quit, the host prints JANELA_TEST_LATE and the
// runner treats that as a failure.

(function () {
  var cfg = window.__JANELA_TEST_CONFIG || {};
  window.addEventListener("load", function () {
    window.janela
      .invoke("startWork", { path: cfg.bigFile, runId: cfg.runId })
      .then(function () {
        return window.janela.invoke("log", "JANELA_TEST_WORK_STARTED " + cfg.runId);
      })
      .then(function () {
        return window.janela.invoke("quit", null);
      });
  });
})();
