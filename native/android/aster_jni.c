#include <jni.h>
#include <stdint.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "quickjs.h"

typedef struct {JSRuntime *runtime; JSContext *context; JNIEnv *env; jclass bridge;JSClassID float64_class;size_t allocated,allocation_peak;int counted;} AsterHost;
static atomic_uint_fast64_t live_hosts,created_hosts,freed_hosts;
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
static AsterHost *enter(JNIEnv *env,jlong handle){AsterHost *h=(void*)(intptr_t)handle;if(!h)return NULL;h->env=env;JS_UpdateStackTop(h->runtime);return h;}
static void fail(JNIEnv *env,const char *message);
static char *utf8_n(JNIEnv *env,jstring text,size_t limit,size_t *written){
 if(!text||(*env)->ExceptionCheck(env))return NULL;if((size_t)(*env)->GetStringLength(env,text)>limit){fail(env,"Native argument size limit");return NULL;}
 jclass string=(*env)->FindClass(env,"java/lang/String");if(!string)return NULL;jmethodID encode=(*env)->GetMethodID(env,string,"getBytes","(Ljava/lang/String;)[B");if(!encode)return NULL;jstring charset=(*env)->NewStringUTF(env,"UTF-8");if(!charset)return NULL;
 jbyteArray bytes=(*env)->CallObjectMethod(env,text,encode,charset);if(!bytes||(*env)->ExceptionCheck(env))return NULL;jsize n=(*env)->GetArrayLength(env,bytes);if((size_t)n>limit){fail(env,"Native argument size limit");return NULL;}char *result=malloc((size_t)n+1);if(result){(*env)->GetByteArrayRegion(env,bytes,0,n,(jbyte*)result);if((*env)->ExceptionCheck(env)){free(result);result=NULL;}else{result[n]=0;if(written)*written=(size_t)n;}}(*env)->DeleteLocalRef(env,bytes);(*env)->DeleteLocalRef(env,charset);return result;
}
static char *utf8(JNIEnv *env,jstring text,size_t limit){return utf8_n(env,text,limit,NULL);}
static jstring java_string_n(JNIEnv *env,const char *text,size_t length){
 if(!text||(*env)->ExceptionCheck(env))return NULL;jclass string=(*env)->FindClass(env,"java/lang/String");if(!string)return NULL;jmethodID init=(*env)->GetMethodID(env,string,"<init>","([BLjava/lang/String;)V");if(!init)return NULL;if(length>256*1024*1024){fail(env,"Native result size limit");return NULL;}jsize n=(jsize)length;jbyteArray bytes=(*env)->NewByteArray(env,n);if(!bytes)return NULL;(*env)->SetByteArrayRegion(env,bytes,0,n,(const jbyte*)text);if((*env)->ExceptionCheck(env))return NULL;jstring charset=(*env)->NewStringUTF(env,"UTF-8");if(!charset)return NULL;jstring result=(*env)->NewObject(env,string,init,bytes,charset);(*env)->DeleteLocalRef(env,bytes);(*env)->DeleteLocalRef(env,charset);return result;
}
static jstring java_string(JNIEnv *env,const char *text){return text?java_string_n(env,text,strlen(text)):NULL;}
static void fail(JNIEnv *env,const char *message){if((*env)->ExceptionCheck(env))return;jclass type=(*env)->FindClass(env,"java/lang/IllegalStateException");if(!type)return;jmethodID init=(*env)->GetMethodID(env,type,"<init>","(Ljava/lang/String;)V");if(!init)return;jstring text=java_string(env,message?message:"QuickJS error");if(!text)return;jthrowable error=(*env)->NewObject(env,type,init,text);if(error)(*env)->Throw(env,error);}
static int exception(AsterHost *h,JSValue value){if(!JS_IsException(value))return 0;JSValue e=JS_GetException(h->context);const char *message=JS_ToCString(h->context,e);fail(h->env,message);JS_FreeCString(h->context,message);JS_FreeValue(h->context,e);return 1;}
static JSValue zoned_parts(JSContext *ctx,JSValueConst self,int argc,JSValueConst *argv){
 (void)self;AsterHost *h=JS_GetContextOpaque(ctx);if(argc!=2)return JS_ThrowTypeError(ctx,"time and timezone required");int64_t time;if(JS_ToInt64(ctx,&time,argv[0]))return JS_EXCEPTION;const char *zone=JS_ToCString(ctx,argv[1]);if(!zone)return JS_EXCEPTION;
 JNIEnv *env=h->env;jmethodID method=(*env)->GetStaticMethodID(env,h->bridge,"zonedParts","(JLjava/lang/String;)Ljava/lang/String;");jstring input=(*env)->NewStringUTF(env,zone);jstring output=(*env)->CallStaticObjectMethod(env,h->bridge,method,(jlong)time,input);JS_FreeCString(ctx,zone);(*env)->DeleteLocalRef(env,input);
 if((*env)->ExceptionCheck(env)){(*env)->ExceptionClear(env);return JS_ThrowRangeError(ctx,"Invalid timezone/date");}if(!output)return JS_ThrowInternalError(ctx,"Timezone bridge failed");const char *json=(*env)->GetStringUTFChars(env,output,NULL);JSValue result=JS_ParseJSON(ctx,json,strlen(json),"timezone");(*env)->ReleaseStringUTFChars(env,output,json);(*env)->DeleteLocalRef(env,output);return result;
}
JNIEXPORT jlong JNICALL Java_dev_aster_charts_AsterEngine_create(JNIEnv *env,jclass cls,jstring bundle){
 AsterHost *h=calloc(1,sizeof(*h));if(!h){fail(env,"Allocation failed");return 0;}h->env=env;h->runtime=JS_NewRuntime2(&tracked_allocator,h);h->context=h->runtime?JS_NewContext(h->runtime):NULL;h->bridge=(*env)->NewGlobalRef(env,cls);if(!h->context||!h->bridge||(*env)->ExceptionCheck(env)){fail(env,"QuickJS context unavailable");goto error;}JS_UpdateStackTop(h->runtime);JS_SetMemoryLimit(h->runtime,768*1024*1024);JS_SetContextOpaque(h->context,h);
 JSValue zero=JS_NewInt32(h->context,0),typed=JS_NewTypedArray(h->context,1,&zero,JS_TYPED_ARRAY_FLOAT64);JS_FreeValue(h->context,zero);if(exception(h,typed)){JS_FreeValue(h->context,typed);goto error;}h->float64_class=JS_GetClassID(typed);JS_FreeValue(h->context,typed);
 JSValue global=JS_GetGlobalObject(h->context);JS_SetPropertyStr(h->context,global,"asterZonedParts",JS_NewCFunction(h->context,zoned_parts,"asterZonedParts",2));JS_FreeValue(h->context,global);
 const char *shim="globalThis.nativeRuntime='QuickJS JNI';globalThis.Intl={DateTimeFormat:function(locale,options){this.formatToParts=function(date){return asterZonedParts(date.getTime(),options.timeZone);};}};";
 JSValue result=JS_Eval(h->context,shim,strlen(shim),"timezone-bridge",JS_EVAL_TYPE_GLOBAL);if(exception(h,result)){JS_FreeValue(h->context,result);goto error;}JS_FreeValue(h->context,result);
 char *source=utf8(env,bundle,1024*1024);if(!source){fail(env,"UTF-8 allocation failed");goto error;}result=JS_Eval(h->context,source,strlen(source),"aster-core.js",JS_EVAL_TYPE_GLOBAL);free(source);if(exception(h,result)){JS_FreeValue(h->context,result);goto error;}JS_FreeValue(h->context,result);h->counted=1;atomic_fetch_add_explicit(&live_hosts,1,memory_order_relaxed);atomic_fetch_add_explicit(&created_hosts,1,memory_order_relaxed);return (jlong)(intptr_t)h;
 error:if(h->context)JS_FreeContext(h->context);if(h->runtime)JS_FreeRuntime(h->runtime);if(h->bridge)(*env)->DeleteGlobalRef(env,h->bridge);free(h);return 0;
}
JNIEXPORT jstring JNICALL Java_dev_aster_charts_AsterEngine_call(JNIEnv *env,jclass cls,jlong handle,jstring name,jstring arguments){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}JSContext *ctx=h->context;char *json=utf8(env,arguments,256*1024*1024);if(!json){fail(env,"UTF-8 allocation failed");return NULL;}JSValue args=JS_ParseJSON(ctx,json,strlen(json),"arguments");free(json);if(exception(h,args)){JS_FreeValue(ctx,args);return NULL;}
 JSValue length=JS_GetPropertyStr(ctx,args,"length");uint32_t count=0;JS_ToUint32(ctx,&count,length);JS_FreeValue(ctx,length);if(count>16){JS_FreeValue(ctx,args);fail(env,"At most 16 arguments");return NULL;}JSValue argv[16];for(uint32_t i=0;i<count;i++)argv[i]=JS_GetPropertyUint32(ctx,args,i);
 JSValue global=JS_GetGlobalObject(ctx);const char *function=(*env)->GetStringUTFChars(env,name,NULL);if(!function){for(uint32_t i=0;i<count;i++)JS_FreeValue(ctx,argv[i]);JS_FreeValue(ctx,args);JS_FreeValue(ctx,global);return NULL;}JSValue fn=JS_GetPropertyStr(ctx,global,function);(*env)->ReleaseStringUTFChars(env,name,function);JSValue result=JS_Call(ctx,fn,global,count,argv);JS_FreeValue(ctx,fn);JS_FreeValue(ctx,global);for(uint32_t i=0;i<count;i++)JS_FreeValue(ctx,argv[i]);JS_FreeValue(ctx,args);
 if(exception(h,result)){JS_FreeValue(ctx,result);return NULL;}if(JS_IsUndefined(result)){JS_FreeValue(ctx,result);result=JS_NULL;}JSValue encoded=JS_JSONStringify(ctx,result,JS_UNDEFINED,JS_UNDEFINED);JS_FreeValue(ctx,result);if(exception(h,encoded)){JS_FreeValue(ctx,encoded);return NULL;}const char *text=JS_ToCString(ctx,encoded);jstring output=text?java_string(env,text):NULL;JS_FreeCString(ctx,text);JS_FreeValue(ctx,encoded);return output;
}
JNIEXPORT void JNICALL Java_dev_aster_charts_AsterEngine_free(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h)return;JS_FreeContext(h->context);JS_FreeRuntime(h->runtime);(*env)->DeleteGlobalRef(env,h->bridge);if(h->counted){atomic_fetch_sub_explicit(&live_hosts,1,memory_order_relaxed);atomic_fetch_add_explicit(&freed_hosts,1,memory_order_relaxed);}free(h);}

