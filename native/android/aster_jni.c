#include <jni.h>
#include <stdint.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <limits.h>
#ifndef BAROCHART_WITH_QUICKJS
#define BAROCHART_WITH_QUICKJS 1
#endif
#ifndef BAROCHART_WITH_RUST
#define BAROCHART_WITH_RUST 0
#endif
#if BAROCHART_WITH_QUICKJS
#include "quickjs.h"
#endif
#if BAROCHART_WITH_RUST
#include "barochart_core.h"
#endif

enum {BACKEND_QUICKJS=1,BACKEND_RUST=2};
typedef struct {
 int backend;JNIEnv *env;JavaVM *vm;jclass bridge;size_t allocated,allocation_peak;int counted;
#if BAROCHART_WITH_QUICKJS
 JSRuntime *runtime;JSContext *context;JSClassID float64_class;
#endif
#if BAROCHART_WITH_RUST
 BcEngine *rust;
#endif
} AsterHost;
static atomic_uint_fast64_t live_hosts,created_hosts,freed_hosts;
#if BAROCHART_WITH_QUICKJS
/* Documented QuickJS allocator hooks provide O(1) allocation/peak metrics.
 * This counts requested bytes plus aligned headers, not allocator RSS. */
typedef union {max_align_t alignment;size_t size;} AllocationHeader;
static void account(JSMallocState *s){AsterHost *h=s->opaque;h->allocated=s->malloc_size;if(h->allocated>h->allocation_peak)h->allocation_peak=h->allocated;}
static void *tracked_malloc(JSMallocState *s,size_t size){
 if(!size||size>SIZE_MAX-sizeof(AllocationHeader))return NULL;size_t total=size+sizeof(AllocationHeader);if(total>s->malloc_limit||s->malloc_size>s->malloc_limit-total)return NULL;
 AllocationHeader *p=malloc(total);if(!p)return NULL;p->size=size;s->malloc_count++;s->malloc_size+=total;account(s);return p+1;
}
static void tracked_free(JSMallocState *s,void *ptr){if(!ptr)return;AllocationHeader *p=(AllocationHeader*)ptr-1;s->malloc_count--;s->malloc_size-=p->size+sizeof(AllocationHeader);free(p);account(s);}
static void *tracked_realloc(JSMallocState *s,void *ptr,size_t size){
 if(!ptr)return tracked_malloc(s,size);if(!size){tracked_free(s,ptr);return NULL;}if(size>SIZE_MAX-sizeof(AllocationHeader))return NULL;
 AllocationHeader *p=(AllocationHeader*)ptr-1;size_t old=p->size+sizeof(AllocationHeader),total=size+sizeof(AllocationHeader),remaining=s->malloc_size-old;if(total>s->malloc_limit||remaining>s->malloc_limit-total)return NULL;
 p=realloc(p,total);if(!p)return NULL;p->size=size;s->malloc_size=remaining+total;account(s);return p+1;
}
static size_t tracked_usable(const void *ptr){return ptr?((const AllocationHeader*)ptr-1)->size:0;}
static const JSMallocFunctions tracked_allocator={tracked_malloc,tracked_free,tracked_realloc,tracked_usable};
#endif
static AsterHost *enter(JNIEnv *env,jlong handle){AsterHost *h=(void*)(intptr_t)handle;if(!h)return NULL;h->env=env;
#if BAROCHART_WITH_QUICKJS
 if(h->backend==BACKEND_QUICKJS)JS_UpdateStackTop(h->runtime);
#endif
 return h;
}
static void fail(JNIEnv *env,const char *message);
static char *utf8_n(JNIEnv *env,jstring text,size_t limit,size_t *written){
 if(!text||(*env)->ExceptionCheck(env))return NULL;if((size_t)(*env)->GetStringLength(env,text)>limit){fail(env,"Native argument size limit");return NULL;}
 jclass string=(*env)->FindClass(env,"java/lang/String");if(!string)return NULL;jmethodID encode=(*env)->GetMethodID(env,string,"getBytes","(Ljava/lang/String;)[B");if(!encode)return NULL;jstring charset=(*env)->NewStringUTF(env,"UTF-8");if(!charset)return NULL;
 jbyteArray bytes=(*env)->CallObjectMethod(env,text,encode,charset);if(!bytes||(*env)->ExceptionCheck(env))return NULL;jsize n=(*env)->GetArrayLength(env,bytes);if((size_t)n>limit){fail(env,"Native argument size limit");return NULL;}char *result=malloc((size_t)n+1);if(result){(*env)->GetByteArrayRegion(env,bytes,0,n,(jbyte*)result);if((*env)->ExceptionCheck(env)){free(result);result=NULL;}else{result[n]=0;if(written)*written=(size_t)n;}}(*env)->DeleteLocalRef(env,bytes);(*env)->DeleteLocalRef(env,charset);return result;
}
static char *utf8(JNIEnv *env,jstring text,size_t limit){return utf8_n(env,text,limit,NULL);}
#if BAROCHART_WITH_RUST
/* utf8() already enforced the complete Java string's byte limit. Source QuickJS
 * JS_NewString sees the C string up to its first NUL; quote those same bytes. */
