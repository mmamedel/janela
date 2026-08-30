/* SPIKE — C driver proving library-mode string/bytes returns. */
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

void sp_init(void);
void sp_set_panic_sink(void (*fn)(void *, const char *, size_t, const char *, size_t), void *ctx);
void sp_reset(void);
void sp_collect(void);
void sp_greet(const char *ptr, size_t len, char **out, size_t *out_len);
void sp_make_bytes(double n, uint8_t **out, size_t *out_len);
double sp_calls(void);

static void panic_sink(void *ctx, const char *sym, size_t symlen, const char *msg, size_t msglen) {
  (void)ctx;
  fprintf(stderr, "PANIC in %.*s: %.*s\n", (int)symlen, sym, (int)msglen, msg);
}

int main(void) {
  sp_set_panic_sink(panic_sink, NULL);
  sp_init();

  const char *name = "janela";
  char *s = NULL; size_t slen = 0;
  sp_greet(name, strlen(name), &s, &slen);
  printf("string return : len=%zu \"%.*s\"\n", slen, (int)slen, s);

  uint8_t *b = NULL; size_t blen = 0;
  sp_make_bytes(8.0, &b, &blen);
  printf("bytes return  : len=%zu [", blen);
  for (size_t i = 0; i < blen; i++) printf("%s%u", i ? "," : "", b[i]);
  printf("]\n");

  printf("call count    : %.0f\n", sp_calls());

  /* Result arena: pointers are library-owned until reset. */
  sp_reset();
  printf("after reset   : ok (arena released)\n");

  /* Call again post-reset to prove the instance survives a reset. */
  sp_greet(name, strlen(name), &s, &slen);
  printf("post-reset    : \"%.*s\" calls=%.0f\n", (int)slen, s, sp_calls());
  sp_collect();
  return 0;
}