static JSValue typed_call(AsterHost *h,const char *name,int argc,JSValue *argv){JSContext *ctx=h->context;JSValue global=JS_GetGlobalObject(ctx),fn=JS_GetPropertyStr(ctx,global,name),value=JS_Call(ctx,fn,global,argc,argv);JS_FreeValue(ctx,fn);JS_FreeValue(ctx,global);for(int i=0;i<argc;i++)JS_FreeValue(ctx,argv[i]);return value;}
static uint8_t *typed_bytes(AsterHost *h,JSValue value,size_t expected,JSValue *buffer){
 JSContext *ctx=h->context;if(JS_GetClassID(value)!=h->float64_class){fail(h->env,"Async helper must return an intrinsic Float64Array");return NULL;}
 size_t offset=0,length=0,element=0,size=0;*buffer=JS_GetTypedArrayBuffer(ctx,value,&offset,&length,&element);if(exception(h,*buffer))return NULL;
 uint8_t *base=JS_GetArrayBuffer(ctx,&size,*buffer);if((!base&&size!=0)||element!=sizeof(double)||length!=expected||offset>size||length>size-offset){if(!(*h->env)->ExceptionCheck(h->env)){if(!base){JSValue error=JS_GetException(ctx);JS_FreeValue(ctx,error);}fail(h->env,"Async Float64Array byte length/bounds mismatch");}return NULL;}return base?base+offset:NULL;
}
/* Private display transport. Only owned Java arrays leave this JNI call; no
 * QuickJS buffer/global reference survives. The Java decoder validates records. */