static size_t json_quote_utf8_n(char *dst,size_t capacity,const char *src,size_t length){
 static const char hex[]="0123456789abcdef";size_t n=0;
 if(capacity<3)return 0;dst[n++]='"';
 for(const unsigned char *p=(const unsigned char*)src,*end=p+length;p<end;p++){
  size_t needed=*p<0x20?6:(*p=='"'||*p=='\\'?2:1);if(needed>capacity-n-2)return 0;
  if(*p<0x20){dst[n++]='\\';dst[n++]='u';dst[n++]='0';dst[n++]='0';dst[n++]=hex[*p>>4];dst[n++]=hex[*p&15];}
  else {if(*p=='"'||*p=='\\')dst[n++]='\\';dst[n++]=(char)*p;}
 }
 dst[n++]='"';dst[n]=0;return n;
}
static size_t json_quote_utf8(char *dst,size_t capacity,const char *src){return json_quote_utf8_n(dst,capacity,src,strlen(src));}
/* Java's decimal encoding is locale independent and round-trips binary64. */
static char *json_double(JNIEnv *env,jdouble value){
 jclass type=(*env)->FindClass(env,"java/lang/Double");if(!type)return NULL;
 jmethodID encode=(*env)->GetStaticMethodID(env,type,"toString","(D)Ljava/lang/String;");
 jstring text=encode?(*env)->CallStaticObjectMethod(env,type,encode,value):NULL;
 char *result=text?utf8(env,text,64):NULL;
 if(text)(*env)->DeleteLocalRef(env,text);(*env)->DeleteLocalRef(env,type);return result;
}
#endif

