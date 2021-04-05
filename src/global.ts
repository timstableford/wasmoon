import { LuaMetatables, LuaReturn, LuaState, LuaType, PointerSize } from './types'
import Thread from './thread'
import type LuaWasm from './luawasm'
import MultiReturn from './multireturn';

interface LuaMemoryStats {
    memoryUsed: number
    memoryMax?: number
}

export default class Global extends Thread {
    public readonly functionGcPointer: number
    public readonly jsRefGcPointer: number
    public readonly promiseGcPointer: number
    private memoryStats: LuaMemoryStats
    private allocatorFunctionPointer: number

    public constructor(cmodule: LuaWasm) {
        const memoryStats: LuaMemoryStats = { memoryUsed: 0 }
        const allocatorFunctionPointer = cmodule.module.addFunction((_userData: number, pointer: number, oldSize: number, newSize: number):
            | number
            | null => {
            if (newSize === 0 && pointer) {
                cmodule.module._free(pointer)
                return null
            }

            const increasing = Boolean(pointer) || newSize > oldSize
            const endMemoryDelta = pointer ? newSize - oldSize : newSize
            const endMemory = memoryStats.memoryUsed + endMemoryDelta

            if (increasing && memoryStats.memoryMax && endMemory > memoryStats.memoryMax) {
                return null
            }

            const reallocated = cmodule.module._realloc(pointer, newSize)
            if (reallocated) {
                memoryStats.memoryUsed = endMemory
            }
            return reallocated
        }, 'iiiii')

        const address = cmodule.lua_newstate(allocatorFunctionPointer, null)

        super(cmodule, address)

        this.memoryStats = memoryStats
        this.allocatorFunctionPointer = allocatorFunctionPointer

        this.functionGcPointer = cmodule.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = cmodule.luaL_checkudata(calledL, 1, LuaMetatables.FunctionReference)
            const functionPointer = cmodule.module.getValue(userDataPointer, '*')
            // Safe to do without a reference count because each time a function is pushed it creates a new and unique
            // anonymous function.
            cmodule.module.removeFunction(functionPointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (cmodule.luaL_newmetatable(address, LuaMetatables.FunctionReference)) {
            cmodule.lua_pushstring(address, '__gc')
            cmodule.lua_pushcclosure(address, this.functionGcPointer, 0)
            cmodule.lua_settable(address, -3)

            cmodule.lua_pushstring(address, '__metatable')
            cmodule.lua_pushstring(address, 'protected metatable')
            cmodule.lua_settable(address, -3)
        }
        // Pop the metatable from the stack.
        cmodule.lua_pop(address, 1)

        this.jsRefGcPointer = cmodule.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = cmodule.luaL_checkudata(calledL, 1, LuaMetatables.JsReference)
            const referencePointer = cmodule.module.getValue(userDataPointer, '*')
            cmodule.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates metatable if it doesn't exist, always pushes it onto the stack.
        if (cmodule.luaL_newmetatable(address, LuaMetatables.JsReference)) {
            cmodule.lua_pushstring(address, '__gc')
            cmodule.lua_pushcclosure(address, this.jsRefGcPointer, 0)
            cmodule.lua_settable(address, -3)

            cmodule.lua_pushstring(address, '__metatable')
            cmodule.lua_pushstring(address, 'protected metatable')
            cmodule.lua_settable(address, -3)
        }
        // Pop the metatable from the stack.
        cmodule.lua_pop(address, 1)

        this.promiseGcPointer = this.createPromiseLib()
    }

    public close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        // Do this before removing the gc to force
        this.cmodule.lua_close(this.address)
        this.cmodule.module.removeFunction(this.functionGcPointer)
        this.cmodule.module.removeFunction(this.jsRefGcPointer)
        this.cmodule.module.removeFunction(this.promiseGcPointer)
        this.cmodule.module.removeFunction(this.allocatorFunctionPointer)
    }

    public isClosed(): boolean {
        return !this.address || super.isClosed()
    }

    public getMemoryUsed(): number {
        return this.memoryStats.memoryUsed
    }

    public getMemoryMax(): number | undefined {
        return this.memoryStats.memoryMax
    }