JNIEXPORT jobjectArray JNICALL Java_dev_aster_charts_AsterEngine_packet(JNIEnv *env,jclass cls,jlong handle,jstring mode,jstring token,jdouble width,jdouble height,jboolean force){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}
 if(!isfinite(width)||!isfinite(height)||width<=0||height<=0||width>16384||height>16384||width*height>33554432){fail(env,"Native packet extent");return NULL;}
 size_t kind_length=0,identity_length=0;char *kind=utf8_n(env,mode,16,&kind_length),*identity=token?utf8_n(env,token,512,&identity_length):NULL;if(!kind||(token&&!identity)){free(kind);free(identity);fail(env,"Native packet UTF-8 arguments");return NULL;}
 if(kind_length!=5||(memcmp(kind,"scene",5)&&memcmp(kind,"frame",5))||(!memcmp(kind,"frame",5)&&(!identity||identity_length<1||(*env)->GetStringLength(env,token)>128))){free(kind);free(identity);fail(env,"Native packet mode/token");return NULL;}
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
}
JNIEXPORT jbyteArray JNICALL Java_dev_aster_charts_AsterEngine_readBuffer(JNIEnv *env,jclass cls,jlong handle,jlong ticket,jint slot,jint offset,jint count){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}if(ticket<0||slot<0||slot>=2048||offset<0||count<1||count>262144||(int64_t)offset+count>33554432){fail(env,"Async buffer read bounds");return NULL;}
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt64(ctx,ticket),JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};JSValue value=typed_call(h,"nativeAsyncBuffer",4,argv),buffer=JS_UNDEFINED;jbyteArray bytes=NULL;
 if(!exception(h,value)){size_t length=(size_t)count*sizeof(double);uint8_t *source=typed_bytes(h,value,length,&buffer);if(source){bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)source);}}
 JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);return (*env)->ExceptionCheck(env)?NULL:bytes;
}
JNIEXPORT void JNICALL Java_dev_aster_charts_AsterEngine_writeBuffer(JNIEnv *env,jclass cls,jlong handle,jint slot,jint offset,jbyteArray bytes){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return;}if(!bytes){fail(env,"Async buffer bytes required");return;}jsize length=(*env)->GetArrayLength(env,bytes);if(slot<0||slot>=2048||offset<0||length<8||length>2097152||length%8||(int64_t)offset+length/8>33554432){fail(env,"Async buffer write bounds");return;}
 uint8_t *copy=malloc((size_t)length);if(!copy){fail(env,"Async copy allocation failed");return;}(*env)->GetByteArrayRegion(env,bytes,0,length,(jbyte*)copy);if((*env)->ExceptionCheck(env)){free(copy);return;}
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,length/8)};JSValue value=typed_call(h,"nativeAsyncTargetBuffer",3,argv),buffer=JS_UNDEFINED;
 if(!exception(h,value)){uint8_t *target=typed_bytes(h,value,(size_t)length,&buffer);if(target)memcpy(target,copy,(size_t)length);}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);free(copy);
}
JNIEXPORT jlong JNICALL Java_dev_aster_charts_AsterEngine_memoryUsed(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return 0;}return (jlong)h->allocated;}
JNIEXPORT jlong JNICALL Java_dev_aster_charts_AsterEngine_memoryPeak(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return 0;}return (jlong)h->allocation_peak;}
JNIEXPORT jlongArray JNICALL Java_dev_aster_charts_AsterEngine_memoryStats(JNIEnv *env,jclass cls,jlong handle){(void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}jlong values[]={(jlong)h->allocated,(jlong)h->allocation_peak,(jlong)atomic_load_explicit(&live_hosts,memory_order_relaxed),(jlong)atomic_load_explicit(&created_hosts,memory_order_relaxed),(jlong)atomic_load_explicit(&freed_hosts,memory_order_relaxed)};jlongArray result=(*env)->NewLongArray(env,5);if(result)(*env)->SetLongArrayRegion(env,result,0,5,values);return result;}
JNIEXPORT void JNICALL Java_dev_aster_charts_AsterColumns_writeSlice(JNIEnv *env,jclass cls,jlong handle,jint slot,jint offset,jint count,jdoubleArray values){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return;}if(!values){fail(env,"Owned input column required");return;}jsize length=(*env)->GetArrayLength(env,values);if(slot<0||slot>=6||offset<0||count<1||count>262144||(int64_t)offset+count>length){fail(env,"Prepare column slice bounds");return;}
 size_t byte_length=(size_t)count*sizeof(jdouble);jdouble *copy=malloc(byte_length);if(!copy){fail(env,"Prepare input allocation failed");return;}(*env)->GetDoubleArrayRegion(env,values,offset,count,copy);if((*env)->ExceptionCheck(env)){free(copy);return;}
 JSContext *ctx=h->context;JSValue argv[]={JS_NewInt32(ctx,slot),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};JSValue value=typed_call(h,"nativeAsyncTargetBuffer",3,argv),buffer=JS_UNDEFINED;
 if(!exception(h,value)){uint8_t *target=typed_bytes(h,value,byte_length,&buffer);if(target)memcpy(target,copy,byte_length);}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);free(copy);
}
JNIEXPORT jbyteArray JNICALL Java_dev_aster_charts_AsterEngine_indicatorSlice(JNIEnv *env,jclass cls,jlong handle,jstring id,jstring output,jint offset,jint count){
 (void)cls;AsterHost *h=enter(env,handle);if(!h){fail(env,"Engine closed");return NULL;}if(offset<0||count<1||count>262144||(int64_t)offset+count>4194304){fail(env,"Indicator byte slice bounds");return NULL;}char *identifier=utf8(env,id,512),*name=utf8(env,output,512);if(!identifier||!name){free(identifier);free(name);fail(env,"Indicator identifier UTF-8 failed");return NULL;}
 JSContext *ctx=h->context;JSValue argv[]={JS_NewString(ctx,identifier),JS_NewString(ctx,name),JS_NewInt32(ctx,offset),JS_NewInt32(ctx,count)};free(identifier);free(name);JSValue value=typed_call(h,"nativeIndicatorBuffer",4,argv),buffer=JS_UNDEFINED;jbyteArray bytes=NULL;
 if(!exception(h,value)){size_t length=(size_t)count*sizeof(double);uint8_t *source=typed_bytes(h,value,length,&buffer);if(source){bytes=(*env)->NewByteArray(env,(jsize)length);if(bytes)(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)source);}}JS_FreeValue(ctx,buffer);JS_FreeValue(ctx,value);return (*env)->ExceptionCheck(env)?NULL:bytes;
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