/* JSON 파서에 들어가기 전에 깊이만 검사한다. 문자열/이스케이프는 건너뛰고 문법 오류는 기존 파서가 결정한다. */
static int argument_depth_exceeded(const char *text,size_t length){
 int depth=0,in_string=0,escaped=0;
 for(size_t i=0;i<length;i++){
  unsigned char c=(unsigned char)text[i];
  if(in_string){if(escaped)escaped=0;else if(c=='\\')escaped=1;else if(c=='"')in_string=0;}
  else if(c=='"')in_string=1;
  else if(c=='{'||c=='['){if(++depth>64)return 1;}
  else if((c=='}'||c==']')&&depth>0)depth--;
 }
 return 0;
}
static jstring java_string_n(JNIEnv *env,const char *text,size_t length){
 if(!text||(*env)->ExceptionCheck(env))return NULL;jclass string=(*env)->FindClass(env,"java/lang/String");if(!string)return NULL;jmethodID init=(*env)->GetMethodID(env,string,"<init>","([BLjava/lang/String;)V");if(!init)return NULL;if(length>256*1024*1024){fail(env,"Native result size limit");return NULL;}jsize n=(jsize)length;jbyteArray bytes=(*env)->NewByteArray(env,n);if(!bytes)return NULL;(*env)->SetByteArrayRegion(env,bytes,0,n,(const jbyte*)text);if((*env)->ExceptionCheck(env))return NULL;jstring charset=(*env)->NewStringUTF(env,"UTF-8");if(!charset)return NULL;jstring result=(*env)->NewObject(env,string,init,bytes,charset);(*env)->DeleteLocalRef(env,bytes);(*env)->DeleteLocalRef(env,charset);return result;
}
static jstring java_string(JNIEnv *env,const char *text){return text?java_string_n(env,text,strlen(text)):NULL;}
static void fail_jstring(JNIEnv *env,jstring text){if(!text||(*env)->ExceptionCheck(env))return;jclass type=(*env)->FindClass(env,"java/lang/IllegalStateException");if(!type)return;jmethodID init=(*env)->GetMethodID(env,type,"<init>","(Ljava/lang/String;)V");if(!init)return;jthrowable error=(*env)->NewObject(env,type,init,text);if(error)(*env)->Throw(env,error);}
static void fail(JNIEnv *env,const char *message){if((*env)->ExceptionCheck(env))return;jstring text=java_string(env,message?message:"QuickJS error");if(!text)return;fail_jstring(env,text);(*env)->DeleteLocalRef(env,text);}
#if BAROCHART_WITH_QUICKJS
static int exception(AsterHost *h,JSValue value){if(!JS_IsException(value))return 0;JSValue e=JS_GetException(h->context);const char *message=JS_ToCString(h->context,e);fail(h->env,message);JS_FreeCString(h->context,message);JS_FreeValue(h->context,e);return 1;}
static JSValue zoned_parts(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 (void)self;AsterHost *h=JS_GetContextOpaque(ctx);if(argc!=2)return JS_ThrowTypeError(ctx,"time and timezone required");int64_t time;if(JS_ToInt64(ctx,&time,argv[0]))return JS_EXCEPTION;const char *zone=JS_ToCString(ctx,argv[1]);if(!zone)return JS_EXCEPTION;
 JNIEnv *env=h->env;jmethodID method=(*env)->GetStaticMethodID(env,h->bridge,"zonedParts","(JLjava/lang/String;)Ljava/lang/String;");jstring input=(*env)->NewStringUTF(env,zone);jstring output=(*env)->CallStaticObjectMethod(env,h->bridge,method,(jlong)time,input);JS_FreeCString(ctx,zone);(*env)->DeleteLocalRef(env,input);
 if((*env)->ExceptionCheck(env)){(*env)->ExceptionClear(env);return JS_ThrowRangeError(ctx,"Invalid timezone/date");}if(!output)return JS_ThrowInternalError(ctx,"Timezone bridge failed");const char *json=(*env)->GetStringUTFChars(env,output,NULL);JSValue result=JS_ParseJSON(ctx,json,strlen(json),"timezone");(*env)->ReleaseStringUTFChars(env,output,json);(*env)->DeleteLocalRef(env,output);return result;
}
#endif
#if BAROCHART_WITH_RUST
static JNIEnv *rust_callback_env(AsterHost *h,int *attached){
 JNIEnv *env=NULL;*attached=0;jint state=(*h->vm)->GetEnv(h->vm,(void**)&env,JNI_VERSION_1_6);if(state==JNI_OK)return env;if(state!=JNI_EDETACHED)return NULL;
 if((*h->vm)->AttachCurrentThread(h->vm,&env,NULL)!=JNI_OK)return NULL;*attached=1;return env;
}
static void rust_callback_done(AsterHost *h,int attached){if(attached)(*h->vm)->DetachCurrentThread(h->vm);}
static int32_t rust_zone_resolve(void *context,const uint8_t *name,size_t length,BcBuf *out){
 AsterHost *h=context;int attached=0;JNIEnv *env=rust_callback_env(h,&attached);if(!env)return 1;jstring input=java_string_n(env,(const char*)name,length),resolved=NULL;int32_t result=1;
 if(input){jmethodID method=(*env)->GetStaticMethodID(env,h->bridge,"zoneResolve","(Ljava/lang/String;)Ljava/lang/String;");if(method)resolved=(*env)->CallStaticObjectMethod(env,h->bridge,method,input);}
 if(!(*env)->ExceptionCheck(env)&&resolved){const char *text=(*env)->GetStringUTFChars(env,resolved,NULL);if(text){result=bc_buf_new_copy((const uint8_t*)text,strlen(text),out)==BC_OK?0:1;(*env)->ReleaseStringUTFChars(env,resolved,text);}}
 if((*env)->ExceptionCheck(env))(*env)->ExceptionClear(env);if(resolved)(*env)->DeleteLocalRef(env,resolved);if(input)(*env)->DeleteLocalRef(env,input);rust_callback_done(h,attached);return result;
}
static int32_t rust_zone_offset(void *context,const uint8_t *zone,size_t length,double epoch_ms,int32_t *out){
 if(!isfinite(epoch_ms)||epoch_ms<-9223372036854775808.0||epoch_ms>=9223372036854775808.0)return 1;AsterHost *h=context;int attached=0;JNIEnv *env=rust_callback_env(h,&attached);if(!env)return 1;jstring input=java_string_n(env,(const char*)zone,length);int32_t result=1;
 if(input){jmethodID method=(*env)->GetStaticMethodID(env,h->bridge,"zoneOffsetSeconds","(JLjava/lang/String;)I");if(method){jint offset=(*env)->CallStaticIntMethod(env,h->bridge,method,(jlong)epoch_ms,input);if(!(*env)->ExceptionCheck(env)){*out=(int32_t)offset;result=0;}}}
 if((*env)->ExceptionCheck(env))(*env)->ExceptionClear(env);if(input)(*env)->DeleteLocalRef(env,input);rust_callback_done(h,attached);return result;
}
static void rust_host_release(void *context){(void)context;}
static int rust_failure(AsterHost *h,BcStatus status,BcBuf body){
 JNIEnv *env=h->env;if(status==BC_OOM_LIMIT||status==BC_OOM_SYSTEM){bc_buf_free(body);fail(env,status==BC_OOM_LIMIT?"InternalError: out of memory":"RangeError: Out of memory");return 1;}jstring envelope=body.ptr?java_string_n(env,(const char*)body.ptr,body.len):NULL,message=NULL;jmethodID method=(*env)->GetStaticMethodID(env,h->bridge,"rustErrorMessage","(ILjava/lang/String;)Ljava/lang/String;");
 if(method)message=(*env)->CallStaticObjectMethod(env,h->bridge,method,(jint)status,envelope);bc_buf_free(body);if(!(*env)->ExceptionCheck(env)&&message)fail_jstring(env,message);if(message)(*env)->DeleteLocalRef(env,message);if(envelope)(*env)->DeleteLocalRef(env,envelope);return 1;
}
static int rust_memory(AsterHost *h){
 BcBuf stats={0};BcStatus status=bc_memory_stats(h->rust,&stats);if(status!=BC_OK)return rust_failure(h,status,stats);size_t live=0,peak=0;int valid=0;if(stats.ptr&&stats.len<SIZE_MAX){char *json=malloc(stats.len+1);if(json){memcpy(json,stats.ptr,stats.len);json[stats.len]=0;const char *live_key="\"requestedLiveBytes\":",*peak_key="\"requestedPeakBytes\":";char *live_at=strstr(json,live_key),*peak_at=strstr(json,peak_key);if(live_at&&peak_at){live=(size_t)strtoull(live_at+strlen(live_key),NULL,10);peak=(size_t)strtoull(peak_at+strlen(peak_key),NULL,10);valid=1;}free(json);}}bc_buf_free(stats);if(!valid){fail(h->env,"Rust memory stats unavailable");return 1;}h->allocated=live;h->allocation_peak=peak;return 0;
}
#endif
JNIEXPORT jlong JNICALL Java_kr_coden_barochart_BaroChartEngine_create(JNIEnv *env,jclass cls,jstring bundle){
#if BAROCHART_WITH_QUICKJS
 AsterHost *h=calloc(1,sizeof(*h));if(!h){fail(env,"Allocation failed");return 0;}h->env=env;h->runtime=JS_NewRuntime2(&tracked_allocator,h);h->context=h->runtime?JS_NewContext(h->runtime):NULL;h->bridge=(*env)->NewGlobalRef(env,cls);if(!h->context||!h->bridge||(*env)->ExceptionCheck(env)){fail(env,"QuickJS context unavailable");goto error;}JS_UpdateStackTop(h->runtime);JS_SetMemoryLimit(h->runtime,768*1024*1024);JS_SetContextOpaque(h->context,h);
 h->backend=BACKEND_QUICKJS;(*env)->GetJavaVM(env,&h->vm);
 JSValue zero=JS_NewInt32(h->context,0),typed=JS_NewTypedArray(h->context,1,&zero,JS_TYPED_ARRAY_FLOAT64);JS_FreeValue(h->context,zero);if(exception(h,typed)){JS_FreeValue(h->context,typed);goto error;}h->float64_class=JS_GetClassID(typed);JS_FreeValue(h->context,typed);
 JSValue global=JS_GetGlobalObject(h->context);JS_SetPropertyStr(h->context,global,"asterZonedParts",JS_NewCFunction(h->context,zoned_parts,"asterZonedParts",2));JS_FreeValue(h->context,global);
 const char *shim="globalThis.nativeRuntime='QuickJS JNI';globalThis.Intl={DateTimeFormat:function(locale,options){this.formatToParts=function(date){return asterZonedParts(date.getTime(),options.timeZone);};}};";
 JSValue result=JS_Eval(h->context,shim,strlen(shim),"timezone-bridge",JS_EVAL_TYPE_GLOBAL);if(exception(h,result)){JS_FreeValue(h->context,result);goto error;}JS_FreeValue(h->context,result);
 char *source=utf8(env,bundle,1024*1024);if(!source){fail(env,"UTF-8 allocation failed");goto error;}result=JS_Eval(h->context,source,strlen(source),"aster-core.js",JS_EVAL_TYPE_GLOBAL);free(source);if(exception(h,result)){JS_FreeValue(h->context,result);goto error;}JS_FreeValue(h->context,result);h->counted=1;atomic_fetch_add_explicit(&live_hosts,1,memory_order_relaxed);atomic_fetch_add_explicit(&created_hosts,1,memory_order_relaxed);return (jlong)(intptr_t)h;
 error:if(h->context)JS_FreeContext(h->context);if(h->runtime)JS_FreeRuntime(h->runtime);if(h->bridge)(*env)->DeleteGlobalRef(env,h->bridge);free(h);return 0;
#else
 (void)cls;(void)bundle;fail(env,"UnavailableError: javaScript backend is not included in this build");return 0;
#endif
}
JNIEXPORT jlong JNICALL Java_kr_coden_barochart_BaroChartEngine_createRust(JNIEnv *env,jclass cls){
#if BAROCHART_WITH_RUST
 AsterHost *h=calloc(1,sizeof(*h));if(!h){fail(env,"Allocation failed");return 0;}h->backend=BACKEND_RUST;h->env=env;(*env)->GetJavaVM(env,&h->vm);h->bridge=(*env)->NewGlobalRef(env,cls);if(!h->bridge||(*env)->ExceptionCheck(env)){fail(env,"Rust engine unavailable");goto error;}
 BcHost host={h,rust_zone_resolve,rust_zone_offset,NULL,rust_host_release};BcBuf body={0};BcStatus status=bc_engine_new_with_limit(&host,805306368,&h->rust,&body);if(status!=BC_OK){rust_failure(h,status,body);goto error;}
 if(rust_memory(h))goto error;h->counted=1;atomic_fetch_add_explicit(&live_hosts,1,memory_order_relaxed);atomic_fetch_add_explicit(&created_hosts,1,memory_order_relaxed);return (jlong)(intptr_t)h;
 error:if(h->rust)bc_engine_free(h->rust);if(h->bridge)(*env)->DeleteGlobalRef(env,h->bridge);free(h);return 0;
#else
 (void)cls;fail(env,"UnavailableError: rust backend is not included in this build");return 0;
#endif
}
JNIEXPORT jstring JNICALL Java_kr_coden_barochart_BaroChartEngine_call(JNIEnv *env,jclass cls,jlong handle,jstring name,jstring arguments){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}char *json=utf8(env,arguments,256*1024*1024);if(!json){fail(env,"UTF-8 allocation failed");return NULL;}size_t json_length=strlen(json);if(argument_depth_exceeded(json,json_length)){free(json);fail(env,"SyntaxError: Native argument depth limit");return NULL;}size_t function_length=0;char *function=utf8_n(env,name,512,&function_length);if(!function){free(json);fail(env,"UTF-8 allocation failed");return NULL;}function_length=strlen(function);
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){BcBuf out={0};BcStatus status=bc_call(h->rust,(const uint8_t*)function,function_length,(const uint8_t*)json,json_length,0,&out);if(status==BC_UNAVAILABLE&&!bc_supports(h->rust,(const uint8_t*)function,function_length)){bc_buf_free(out);free(function);free(json);fail(env,"TypeError: not a function");return NULL;}free(function);free(json);if(status!=BC_OK){rust_failure(h,status,out);return NULL;}jstring result=java_string_n(env,(const char*)out.ptr,out.len);bc_buf_free(out);return result;}
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue args=JS_ParseJSON(ctx,json,json_length,"arguments");free(json);if(exception(h,args)){free(function);JS_FreeValue(ctx,args);return NULL;}
 JSValue length=JS_GetPropertyStr(ctx,args,"length");uint32_t count=0;JS_ToUint32(ctx,&count,length);JS_FreeValue(ctx,length);if(count>16){free(function);JS_FreeValue(ctx,args);fail(env,"At most 16 arguments");return NULL;}JSValue argv[16];for(uint32_t i=0;i<count;i++)argv[i]=JS_GetPropertyUint32(ctx,args,i);
 JSValue global=JS_GetGlobalObject(ctx);JSValue fn=JS_GetPropertyStr(ctx,global,function);free(function);JSValue value=JS_Call(ctx,fn,global,count,argv);JS_FreeValue(ctx,fn);JS_FreeValue(ctx,global);for(uint32_t i=0;i<count;i++)JS_FreeValue(ctx,argv[i]);JS_FreeValue(ctx,args);
 if(exception(h,value)){JS_FreeValue(ctx,value);return NULL;}if(JS_IsUndefined(value)){JS_FreeValue(ctx,value);value=JS_NULL;}JSValue encoded=JS_JSONStringify(ctx,value,JS_UNDEFINED,JS_UNDEFINED);JS_FreeValue(ctx,value);if(exception(h,encoded)){JS_FreeValue(ctx,encoded);return NULL;}const char *text=JS_ToCString(ctx,encoded);jstring output=text?java_string(env,text):NULL;JS_FreeCString(ctx,text);JS_FreeValue(ctx,encoded);return output;
