// janela's iOS shell: UIKit owns the run loop, WKWebView is the window, and
// the app's TypeScript is a linked scriptc library we call into.
//
// This is the mirror image of the desktop shim. There, TypeScript owns main()
// and drives a C library over FFI; here the platform owns main() and calls a
// TypeScript library. scriptc builds iOS as a library only, and library mode
// links no event loop (SC4005), so there is nothing to pump: each invoke runs
// to completion and returns.
//
// The WKWebView / WKUserContentController / script-message-handler wiring
// follows the approach used by wry (https://github.com/tauri-apps/wry,
// Apache-2.0, © Tauri Programme within The Commons Conservancy) in
// src/wkwebview/. wry attaches its webview to a UIView supplied by tao; janela
// has no tao, so it creates the UIWindow and root view controller itself. The
// IPC envelope and the page-side bridge are janela's own, and match what the
// desktop shim injects so that `janela/api` works unchanged.

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

#include <string.h>

// ---- the scriptc library's C ABI (see the generated profile) ---------------
extern "C" {
void jl_init(void);
void jl_reset(void);
void jl_set_panic_sink(void (*fn)(void *, const char *, size_t, const char *, size_t), void *ctx);
int32_t jl_set_callback(const char *name, void (*fn)(void), void *ctx);
void jl_handle_invoke(const char *cmd, size_t cmd_len, const char *args, size_t args_len,
                      char **out, size_t *out_len);
void jl_index_html(char **out, size_t *out_len);
void jl_on_timer(double id);
void jl_on_fs_done(double id, bool ok, const char *payload, size_t payload_len);
}

static WKWebView *gWebView = nil;

/// Settle one page-side promise with an envelope that is already JSON.
static void settlePage(NSNumber *callId, NSString *envelope) {
  NSString *js =
      [NSString stringWithFormat:@"window.__janelaSettle(%@,%@);", callId, envelope];
  dispatch_async(dispatch_get_main_queue(), ^{
    [gWebView evaluateJavaScript:js completionHandler:nil];
  });
}

static void panicSink(void *ctx, const char *sym, size_t symlen, const char *msg, size_t msglen) {
  (void)ctx;
  NSLog(@"[janela] host panic in %.*s: %.*s", (int)symlen, sym, (int)msglen, msg);
}

// ---- what the shell owns for the library ----------------------------------
//
// Two tables, mirroring the desktop shim: continuations the library parked
// with us, and page replies we are holding until the library says what they
// are. Both live on the main queue and are only touched there.
//
// THE RULE (upstream #263): a channel handler must never re-enter the library.
// Every handler below therefore only records what it was told and returns; the
// re-entry happens from a dispatch_async block, i.e. at the top of a later
// turn with no library frame beneath it. A breach silently appears to work, so
// this has to hold by construction rather than by testing.

/// Page replies whose answer was not ready when handle_invoke returned.
/// pendingId -> the page-side call id we have not settled yet.
static NSMutableDictionary<NSNumber *, NSNumber *> *gHeld = nil;
/// Envelopes that arrived before we knew the page call id — a command that
/// resolves synchronously settles during its own dispatch, before the
/// {"pending":id} envelope has made it back to us.
static NSMutableDictionary<NSNumber *, NSString *> *gEarly = nil;

/// Answer the page for a pending id, whichever half arrived first.
static void resolvePending(NSNumber *pendingId, NSString *envelope) {
  NSNumber *callId = gHeld[pendingId];
  if (callId) {
    [gHeld removeObjectForKey:pendingId];
    settlePage(callId, envelope);
  } else {
    gEarly[pendingId] = envelope; // handle_invoke has not returned yet
  }
}

/// Register the page call id a pending answer belongs to.
static void holdPending(NSNumber *pendingId, NSNumber *callId) {
  NSString *early = gEarly[pendingId];
  if (early) {
    [gEarly removeObjectForKey:pendingId];
    settlePage(callId, early); // it resolved synchronously; answer now
  } else {
    gHeld[pendingId] = callId;
  }
}

// ---- channels the library calls (TS -> shell) ------------------------------

/// Park a continuation with us and call back when it comes due. A zero delay
/// still goes through dispatch_after(0), which posts to the next turn — that
/// is app.defer(), and it costs no timer.
static void hostSchedule(void *ctx, double id, double ms) {
  (void)ctx;
  int64_t delay = (int64_t)(ms > 0 ? ms : 0);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    jl_on_timer(id); // fresh turn: no library frame beneath us
  });
}

/// The library has an answer for a held page reply.
static void hostSettle(void *ctx, double pendingId, const char *env, size_t env_len) {
  (void)ctx;
  NSString *envelope = [[NSString alloc] initWithBytes:env
                                                length:env_len
                                              encoding:NSUTF8StringEncoding] ?: @"null";
  NSNumber *key = @((int64_t)pendingId);
  dispatch_async(dispatch_get_main_queue(), ^{
    resolvePending(key, envelope);
  });
}

