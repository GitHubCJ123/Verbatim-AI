# CMake build for the headless `whisper-stream` streaming sidecar (issue #33).
#
# This target links against a **prebuilt** whisper.cpp. It does not fetch or
# build whisper.cpp itself — CI (and local verification) build whisper.cpp once
# (Metal on macOS, CUDA/Vulkan/CPU elsewhere) and point this build at it, so the
# streaming sidecar reuses the exact same whisper version and runtime dylibs as
# `whisper-cli` / `whisper-server`.
#
# ---------------------------------------------------------------------------
# How to point at a prebuilt whisper.cpp
#
#   -DWHISPER_ROOT=<path>   whisper.cpp SOURCE dir (contains include/whisper.h
#                           and ggml/include). REQUIRED unless a whisper CMake
#                           package is discoverable via find_package.
#   -DWHISPER_BUILD=<path>  whisper.cpp BUILD dir that holds libwhisper.
#                           Defaults to ${WHISPER_ROOT}/build.
#
# If neither is given, the build falls back to find_package(whisper CONFIG),
# which works when whisper.cpp has been `cmake --install`ed.
#
# The resulting executable is named exactly `whisper-stream` and is written to
# the build dir root (e.g. <build>/whisper-stream, or <build>/whisper-stream.exe
# on Windows).
# ---------------------------------------------------------------------------

cmake_minimum_required(VERSION 3.16)
project(whisper-stream LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# Emit the binary at the build-dir root so CI can copy it with a stable path.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")

add_executable(whisper-stream whisper-stream.cpp)

# --- Locate a prebuilt whisper.cpp ----------------------------------------
set(WHISPER_ROOT "" CACHE PATH "whisper.cpp source dir (include/whisper.h, ggml/include)")
set(WHISPER_BUILD "" CACHE PATH "whisper.cpp build dir containing libwhisper")

set(_whisper_linked FALSE)

if(WHISPER_ROOT)
    if(NOT WHISPER_BUILD)
        set(WHISPER_BUILD "${WHISPER_ROOT}/build")
    endif()

    # whisper.h lives in include/; it #includes ggml.h from ggml/include/.
    target_include_directories(whisper-stream PRIVATE
        "${WHISPER_ROOT}/include"
        "${WHISPER_ROOT}/ggml/include")

    find_library(WHISPER_LIB
        NAMES whisper libwhisper
        PATHS
            "${WHISPER_BUILD}/src"
            "${WHISPER_BUILD}/bin"
            "${WHISPER_BUILD}/lib"
            "${WHISPER_BUILD}"
        NO_DEFAULT_PATH)

    if(NOT WHISPER_LIB)
        message(FATAL_ERROR
            "WHISPER_ROOT was set but no whisper library was found under "
            "'${WHISPER_BUILD}'. Build whisper.cpp first "
            "(cmake -S <src> -B <src>/build && cmake --build <src>/build).")
    endif()

    target_link_libraries(whisper-stream PRIVATE "${WHISPER_LIB}")
    set(_whisper_linked TRUE)
    message(STATUS "whisper-stream: linking prebuilt whisper: ${WHISPER_LIB}")
endif()

if(NOT _whisper_linked)
    # Fallback: an installed whisper.cpp exposing a CMake package.
    find_package(whisper CONFIG QUIET)
    if(TARGET whisper)
        target_link_libraries(whisper-stream PRIVATE whisper)
        set(_whisper_linked TRUE)
        message(STATUS "whisper-stream: linking via find_package(whisper)")
    endif()
endif()

if(NOT _whisper_linked)
    message(FATAL_ERROR
        "Could not locate whisper.cpp. Pass -DWHISPER_ROOT=<whisper.cpp source dir> "
        "(with a built <WHISPER_ROOT>/build), or install whisper.cpp so "
        "find_package(whisper) succeeds.")
endif()

# --- Runtime search path for sibling shared libs ---------------------------
# CI stages whisper-stream next to libwhisper/libggml dylibs (same layout as
# whisper-cli). Look next to the executable at runtime.
if(APPLE)
    set_target_properties(whisper-stream PROPERTIES
        BUILD_RPATH "@loader_path;${WHISPER_BUILD}/src;${WHISPER_BUILD}/bin"
        INSTALL_RPATH "@loader_path")
elseif(UNIX)
    set_target_properties(whisper-stream PROPERTIES
        BUILD_RPATH "$ORIGIN;${WHISPER_BUILD}/src;${WHISPER_BUILD}/bin"
        INSTALL_RPATH "$ORIGIN")
endif()

find_package(Threads REQUIRED)
target_link_libraries(whisper-stream PRIVATE Threads::Threads)