#else
 free(function);free(json);fail(env,"UnavailableError: javaScript backend is not included in this build");return NULL;
#endif
}
JNIEXPORT void JNICALL Java_kr_coden_barochart_BaroChartEngine_free(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h)return;
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST)bc_engine_free(h->rust);
#endif
#if BAROCHART_WITH_QUICKJS
 if(h->backend==BACKEND_QUICKJS){JS_FreeContext(h->context);JS_FreeRuntime(h->runtime);}
#endif
 (*env)->DeleteGlobalRef(env,h->bridge);if(h->counted){atomic_fetch_sub_explicit(&live_hosts,1,memory_order_relaxed);atomic_fetch_add_explicit(&freed_hosts,1,memory_order_relaxed);}free(h);}

#if BAROCHART_WITH_QUICKJS
static JSValue typed_call(AsterHost *h,const char *name,int argc,JSValue *argv){JSContext *ctx=h->context;JSValue global=JS_GetGlobalObject(ctx),fn=JS_GetPropertyStr(ctx,global,name),value=JS_Call(ctx,fn,global,argc,argv);JS_FreeValue(ctx,fn);JS_FreeValue(ctx,global);for(int i=0;i<argc;i++)JS_FreeValue(ctx,argv[i]);return value;}
static uint8_t *typed_bytes(AsterHost *h,JSValue value,size_t expected,JSValue *buffer){
 JSContext *ctx=h->context;if(JS_GetClassID(value)!=h->float64_class){fail(h->env,"Async helper must return an intrinsic Float64Array");return NULL;}
 size_t offset=0,length=0,element=0,size=0;*buffer=JS_GetTypedArrayBuffer(ctx,value,&offset,&length,&element);if(exception(h,*buffer))return NULL;
 uint8_t *base=JS_GetArrayBuffer(ctx,&size,*buffer);if((!base&&size!=0)||element!=sizeof(double)||length!=expected||offset>size||length>size-offset){if(!(*h->env)->ExceptionCheck(h->env)){if(!base){JSValue error=JS_GetException(ctx);JS_FreeValue(ctx,error);}fail(h->env,"Async Float64Array byte length/bounds mismatch");}return NULL;}return base?base+offset:NULL;
}
#endif
/* Private display transport. Only owned Java arrays leave this JNI call; no
 * QuickJS buffer/global reference survives. The Java decoder validates records. */
