package androidx.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 하네스 javac 빌드 전용 컴파일 스텁. SDK AAR에는 들어가지 않는다(Gradle은 compileOnly로 실제 androidx.annotation을 쓴다).
 * 보존 정책과 대상은 androidx.annotation. 같아 Kotlin이 같은 nullability로 읽는다.
 */
@Retention(RetentionPolicy.CLASS)
@Target({ElementType.METHOD, ElementType.PARAMETER, ElementType.FIELD, ElementType.LOCAL_VARIABLE, ElementType.ANNOTATION_TYPE, ElementType.PACKAGE})
public @interface Nullable {}
