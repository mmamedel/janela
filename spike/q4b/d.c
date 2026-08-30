#include <stdio.h>
#include <string.h>
#include <stddef.h>
void rg_init(void); void rg_reset(void);
void rg_invoke(const char*,size_t,const char*,size_t,char**,size_t*);
static void call(const char*c,const char*a){ char*o=0; size_t n=0;
  rg_invoke(c,strlen(c),a,strlen(a),&o,&n); printf("  %s -> %.*s\n", c,(int)n,o); rg_reset(); }
int main(void){ rg_init(); call("add","{\"a\":2,\"b\":40}"); call("greet","{\"name\":\"registry\"}"); call("nope","{}"); return 0; }