JNIEXPORT jobjectArray JNICALL Java_kr_coden_barochart_BaroChartEngine_packet(JNIEnv *env,jclass cls,jlong handle,jstring mode,jstring token,jdouble width,jdouble height,jboolean force){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}
 if(!isfinite(width)||!isfinite(height)||width<=0||height<=0||width>16384||height>16384||width*height>33554432){fail(env,"Native packet extent");return NULL;}
 size_t kind_length=0,identity_length=0;char *kind=utf8_n(env,mode,16,&kind_length),*identity=token?utf8_n(env,token,512,&identity_length):NULL;if(!kind||(token&&!identity)){free(kind);free(identity);fail(env,"Native packet UTF-8 arguments");return NULL;}
 if(kind_length!=5||(memcmp(kind,"scene",5)&&memcmp(kind,"frame",5))||(!memcmp(kind,"frame",5)&&(!identity||identity_length<1||(*env)->GetStringLength(env,token)>128))){free(kind);free(identity);fail(env,"Native packet mode/token");return NULL;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){
  char args[2*(512*6+2)+192];size_t at=0;args[at++]='[';
  size_t quoted=json_quote_utf8_n(args+at,sizeof(args)-at,kind,kind_length);free(kind);if(!quoted){free(identity);fail(env,"Native packet UTF-8 arguments");return NULL;}at+=quoted;args[at++]=',';
  if(identity){quoted=json_quote_utf8_n(args+at,sizeof(args)-at,identity,identity_length);free(identity);if(!quoted){fail(env,"Native packet UTF-8 arguments");return NULL;}at+=quoted;}
  else{memcpy(args+at,"null",4);at+=4;}
  char *w=json_double(env,width),*htext=json_double(env,height);if(!w||!htext){free(w);free(htext);if(!(*env)->ExceptionCheck(env))fail(env,"Native packet UTF-8 arguments");return NULL;}
  int n=snprintf(args+at,sizeof(args)-at,",%s,%s,%s]",w,htext,force?"true":"false");free(w);free(htext);if(n<0||(size_t)n>=sizeof(args)-at){fail(env,"Native packet UTF-8 arguments");return NULL;}at+=(size_t)n;
  BcBuf metadata={0};BcF64Buf numbers={0};BcStatus status=bc_packet(h->rust,(const uint8_t*)args,at,&metadata,&numbers);if(status!=BC_OK){bc_f64_buf_free(numbers);rust_failure(h,status,metadata);return NULL;}if(metadata.len>1048576||numbers.len>8388608||(numbers.ptr&&(uintptr_t)numbers.ptr%_Alignof(double))){bc_buf_free(metadata);bc_f64_buf_free(numbers);fail(env,"Native packet Float64Array bounds/byte budget");return NULL;}jstring java_metadata=java_string_n(env,(const char*)metadata.ptr,metadata.len);jdoubleArray java_numbers=(*env)->NewDoubleArray(env,(jsize)numbers.len);if(java_numbers&&numbers.len)(*env)->SetDoubleArrayRegion(env,java_numbers,0,(jsize)numbers.len,numbers.ptr);jobjectArray output=NULL;if(java_metadata&&java_numbers&&!(*env)->ExceptionCheck(env)){jclass object=(*env)->FindClass(env,"java/lang/Object");if(object){output=(*env)->NewObjectArray(env,2,object,NULL);(*env)->DeleteLocalRef(env,object);}if(output){(*env)->SetObjectArrayElement(env,output,0,java_metadata);if(!(*env)->ExceptionCheck(env))(*env)->SetObjectArrayElement(env,output,1,java_numbers);}}if(java_metadata)(*env)->DeleteLocalRef(env,java_metadata);if(java_numbers)(*env)->DeleteLocalRef(env,java_numbers);bc_buf_free(metadata);bc_f64_buf_free(numbers);return (*env)->ExceptionCheck(env)?NULL:output;}
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue argv[]={JS_NewStringLen(ctx,kind,kind_length),identity?JS_NewStringLen(ctx,identity,identity_length):JS_NULL,JS_NewFloat64(ctx,width),JS_NewFloat64(ctx,height),JS_NewBool(ctx,force)};free(kind);free(identity);
 JSValue value=typed_call(h,"nativeScenePacket",5,argv),metadata=JS_UNDEFINED,numbers=JS_UNDEFINED,buffer=JS_UNDEFINED;const char *text=NULL;jobjectArray output=NULL;jstring java_metadata=NULL;jdoubleArray java_numbers=NULL;
 if(exception(h,value))goto done;if(!JS_IsObject(value)){fail(env,"Native packet object required");goto done;}
 metadata=JS_GetPropertyStr(ctx,value,"metadata");if(exception(h,metadata))goto done;if(!JS_IsString(metadata)){fail(env,"Native packet metadata string required");goto done;}
 size_t text_length=0;text=JS_ToCStringLen(ctx,&text_length,metadata);if(!text){exception(h,JS_EXCEPTION);goto done;}if(text_length>1048576){fail(env,"Native packet metadata byte budget");goto done;}
 numbers=JS_GetPropertyStr(ctx,value,"numbers");if(exception(h,numbers))goto done;if(JS_GetClassID(numbers)!=h->float64_class){fail(env,"Native packet intrinsic Float64Array required");goto done;}
 size_t offset=0,length=0,element=0,extent=0;buffer=JS_GetTypedArrayBuffer(ctx,numbers,&offset,&length,&element);if(exception(h,buffer))goto done;
 uint8_t *base=JS_GetArrayBuffer(ctx,&extent,buffer);if((!base&&extent!=0)||element!=sizeof(double)||length%sizeof(double)||length>67108864||offset>extent||length>extent-offset||offset%sizeof(double)){fail(env,"Native packet Float64Array bounds/byte budget");goto done;}
 java_metadata=java_string_n(env,text,text_length);if(!java_metadata||(*env)->ExceptionCheck(env))goto done;jsize count=(jsize)(length/sizeof(double));java_numbers=(*env)->NewDoubleArray(env,count);if(!java_numbers)goto done;
 if(count)(*env)->SetDoubleArrayRegion(env,java_numbers,0,count,(const jdouble*)(base+offset));if((*env)->ExceptionCheck(env))goto done;
 jclass object=(*env)->FindClass(env,"java/lang/Object");if(!object)goto done;output=(*env)->NewObjectArray(env,2,object,NULL);(*env)->DeleteLocalRef(env,object);if(!output)goto done;
 (*env)->SetObjectArrayElement(env,output,0,java_metadata);if(!(*env)->ExceptionCheck(env))(*env)->SetObjectArrayElement(env,output,1,java_numbers);
 done:if(java_metadata)(*env)->DeleteLocalRef(env,java_metadata);if(java_numbers)(*env)->DeleteLocalRef(env,java_numbers);JS_FreeCString(ctx,text);JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,numbers);JS_FreeValue(ctx,metadata);JS_FreeValue(ctx,value);return (*env)->ExceptionCheck(env)?NULL:output;