/// The file queue: blocking I/O happens here, never on the main queue, and
/// never inside the library. The library links no threads of its own, so this
/// is the only place a read can go.
/// An iOS app has no useful working directory and cannot see host paths, so a
/// relative path is taken as relative to the app's Documents directory — the
/// one place a sandboxed app can freely read and write.
static NSString *resolvePath(NSString *path) {
  if ([path hasPrefix:@"/"]) return path;
  NSArray<NSString *> *dirs =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *docs = dirs.firstObject ?: NSTemporaryDirectory();
  return [docs stringByAppendingPathComponent:path];
}

static dispatch_queue_t fsQueue(void) {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("dev.janela.fs", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

static void finishFs(double id, bool ok, NSString *payload) {
  // Convert INSIDE the block: -UTF8String hands back an autoreleased buffer
  // whose lifetime does not survive the hop to another queue. The NSString is
  // captured (and retained) by the block; the bytes are taken on arrival.
  dispatch_async(dispatch_get_main_queue(), ^{
    const char *bytes = payload.UTF8String ?: "";
    jl_on_fs_done(id, ok, bytes, strlen(bytes));
  });
}

static void hostReadFile(void *ctx, double id, const char *path, size_t path_len) {
  (void)ctx;
  NSString *p = resolvePath([[NSString alloc] initWithBytes:path
                                                     length:path_len
                                                   encoding:NSUTF8StringEncoding] ?: @"");
  dispatch_async(fsQueue(), ^{
    NSError *err = nil;
    NSString *text = [NSString stringWithContentsOfFile:p
                                               encoding:NSUTF8StringEncoding
                                                  error:&err];
    if (text) finishFs(id, true, text);
    else finishFs(id, false, err.localizedDescription ?: @"read failed");
  });
}

static void hostWriteFile(void *ctx, double id, const char *path, size_t path_len,
                          const char *data, size_t data_len) {
  (void)ctx;
  NSString *p = resolvePath([[NSString alloc] initWithBytes:path
                                                     length:path_len
                                                   encoding:NSUTF8StringEncoding] ?: @"");
  NSString *d = [[NSString alloc] initWithBytes:data
                                         length:data_len
                                       encoding:NSUTF8StringEncoding] ?: @"";
  dispatch_async(fsQueue(), ^{
    NSError *err = nil;
    BOOL ok = [d writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:&err];
    if (ok) finishFs(id, true, @"");
    else finishFs(id, false, err.localizedDescription ?: @"write failed");
  });
}

/// Copy a library-owned result out of its arena and release it. Results live
/// until the next jl_reset(), so nothing may hold the pointer past this call.
static NSString *takeResult(char *out, size_t out_len) {
  NSString *s = out ? [[NSString alloc] initWithBytes:out
                                               length:out_len
                                             encoding:NSUTF8StringEncoding]
                    : nil;
  jl_reset();
  return s ?: @"null";
}

/// Escape a JSON document for splicing into a JS expression as a string
/// literal. Used for the event payload, which the page parses back.
static NSString *jsQuote(NSString *raw) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:@[ raw ] options:0 error:nil];
  NSString *arr = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
  // ["..."] -> "..."
  return [arr substringWithRange:NSMakeRange(1, arr.length - 2)];
}

// ---- host -> page: the event channel ---------------------------------------
//
// The library calls this through the declared callback channel whenever the
// app emits. Evaluating JS must happen on the main queue.

static void emitEvent(void *ctx, const char *name, size_t name_len,
                      const char *payload, size_t payload_len) {
  (void)ctx;
  NSString *event = [[NSString alloc] initWithBytes:name length:name_len
                                           encoding:NSUTF8StringEncoding];
  NSString *json = [[NSString alloc] initWithBytes:payload length:payload_len
                                          encoding:NSUTF8StringEncoding];
  if (!event || !json) return;
  NSString *js = [NSString stringWithFormat:@"window.__wvEmit(%@,%@);", jsQuote(event), json];
  dispatch_async(dispatch_get_main_queue(), ^{
    [gWebView evaluateJavaScript:js completionHandler:nil];
  });
}

// ---- page -> host: the invoke bridge ---------------------------------------

@interface JanelaBridge : NSObject <WKScriptMessageHandler>
@end

