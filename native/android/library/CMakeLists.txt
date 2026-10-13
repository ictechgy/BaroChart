cmake_minimum_required(VERSION 3.22.1)
project(aster_android C)
add_library(aster SHARED
    ../aster_jni.c
    ../quickjs/quickjs.c
    ../quickjs/dtoa.c
    ../quickjs/libregexp.c
    ../quickjs/libunicode.c
    ../quickjs/cutils.c)
target_include_directories(aster PRIVATE ../quickjs)
target_compile_definitions(aster PRIVATE _GNU_SOURCE CONFIG_VERSION="2026-06-04")
target_compile_options(aster PRIVATE -O3 -Werror)
target_link_libraries(aster PRIVATE m)
