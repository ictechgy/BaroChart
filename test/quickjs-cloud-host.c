/* Standalone Linux test host; not JNI or an Android SDK executable. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <time.h>
#include <assert.h>
#include "quickjs.h"
typedef struct {size_t live,peak,count;double deadline;} Host;
typedef union {max_align_t alignment;size_t size;} Header;
static void account(JSMallocState *s){Host *h=s->opaque;h->live=s->malloc_size;h->count=s->malloc_count;if(h->live>h->peak)h->peak=h->live;}
static void *allocate(JSMallocState *s,size_t size){if(!size||size>SIZE_MAX-sizeof(Header))return NULL;size_t n=size+sizeof(Header);if(n>s->malloc_limit||s->malloc_size>s->malloc_limit-n)return NULL;Header *p=malloc(n);if(!p)return NULL;p->size=size;s->malloc_size+=n;s->malloc_count++;account(s);return p+1;}
static void release(JSMallocState *s,void *ptr){if(!ptr)return;Header *p=(Header*)ptr-1;s->malloc_size-=p->size+sizeof(Header);s->malloc_count--;free(p);account(s);}
static void *resize(JSMallocState *s,void *ptr,size_t size){if(!ptr)return allocate(s,size);if(!size){release(s,ptr);return NULL;}if(size>SIZE_MAX-sizeof(Header))return NULL;Header *p=(Header*)ptr-1;size_t remain=s->malloc_size-p->size-sizeof(Header),n=size+sizeof(Header);if(n>s->malloc_limit||remain>s->malloc_limit-n)return NULL;p=realloc(p,n);if(!p)return NULL;p->size=size;s->malloc_size=remain+n;account(s);return p+1;}
static size_t usable(const void *ptr){return ptr?((const Header*)ptr-1)->size:0;}
static const JSMallocFunctions allocator={allocate,release,resize,usable};
static double now(void){struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))abort();return t.tv_sec+t.tv_nsec/1e9;}
static int interrupt(JSRuntime *rt,void *opaque){(void)rt;return now()>=((Host*)opaque)->deadline;}
static char *read_file(const char *path,size_t limit,size_t *length){FILE *f=fopen(path,"rb");if(!f)return NULL;if(fseek(f,0,SEEK_END)){fclose(f);return NULL;}long n=ftell(f);if(n<0||(size_t)n>limit||fseek(f,0,SEEK_SET)){fclose(f);return NULL;}char *s=malloc((size_t)n+1);if(!s){fclose(f);return NULL;}if(fread(s,1,(size_t)n,f)!=(size_t)n){free(s);fclose(f);return NULL;}fclose(f);s[n]=0;*length=(size_t)n;return s;}
static int exception(JSContext *ctx,const char *expected){JSValue e=JS_GetException(ctx),stack=JS_GetPropertyStr(ctx,e,"stack");const char *s=JS_ToCString(ctx,e),*t=JS_ToCString(ctx,stack);int matched=expected&&s&&strstr(s,expected);if(!matched)fprintf(stderr,"QuickJS exception: %s\n%s\n",s?s:"unknown",t?t:"");JS_FreeCString(ctx,t);JS_FreeCString(ctx,s);JS_FreeValue(ctx,stack);JS_FreeValue(ctx,e);return matched?0:1;}
static JSRuntime *runtime(Host *h,size_t limit){JSRuntime *rt=JS_NewRuntime2(&allocator,h);if(!rt)return NULL;JS_SetMemoryLimit(rt,limit);JS_SetMaxStackSize(rt,1024*1024);JS_SetCanBlock(rt,0);JS_SetInterruptHandler(rt,interrupt,h);return rt;}
static int failure_case(int timeout){Host h={.deadline=now()+5};JSRuntime *rt=runtime(&h,8*1024*1024);if(!rt)return 1;JSContext *ctx=JS_NewContext(rt);int failed=!ctx;if(ctx){if(timeout)h.deadline=now()+0.01;const char *source=timeout?"for(;;){}":"new ArrayBuffer(64*1024*1024)";JSValue v=JS_Eval(ctx,source,strlen(source),timeout?"interrupt-case":"oom-case",JS_EVAL_TYPE_GLOBAL);if(JS_IsException(v))failed=exception(ctx,timeout?"interrupted":"out of memory");else failed=1;JS_FreeValue(ctx,v);h.deadline=now()+5;v=JS_Eval(ctx,"1+1",3,"recovery",JS_EVAL_TYPE_GLOBAL);int n=0;if(JS_IsException(v)||JS_ToInt32(ctx,&n,v)||n!=2)failed=1;JS_FreeValue(ctx,v);JS_FreeContext(ctx);}JS_FreeRuntime(rt);if(h.live||h.count)failed=1;printf("{\"case\":\"%s\",\"passed\":%s,\"peakRequestedBytes\":%zu,\"finalLiveBytes\":%zu,\"finalAllocationCount\":%zu}\n",timeout?"interrupt-cleanup":"oom-cleanup",failed?"false":"true",h.peak,h.live,h.count);return failed;}
int main(int argc,char **argv){if(argc!=3){fprintf(stderr,"usage: host BUNDLE ASSERTIONS\n");return 2;}Host h={.deadline=now()+30};JSRuntime *rt=runtime(&h,128*1024*1024);if(!rt)return 3;JSContext *ctx=JS_NewContext(rt);int failed=!ctx;for(int i=1;ctx&&i<3&&!failed;i++){size_t length=0;char *s=read_file(argv[i],i==1?1024*1024:256*1024,&length);if(!s){failed=1;break;}JSValue v=JS_Eval(ctx,s,length,argv[i],JS_EVAL_TYPE_GLOBAL);free(s);if(JS_IsException(v))failed=exception(ctx,NULL);else if(i==2){const char *result=JS_ToCString(ctx,v);if(!result)failed=1;else puts(result);JS_FreeCString(ctx,result);}JS_FreeValue(ctx,v);}if(ctx){JS_RunGC(rt);JS_FreeContext(ctx);}JS_FreeRuntime(rt);if(h.live||h.count)failed=1;printf("{\"case\":\"workspace-runtime-cleanup\",\"passed\":%s,\"peakRequestedBytes\":%zu,\"finalLiveBytes\":%zu,\"finalAllocationCount\":%zu}\n",failed?"false":"true",h.peak,h.live,h.count);failed|=failure_case(0);failed|=failure_case(1);return failed?1:0;}