#else
 free(kind);free(identity);fail(env,"UnavailableError: javaScript backend is not included in this build");return NULL;
#endif
}
JNIEXPORT jbyteArray JNICALL Java_kr_coden_barochart_BaroChartEngine_readBuffer(JNIEnv *env,jclass cls,jlong handle,jlong ticket,jint slot,jint offset,jint count){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}if(ticket<0||slot<0||slot>=2048||offset<0||count<1||count>262144||(int64_t)offset+count>33554432){fail(env,"Async buffer read bounds");return NULL;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){size_t length=(size_t)count*sizeof(double);double *values=malloc(length);if(!values){fail(env,"Async copy allocation failed");return NULL;}char args[128];int n=snprintf(args,sizeof(args),"[%lld,%d,%d,%d]",(long long)ticket,(int)slot,(int)offset,(int)count);BcBuf error={0};BcStatus status=n>0&&(size_t)n<sizeof(args)?bc_read_f64(h->rust,(const uint8_t*)"nativeAsyncBuffer",17,(const uint8_t*)args,(size_t)n,values,(size_t)count,&error):BC_INVALID;if(status!=BC_OK){free(values);rust_failure(h,status,error);return NULL;}jbyteArray bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)values);free(values);return (*env)->ExceptionCheck(env)?NULL:bytes;}
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt64(ctx,ticket),JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};JSValue value=typed_call(h,"nativeAsyncBuffer",4,argv),buffer=JS_UNDEFINED;jbyteArray bytes=NULL;
 if(!exception(h,value)){size_t length=(size_t)count*sizeof(double);uint8_t *source=typed_bytes(h,value,length,&buffer);if(source){bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)source);}}
 JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);return (*env)->ExceptionCheck(env)?NULL:bytes;
