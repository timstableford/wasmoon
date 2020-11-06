#!/bin/bash
mkdir -p dist

cd lua
make MYLIBS= MYCFLAGS= CC="emcc -O$1 -s WASM=1"

extension=$1
if [ "$extension" == "3" ];
then
    extension="$extension --closure 1"
fi

cd ..
emcc -Ilua glue/main.c lua/liblua.a \
    -s WASM=1 -O$1 -o src/glue/index.js \
    -s EXTRA_EXPORTED_RUNTIME_METHODS="['cwrap', 'addFunction']" \
    -s MODULARIZE=1 \
    -s ALLOW_TABLE_GROWTH \
    -s EXPORT_NAME="initWasmModule" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s STRICT=1 \
    -s MALLOC=emmalloc \
    -s EXPORTED_FUNCTIONS="[
        '_luaL_newstate', \
        '_luaL_openlibs', \
        '_clua_dostring', \
        '_lua_getglobal', \
        '_clua_tonumber', \
        '_clua_tostring', \
        '_lua_toboolean', \
        '_lua_gettable', \
        '_lua_next', \
        '_lua_type', \
        '_clua_pop', \
        '_clua_dump_stack', \
        '_lua_topointer', \
        '_lua_pushnil', \
        '_lua_pushvalue', \
        '_lua_pushinteger', \
        '_lua_pushnumber', \
        '_lua_pushstring', \
        '_lua_pushboolean', \
        '_lua_setglobal', \
        '_clua_newtable', \
        '_lua_gettop', \
        '_lua_settable', \
        '_lua_callk', \
        '_clua_pushcfunction', \
        '_lua_close' \
    ]"