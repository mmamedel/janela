// SPIKE — a minimal iOS janela shell: UIKit owns the run loop, WKWebView is the
// window, and the TypeScript side is a linked scriptc library we call into.
//
// The WKWebView + WKUserContentController + script-message-handler wiring below
// follows the approach used by wry (https://github.com/tauri-apps/wry,
// Apache-2.0, © Tauri Programme within The Commons Conservancy) in
// src/wkwebview/. wry attaches its webview to a UIView supplied by tao; this
// spike creates the UIWindow/UIViewController itself, since there is no tao
// here. The IPC shape (one named handler, JSON in/out) is janela's own.
//
// Objective-C++ rather than plain C++ with objc_msgSend: defining a delegate
// class is a few lines of @implementation here versus objc_allocateClassPair +
// class_addMethod by hand. webview.h proves the runtime-only route works if
// header-only-ness ever matters; for a shell we compile ourselves it does not.

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

#include <string>

// ---- the scriptc library's C ABI (from profile.json) ------------------------
extern "C" {
void jl_init(void);
void jl_set_panic_sink(void (*fn)(void *, const char *, size_t, const char *, size_t), void *ctx);
void jl_reset(void);
void jl_handle_invoke(const char *cmd, size_t cmd_len, const char *args, size_t args_len,
                      char **out, size_t *out_len);
}

static void panic_sink(void *ctx, const char *sym, size_t symlen, const char *msg, size_t msglen) {
  (void)ctx;
  NSLog(@"[janela-ios] PANIC %.*s: %.*s", (int)symlen, sym, (int)msglen, msg);
}

/// Call into TypeScript. Returns the JSON reply; the library owns the result
/// arena, so copy it out and release with jl_reset() before returning.
static NSString *callTS(NSString *cmd, NSString *argsJson) {
  const char *c = cmd.UTF8String;
  const char *a = argsJson.UTF8String;
  char *out = nullptr;
  size_t out_len = 0;
  jl_handle_invoke(c, strlen(c), a, strlen(a), &out, &out_len);
  NSString *reply = out ? [[NSString alloc] initWithBytes:out
                                                   length:out_len
                                                 encoding:NSUTF8StringEncoding]
                        : @"null";
  jl_reset();
  return reply ?: @"null";
}

// ---- the page->native bridge ------------------------------------------------

@interface JanelaBridge : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) WKWebView *webview;
@end

@implementation JanelaBridge

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
  // Body is {id, cmd, args} — args already stringified by the page.
  NSDictionary *body = (NSDictionary *)message.body;
  NSString *callId = body[@"id"];
  NSString *cmd = body[@"cmd"];
  NSString *args = body[@"args"] ?: @"null";

  // "log" is the spike's evidence channel: whatever the page reports lands in
  // the simulator console, so a round trip is observable without a debugger.
  if ([cmd isEqualToString:@"log"]) {
    NSLog(@"[janela-ios] page says: %@", args);
  }

  NSString *reply = callTS(cmd, args);
  NSLog(@"[janela-ios] invoke cmd=%@ args=%@ -> %@", cmd, args, reply);

  // Resolve the page-side promise. The reply is already JSON, so it can be
  // spliced straight into the expression.
  NSString *js = [NSString stringWithFormat:@"window.__janelaResolve(%@, %@);", callId, reply];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.webview evaluateJavaScript:js completionHandler:nil];
  });
}

@end

// ---- the app ----------------------------------------------------------------

static NSString *const kBootstrap =
    @"window.__janelaPending = {};"
    @"window.__janelaSeq = 0;"
    @"window.__janelaResolve = function (id, value) {"
    @"  var r = window.__janelaPending[id];"
    @"  if (r) { delete window.__janelaPending[id]; r(value); }"
    @"};"
    @"window.janela = {"
    @"  invoke: function (cmd, args) {"
    @"    var id = ++window.__janelaSeq;"
    @"    return new Promise(function (resolve) {"
    @"      window.__janelaPending[id] = resolve;"
    @"      window.webkit.messageHandlers.janela.postMessage({"
    @"        id: id, cmd: cmd, args: JSON.stringify(args === undefined ? null : args)"
    @"      });"
    @"    });"
    @"  }"
    @"};";

static NSString *const kPage =
    @"<!doctype html><html><head><meta name='viewport' content='width=device-width'></head>"
    @"<body style=\"font:16px -apple-system;padding:2rem\">"
    @"<h1>janela on iOS</h1><pre id='out'>booting…</pre>"
    @"<script>"
    @"window.onload = async () => {"
    @"  const sum = await janela.invoke('add', { a: 2, b: 40 });"
    @"  const hi = await janela.invoke('greet', { name: 'iOS' });"
    @"  const uni = await janela.invoke('unicode', {});"
    @"  const st = await janela.invoke('stats', {});"
    @"  document.getElementById('out').textContent = 'add=' + sum + '\\n' + hi + '\\n' + uni;"
    @"  await janela.invoke('log', 'add=' + sum + ' | ' + hi + ' | ' + uni +"
    @"    ' | invokes=' + st.invokes + ' platform=' + st.platform +"
    @"    ' | typeof sum=' + (typeof sum));"
    @"};"
    @"</script></body></html>";

@interface JanelaViewController : UIViewController
@end

@implementation JanelaViewController {
  WKWebView *_webview;
  JanelaBridge *_bridge;
}

- (void)viewDidLoad {
  [super viewDidLoad];

  WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
  WKUserContentController *manager = config.userContentController;

  _bridge = [[JanelaBridge alloc] init];
  [manager addScriptMessageHandler:_bridge name:@"janela"];

  // Inject the bridge before the document loads, exactly as janela does on
  // desktop with webview_init.
  WKUserScript *boot = [[WKUserScript alloc] initWithSource:kBootstrap
                                              injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                           forMainFrameOnly:YES];
  [manager addUserScript:boot];

  _webview = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
  _webview.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  _bridge.webview = _webview;
  [self.view addSubview:_webview];

  [_webview loadHTMLString:kPage baseURL:nil];
}

@end

@interface JanelaAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation JanelaAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  NSLog(@"[janela-ios] launching; initialising the scriptc library");
  jl_set_panic_sink(panic_sink, nullptr);
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