#else
 fail(env,"UnavailableError: javaScript backend is not included in this build");return NULL;
#endif
}
JNIEXPORT void JNICALL Java_kr_coden_barochart_BaroChartEngine_writeBuffer(JNIEnv *env,jclass cls,jlong handle,jint slot,jint offset,jbyteArray bytes){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return;}if(!bytes){fail(env,"Async buffer bytes required");return;}jsize length=(*env)->GetArrayLength(env,bytes);if(slot<0||slot>=2048||offset<0||length<8||length>2097152||length%8||(int64_t)offset+length/8>33554432){fail(env,"Async buffer write bounds");return;}
 uint8_t *copy=malloc((size_t)length);if(!copy){fail(env,"Async copy allocation failed");return;}(*env)->GetByteArrayRegion(env,bytes,0,length,(jbyte*)copy);if((*env)->ExceptionCheck(env)){free(copy);return;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){char args[96];int n=snprintf(args,sizeof(args),"[%d,%d,%d]",(int)slot,(int)offset,(int)(length/8));BcBuf error={0};BcStatus status=n>0&&(size_t)n<sizeof(args)?bc_write_f64(h->rust,(const uint8_t*)"nativeAsyncTargetBuffer",23,(const uint8_t*)args,(size_t)n,(const double*)copy,(size_t)length/8,&error):BC_INVALID;free(copy);if(status!=BC_OK)rust_failure(h,status,error);return;}
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,length/8)};JSValue value=typed_call(h,"nativeAsyncTargetBuffer",3,argv),buffer=JS_UNDEFINED;
 if(!exception(h,value)){uint8_t *target=typed_bytes(h,value,(size_t)length,&buffer);if(target)memcpy(target,copy,(size_t)length);}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);free(copy);
#else
 free(copy);fail(env,"UnavailableError: javaScript backend is not included in this build");
#endif
}
JNIEXPORT jlong JNICALL Java_kr_coden_barochart_BaroChartEngine_memoryUsed(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return 0;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST&&rust_memory(h))return 0;
#endif
 return (jlong)h->allocated;}
JNIEXPORT jlong JNICALL Java_kr_coden_barochart_BaroChartEngine_memoryPeak(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return 0;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST&&rust_memory(h))return 0;
#endif
 return (jlong)h->allocation_peak;}
JNIEXPORT jlongArray JNICALL Java_kr_coden_barochart_BaroChartEngine_memoryStats(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST&&rust_memory(h))return NULL;
#endif
 jlong values[]={(jlong)h->allocated,(jlong)h->allocation_peak,(jlong)atomic_load_explicit(&live_hosts,memory_order_relaxed),(jlong)atomic_load_explicit(&created_hosts,memory_order_relaxed),(jlong)atomic_load_explicit(&freed_hosts,memory_order_relaxed)};jlongArray result=(*env)->NewLongArray(env,5);if(result)(*env)->SetLongArrayRegion(env,result,0,5,values);return result;}
JNIEXPORT void JNICALL Java_kr_coden_barochart_BaroChartColumns_writeSlice(JNIEnv *env,jclass cls,jlong handle,jint slot,jint offset,jint count,jdoubleArray values){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return;}if(!values){fail(env,"Owned input column required");return;}jsize length=(*env)->GetArrayLength(env,values);if(slot<0||slot>=6||offset<0||count<1||count>262144||(int64_t)offset+count>length){fail(env,"Prepare column slice bounds");return;}
 size_t byte_length=(size_t)count*sizeof(jdouble);jdouble *copy=malloc(byte_length);if(!copy){fail(env,"Prepare input allocation failed");return;}(*env)->GetDoubleArrayRegion(env,values,offset,count,copy);if((*env)->ExceptionCheck(env)){free(copy);return;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){char args[96];int n=snprintf(args,sizeof(args),"[%d,%d,%d]",(int)slot,(int)offset,(int)count);BcBuf error={0};BcStatus status=n>0&&(size_t)n<sizeof(args)?bc_write_f64(h->rust,(const uint8_t*)"nativeAsyncTargetBuffer",23,(const uint8_t*)args,(size_t)n,copy,(size_t)count,&error):BC_INVALID;free(copy);if(status!=BC_OK)rust_failure(h,status,error);return;}
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};JSValue value=typed_call(h,"nativeAsyncTargetBuffer",3,argv),buffer=JS_UNDEFINED;
 if(!exception(h,value)){uint8_t *target=typed_bytes(h,value,byte_length,&buffer);if(target)memcpy(target,copy,byte_length);}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);free(copy);
