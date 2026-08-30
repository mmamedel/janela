#include <stdio.h>
#include <string.h>
#include <stddef.h>
void jl_init(void);
void jl_reset(void);
void jl_handle_invoke(const char *cmd, size_t cl, const char *args, size_t al, char **out, size_t *ol);
static void call(const char *cmd, const char *args) {
  char *out = 0; size_t ol = 0;
  jl_handle_invoke(cmd, strlen(cmd), args, strlen(args), &out, &ol);
  printf("  %-8s %-22s -> %.*s\n", cmd, args, (int)ol, out ? out : "null");
  jl_reset();
}
int main(void) {
  jl_init();
  call("add", "{\"a\":2,\"b\":40}");
  call("greet", "{\"name\":\"iOS\"}");
  call("unicode", "null");
  call("stats", "null");
  call("nope", "null");
  return 0;
}