@implementation JanelaBridge

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
  NSDictionary *body = (NSDictionary *)message.body;
  if (![body isKindOfClass:NSDictionary.class]) return;

  NSNumber *callId = body[@"id"];
  NSString *cmd = body[@"cmd"];
  NSString *args = body[@"args"] ?: @"null";
  if (!callId || !cmd) return;

  const char *c = cmd.UTF8String;
  const char *a = args.UTF8String;
  char *out = NULL;
  size_t out_len = 0;
  jl_handle_invoke(c, strlen(c), a, strlen(a), &out, &out_len);
  NSString *reply = takeResult(out, out_len);

  // An async command answers later: the library returns {"pending":<id>} and
  // we hold the page's promise until hostSettle() tells us what it is.
  NSData *replyData = [reply dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *env = replyData
      ? [NSJSONSerialization JSONObjectWithData:replyData options:0 error:nil]
      : nil;
  NSNumber *pendingId = [env isKindOfClass:NSDictionary.class] ? env[@"pending"] : nil;
  if (pendingId) {
    holdPending(pendingId, callId);
    return;
  }

  // Otherwise the reply is an envelope: {"ok":true,"value":…} or
  // {"ok":false,"error":…}, already JSON, so it splices straight into the
  // expression that settles the page-side promise.
  settlePage(callId, reply);
}

@end

// ---- the page-side bridge --------------------------------------------------
//
// Same surface the desktop shim injects — window.janela.invoke/listen and
// window.__wvEmit — so `janela/api` and a project's frontend work unchanged.
// Only the transport differs: a script message instead of a webview bind.

static NSString *const kBootstrap =
    @"window.__wvListeners = {};"
    @"window.__janelaPending = {};"
    @"window.__janelaSeq = 0;"
    @"window.__janelaSettle = function (id, env) {"
    @"  var p = window.__janelaPending[id];"
    @"  if (!p) return;"
    @"  delete window.__janelaPending[id];"
    @"  if (env && env.ok) p.resolve(env.value); else p.reject(new Error((env && env.error) || 'janela: invoke failed'));"
    @"};"
    @"window.janela = {"
    @"  invoke: function (cmd, args) {"
    @"    var id = ++window.__janelaSeq;"
    @"    return new Promise(function (resolve, reject) {"
    @"      window.__janelaPending[id] = { resolve: resolve, reject: reject };"
    @"      window.webkit.messageHandlers.janela.postMessage({"
    @"        id: id, cmd: cmd, args: JSON.stringify(args === undefined ? null : args)"
    @"      });"
    @"    });"
    @"  },"
    @"  listen: function (event, cb) {"
    @"    if (!window.__wvListeners[event]) window.__wvListeners[event] = [];"
    @"    window.__wvListeners[event].push(cb);"
    @"    return function () {"
    @"      var a = window.__wvListeners[event] || [];"
    @"      var i = a.indexOf(cb);"
    @"      if (i >= 0) a.splice(i, 1);"
    @"    };"
    @"  },"
    @"};"
    @"window.__wvEmit = function (event, payload) {"
    @"  var cbs = window.__wvListeners[event] || [];"
    @"  for (var i = 0; i < cbs.length; i++) cbs[i](payload);"
    @"};";

@interface JanelaViewController : UIViewController
@end

@implementation JanelaViewController {
  JanelaBridge *_bridge;
}

- (void)viewDidLoad {
  [super viewDidLoad];

  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  WKUserContentController *manager = config.userContentController;

  _bridge = [[JanelaBridge alloc] init];
  [manager addScriptMessageHandler:_bridge name:@"janela"];

  // Injected before the document loads, exactly as the desktop shim does with
  // webview_init — so the page can call janela.invoke from its first line.
  WKUserScript *boot = [[WKUserScript alloc] initWithSource:kBootstrap
                                              injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                           forMainFrameOnly:YES];
  [manager addUserScript:boot];

  WKWebView *webview = [[WKWebView alloc] initWithFrame:self.view.bounds
                                          configuration:config];
  webview.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.view addSubview:webview];
  gWebView = webview;

  char *out = NULL;
  size_t out_len = 0;
  jl_index_html(&out, &out_len);
  NSString *html = takeResult(out, out_len);
  [webview loadHTMLString:html baseURL:nil];
}

@end

@interface JanelaAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation JanelaAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  // Registration is a pure store and is legal before init; the panic sink and
  // the event channel must both be in place before any TypeScript runs, since
  // setup() executes during jl_init().
  jl_set_panic_sink(panicSink, NULL);
  gHeld = [NSMutableDictionary dictionary];
  gEarly = [NSMutableDictionary dictionary];
  // Registration is a pure store and is legal before init; it also survives
  // jl_reset(), so it is done once here.
  if (jl_set_callback("hostSchedule", (void (*)(void))hostSchedule, NULL) != 0 ||
      jl_set_callback("hostSettle", (void (*)(void))hostSettle, NULL) != 0 ||
      jl_set_callback("hostReadFile", (void (*)(void))hostReadFile, NULL) != 0 ||
      jl_set_callback("hostWriteFile", (void (*)(void))hostWriteFile, NULL) != 0) {
    NSLog(@"[janela] could not register a host channel");
  }
  if (jl_set_callback("janelaEmit", (void (*)(void))emitEvent, NULL) != 0) {
    NSLog(@"[janela] could not register the event channel — app.emit will trap");
  }
  jl_init();

  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [[JanelaViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([JanelaAppDelegate class]));
  }
}