#else
 free(copy);fail(env,"UnavailableError: javaScript backend is not included in this build");
#endif
}
JNIEXPORT jbyteArray JNICALL Java_kr_coden_barochart_BaroChartEngine_indicatorSlice(JNIEnv *env,jclass cls,jlong handle,jstring id,jstring output,jint offset,jint count){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}if(offset<0||count<1||count>262144||(int64_t)offset+count>4194304){fail(env,"Indicator byte slice bounds");return NULL;}char *identifier=utf8(env,id,512),*name=utf8(env,output,512);if(!identifier||!name){free(identifier);free(name);fail(env,"Indicator identifier UTF-8 failed");return NULL;}
#if BAROCHART_WITH_RUST
 if(h->backend==BACKEND_RUST){
  char args[2*(512*6+2)+96];size_t at=0;args[at++]='[';
  size_t quoted=json_quote_utf8(args+at,sizeof(args)-at,identifier);free(identifier);if(!quoted){free(name);fail(env,"Indicator identifier UTF-8 failed");return NULL;}at+=quoted;args[at++]=',';
  quoted=json_quote_utf8(args+at,sizeof(args)-at,name);free(name);if(!quoted){fail(env,"Indicator identifier UTF-8 failed");return NULL;}at+=quoted;
  int n=snprintf(args+at,sizeof(args)-at,",%d,%d]",(int)offset,(int)count);if(n<0||(size_t)n>=sizeof(args)-at){fail(env,"Indicator byte slice bounds");return NULL;}at+=(size_t)n;
  size_t length=(size_t)count*sizeof(double);double *values=malloc(length);if(!values){fail(env,"Async copy allocation failed");return NULL;}
  BcBuf error={0};BcStatus status=bc_read_f64(h->rust,(const uint8_t*)"nativeIndicatorBuffer",21,(const uint8_t*)args,at,values,(size_t)count,&error);
  if(status!=BC_OK){free(values);rust_failure(h,status,error);return NULL;}
  jbyteArray bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)values);free(values);return (*env)->ExceptionCheck(env)?NULL:bytes;
 }
#endif
#if BAROCHART_WITH_QUICKJS
 JSContext *ctx=h->context;JSValue argv[]={JS_NewString(ctx,identifier),JS_NewString(ctx,name),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};free(identifier);free(name);JSValue value=typed_call(h,"nativeIndicatorBuffer",4,argv),buffer=JS_UNDEFINED;jbyteArray bytes=NULL;
 if(!exception(h,value)){size_t length=(size_t)count*sizeof(double);uint8_t *source=typed_bytes(h,value,length,&buffer);if(source){bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)source);}}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);return (*env)->ExceptionCheck(env)?NULL:bytes;
#else
 free(identifier);free(name);fail(env,"UnavailableError: javaScript backend is not included in this build");return NULL;
#endif
}

#ifdef ASTER_ALLOCATOR_SELF_TEST
#include <assert.h>
#include <stdio.h>
/* Compile-only opt-in test executable; excluded from the Android shared build. */
int main(void){
 AsterHost host={0};JSMallocState state={.malloc_limit=4096,.opaque=&host};
 void *p=tracked_malloc(&state,127);assert(p&&((uintptr_t)p%_Alignof(max_align_t))==0);assert(tracked_usable(p)==127&&state.malloc_count==1&&host.allocated==127+sizeof(AllocationHeader));
 memset(p,0x5a,127);size_t previous=state.malloc_size;assert(!tracked_realloc(&state,p,5000));assert(state.malloc_size==previous&&((uint8_t*)p)[126]==0x5a);assert(!tracked_malloc(&state,SIZE_MAX));
 p=tracked_realloc(&state,p,255);assert(p&&((uint8_t*)p)[126]==0x5a&&tracked_usable(p)==255&&host.allocation_peak==255+sizeof(AllocationHeader));
 p=tracked_realloc(&state,p,31);assert(p&&state.malloc_count==1&&host.allocated==31+sizeof(AllocationHeader));assert(!tracked_realloc(&state,p,0)&&state.malloc_count==0&&host.allocated==0);
 state.malloc_limit=sizeof(AllocationHeader)+8;assert(!tracked_malloc(&state,9));p=tracked_malloc(&state,8);assert(p);assert(!tracked_malloc(&state,1));tracked_free(&state,p);assert(!host.allocated&&!state.malloc_count);
 host.runtime=JS_NewRuntime2(&tracked_allocator,&host);assert(host.runtime);host.context=JS_NewContext(host.runtime);assert(host.context);JSValue count=JS_NewInt32(host.context,16),value=JS_NewTypedArray(host.context,1,&count,JS_TYPED_ARRAY_FLOAT64);assert(!JS_IsException(value));
 JS_FreeValue(host.context,value);JS_FreeValue(host.context,count);JS_FreeContext(host.context);JS_FreeRuntime(host.runtime);assert(host.allocated==0);
 puts("allocator alignment/overflow/quota/realloc preservation/live+peak/runtime cleanup: 8 checks passed");return 0;
}
#endif
