#include <jni.h>
#include <string.h>

static jint created_count;
static jint freed_count;
static jint live_count;
static jint init_calls;
static jint command_calls;
static jint release_frame_calls;
static jboolean fail_free;

JNIEXPORT jlong JNICALL Java_dev_aster_charts_AsterEngine_create(JNIEnv *env,jclass cls,jstring source){
    (void)env;(void)cls;(void)source;created_count++;live_count++;return (jlong)created_count;
}

JNIEXPORT jstring JNICALL Java_dev_aster_charts_AsterEngine_call(JNIEnv *env,jclass cls,jlong handle,jstring name,jstring arguments){
    (void)cls;(void)handle;(void)arguments;
    const char *function=(*env)->GetStringUTFChars(env,name,NULL);
    if(function==NULL)return NULL;
    if(strcmp(function,"nativeInit")==0)init_calls++;
    else if(strcmp(function,"nativeCommand")==0)command_calls++;
    else if(strcmp(function,"nativeReleaseFrameCache")==0)release_frame_calls++;
    (*env)->ReleaseStringUTFChars(env,name,function);
    return (*env)->NewStringUTF(env,"true");
}

JNIEXPORT void JNICALL Java_dev_aster_charts_AsterEngine_free(JNIEnv *env,jclass cls,jlong handle){
    (void)cls;(void)handle;freed_count++;if(live_count>0)live_count--;
    if(fail_free){jclass type=(*env)->FindClass(env,"java/lang/AssertionError");if(type!=NULL)(*env)->ThrowNew(env,type,"fixture free failure");}
}

JNIEXPORT void JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeReset(JNIEnv *env,jclass cls){
    (void)env;(void)cls;created_count=freed_count=live_count=init_calls=command_calls=release_frame_calls=0;fail_free=JNI_FALSE;
}
JNIEXPORT void JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeFailFree(JNIEnv *env,jclass cls,jboolean value){(void)env;(void)cls;fail_free=value;}
JNIEXPORT jint JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeCreated(JNIEnv *env,jclass cls){(void)env;(void)cls;return created_count;}
JNIEXPORT jint JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeFreed(JNIEnv *env,jclass cls){(void)env;(void)cls;return freed_count;}
JNIEXPORT jint JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeLive(JNIEnv *env,jclass cls){(void)env;(void)cls;return live_count;}
JNIEXPORT jint JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeCommandCalls(JNIEnv *env,jclass cls){(void)env;(void)cls;return command_calls;}
JNIEXPORT jint JNICALL Java_dev_aster_charts_EngineLifecycleHarness_nativeReleaseFrameCalls(JNIEnv *env,jclass cls){(void)env;(void)cls;return release_frame_calls;}