    public setMemoryMax(max: number | undefined): void {
        this.memoryStats.memoryMax = max
    }

    private createPromiseLib(): number {
      const promiseGcPointer = this.cmodule.module.addFunction((calledL: LuaState) => {
            // Throws a lua error which does a jump if it does not match.
            const userDataPointer = this.cmodule.luaL_checkudata(calledL, 1, LuaMetatables.Promise)
            const referencePointer = this.cmodule.module.getValue(userDataPointer, '*')
            this.cmodule.unref(referencePointer)

            return LuaReturn.Ok
        }, 'ii')

        // Creates promise metatable if it doesn't exist, always pushes it onto the stack.
        if (this.cmodule.luaL_newmetatable(this.address, LuaMetatables.Promise)) {
            const metatableIndex = this.cmodule.lua_gettop(this.address)
            this.cmodule.lua_pushstring(this.address, 'protected metatable')
            this.cmodule.lua_setfield(this.address, metatableIndex, '__metatable')

            this.cmodule.lua_pushcclosure(this.address, promiseGcPointer, 0)
            this.cmodule.lua_setfield(this.address, metatableIndex, '__gc')

            // Create the method table
            this.cmodule.lua_createtable(this.address, 0, 4)
            const methodTableIndex = this.cmodule.lua_gettop(this.address)
            {
                // Simple methods
                for (const method of ['then', 'catch', 'finally']) {
                    this.pushValue((self: Promise<any>, callback: any) => {
                        console.log('promise call', method, self, callback)
                        return (self as Record<string, any>)[method]((val: MultiReturn) => {
                          const ret = callback(val[0]).then((res: MultiReturn) => res[0])
                          console.log('promise called', method, self, callback, val[0], ret)
                          return ret;
                        })
                    })
                    this.cmodule.lua_setfield(this.address, methodTableIndex, method === 'then' ? 'next' : method)
                }
                // Await
                this.pushValue((self: Promise<any>) => self, { await: true })
                this.cmodule.lua_setfield(this.address, methodTableIndex, 'await')
            }
            // Set the method table as the metatable index.
            this.cmodule.lua_setfield(this.address, metatableIndex, '__index')
        }
        // Pop the metatable from the stack.
        this.cmodule.lua_pop(this.address, 1)

        // Create the 'Promise' table containing the constructor.
        this.cmodule.lua_createtable(this.address, 0, 1)
        const promiseTableIndex = this.cmodule.lua_gettop(this.address)
        // Constructor
        this.pushValue(
            async (thread: Thread, callback: any): Promise<number> => {
                console.log('promise create enter', thread.address)
                thread.dumpStack()
                const resolves: any[] = []
                const rejects: any[] = []
                try {
                    await callback(
                        (...args: any[]) => {
                          resolves.push(args)
                        },
                        (...args: any[]) => {
                          rejects.push(args)
                        }
                    )
                } catch (err) {
                    rejects.push(err)
                }
                console.log('promise create callback complete', thread.address)
                thread.dumpStack()
                const promise = new Promise((resolve, reject) => {
                    for (const element of rejects) {
                        reject(element)
                    }
                    for (const element of resolves) {
                        resolve(element)
                    }
                })
                const pointer = this.cmodule.ref(promise)
                const userDataPointer = this.cmodule.lua_newuserdatauv(thread.address, PointerSize, 0)
                this.cmodule.module.setValue(userDataPointer, pointer, '*')

                if (LuaType.Nil === this.cmodule.luaL_getmetatable(thread.address, LuaMetatables.Promise)) {
                    // Pop the pushed nil value and the user data
                    this.cmodule.lua_pop(thread.address, 2)
                    throw new Error(`metatable not found: ${LuaMetatables.Promise}`)
                }

                this.cmodule.lua_setmetatable(thread.address, -2)
                console.log('returning promise constructor', thread.address)
                thread.dumpStack()
                // Returns the JS reference with the promise metatable
                return 1
            },
            { raw: true, await: true },
        )
        this.cmodule.lua_setfield(this.address, promiseTableIndex, 'create')
        this.cmodule.lua_setglobal(this.address, 'Promise')

        return promiseGcPointer
    }
}
