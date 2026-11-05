cmake_minimum_required(VERSION 3.22.1)
project(barochart_android C)

option(WITH_QUICKJS "Build the bundled QuickJS backend" ON)
option(WITH_RUST "Link the Rust core backend" ON)
set(BAROCHART_RUST_LIB "" CACHE PATH "Rust target directory containing Android static libraries")

if(NOT WITH_QUICKJS AND NOT WITH_RUST)
    message(FATAL_ERROR "At least one BaroChart backend must be enabled")
endif()

set(BAROCHART_SOURCES ../aster_jni.c)
if(WITH_QUICKJS)
    list(APPEND BAROCHART_SOURCES
        ../quickjs/quickjs.c
        ../quickjs/dtoa.c
        ../quickjs/libregexp.c
        ../quickjs/libunicode.c
        ../quickjs/cutils.c)
endif()

add_library(barochart SHARED ${BAROCHART_SOURCES})
target_compile_options(barochart PRIVATE -O3 -Werror)
target_link_libraries(barochart PRIVATE m)

# JNI와 공통 C ABI만 공개한다. 내부 Rust/QuickJS 심볼의 외부 노출은 section GC를 막는다.
set(BAROCHART_EXPORTS "${CMAKE_CURRENT_SOURCE_DIR}/barochart.map")
set_property(TARGET barochart APPEND PROPERTY LINK_DEPENDS "${BAROCHART_EXPORTS}")
target_link_options(barochart PRIVATE
    "-Wl,--version-script=${BAROCHART_EXPORTS}"
    "-Wl,--pack-dyn-relocs=android"
    "-Wl,--icf=safe")

if(WITH_QUICKJS)
    target_include_directories(barochart PRIVATE ../quickjs)
    target_compile_definitions(barochart PRIVATE
        BAROCHART_WITH_QUICKJS=1
        _GNU_SOURCE
        CONFIG_VERSION="2026-06-04")
else()
    target_compile_definitions(barochart PRIVATE BAROCHART_WITH_QUICKJS=0)
endif()

if(WITH_RUST)
    if(NOT BAROCHART_RUST_LIB)
        message(FATAL_ERROR "WITH_RUST requires -DBAROCHART_RUST_LIB=<rust target directory>")
    endif()
    if(ANDROID_ABI STREQUAL "arm64-v8a")
        set(BAROCHART_RUST_TARGET aarch64-linux-android)
    elseif(ANDROID_ABI STREQUAL "x86_64")
        set(BAROCHART_RUST_TARGET x86_64-linux-android)
    else()
        message(FATAL_ERROR "Rust backend does not support Android ABI ${ANDROID_ABI}")
    endif()
    set(BAROCHART_RUST_ARCHIVE "${BAROCHART_RUST_LIB}/${BAROCHART_RUST_TARGET}/release/libbarochart_ffi.a")
    if(NOT EXISTS "${BAROCHART_RUST_ARCHIVE}")
        message(FATAL_ERROR "Missing Rust static library: ${BAROCHART_RUST_ARCHIVE}")
    endif()
    add_library(barochart_core_rust STATIC IMPORTED)
    set_target_properties(barochart_core_rust PROPERTIES IMPORTED_LOCATION "${BAROCHART_RUST_ARCHIVE}")
    target_include_directories(barochart PRIVATE ../../../rust/include)
    target_compile_definitions(barochart PRIVATE BAROCHART_WITH_RUST=1)
    target_link_libraries(barochart PRIVATE barochart_core_rust dl log)
else()
    target_compile_definitions(barochart PRIVATE BAROCHART_WITH_RUST=0)
endif()
