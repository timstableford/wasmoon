import { Decoration } from './decoration'
import { LUA_REGISTRYINDEX, LuaMetatables, LuaResumeResult, LuaReturn, LuaState, LuaType, PointerSize } from './types'
import { Pointer } from './pointer'
import MultiReturn from './multireturn'
import type LuaWasm from './luawasm'

export default class Thread {
    public readonly address: LuaState = 0
    public readonly cmodule: LuaWasm
    protected closed = false
    // Backward compatibility
    private readonly functionRegistry =
        typeof FinalizationRegistry !== 'undefined'
            ? new FinalizationRegistry((func: number) => {
                  if (!this.isClosed()) {
                      this.cmodule.luaL_unref(this.address, LUA_REGISTRYINDEX, func)
                  }
              })
            : undefined

    private parent?: Thread
    private continuance?: number
    //private pendingPromises: Array<Promise<any>> = []

    public constructor(cmodule: LuaWasm, address: number, parent?: Thread) {
        this.cmodule = cmodule
        this.address = address
        this.parent = parent
    }

    public get(name: string): any {
        const type = this.cmodule.lua_getglobal(this.address, name)
        return this.getValue(-1, type)
    }

    public set(name: string, value: any): void {
        this.pushValue(value)
        this.cmodule.lua_setglobal(this.address, name)
    }

    public newThread(): Thread {
        const address = this.cmodule.lua_newthread(this.address)
        // The thread is pushed onto the stack. Pop it to cleanup.
        return new Thread(this.cmodule, address, this)
    }

    public resetThread(): void {
        this.assertOk(this.cmodule.lua_resetthread(this.address))
        if (this.continuance !== undefined) {
            this.cmodule.module.removeFunction(this.continuance)
            this.continuance = undefined
        }
    }

    public loadString(luaCode: string): void {
        this.assertOk(this.cmodule.luaL_loadstring(this.address, luaCode))
    }

    public loadFile(filename: string): void {
        this.assertOk(this.cmodule.luaL_loadfilex(this.address, filename))
    }

    public resume(argCount = 0): LuaResumeResult {
        const resumeResult = this.cmodule.lua_resume(this.address, undefined, argCount)
        this.assertOk(resumeResult.result)
        return resumeResult
    }

    public async run(argCount = 0): Promise<LuaResumeResult> {
        let resumeResult: LuaResumeResult = this.resume(argCount)
        while (resumeResult.result === LuaReturn.Yield) {
            console.log('run resumeResult yield', this.address, resumeResult)
            this.dumpStack()

            if (resumeResult.resultCount > 0) {
                //const yieldStartTop = this.getTop()
                const lastValue = this.getValue(-1)
                this.pop(resumeResult.resultCount)
                if (lastValue === Promise.resolve(lastValue)) {
                    console.log('yielded value', this.address, await lastValue)
                } else {
                    console.warn('Yield with non-promise value')
                    this.dumpStack()
                }
                // If resultCount > 0 then the stack will look like the following
                // if this thread does odd things elsewhere.
                // 1. function
                // 2. pending promise
                // 3. function result
                // Move the pending promise back to the end.
                //console.log('stack prerotate', this.address, this.getTop(), yieldStartTop)
                //this.dumpStack()
                // +1 because that's where the thread is
                /*console.log('rotate args', this.address, yieldStartTop + 1, this.getTop() - yieldStartTop + 1)
                this.cmodule.lua_rotate(this.address, yieldStartTop + 1, this.getTop() - yieldStartTop - 1);
                console.log('stack postrotate', this.address)
                this.dumpStack()*/
                //console.log('run pop', this.address, resumeResult.resultCount)

            } else {
                console.warn('Yield with no results')
            }

            resumeResult = this.resume(0)
        }
        console.log('run resumeResult ok', this.address, resumeResult)
        this.dumpStack()
        return resumeResult
    }

    public pop(count: number): void {
        console.log('pop', this.address, count)
        this.cmodule.lua_pop(this.address, count)
    }

    public getTop(): number {
        return this.cmodule.lua_gettop(this.address)
    }

    public remove(index: number): void {
        return this.cmodule.lua_remove(this.address, index)
    }

    public isClosed(): boolean {
        return this.closed || Boolean(this.parent?.isClosed())
    }

    public async call(name: string, ...args: any[]): Promise<MultiReturn> {
        const thread = this.newThread()
        const threadIndex = this.getTop()
        try {
            const type = this.cmodule.lua_getglobal(thread.address, name)
            if (type !== LuaType.Function) {
                throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
            }
            for (const arg of args) {
                thread.pushValue(arg)
            }
            const resumeResult = await thread.run(args.length)
            if (resumeResult.resultCount > 0) {
                this.cmodule.lua_xmove(thread.address, this.address, resumeResult.resultCount)
            }
            return this.getValues(resumeResult.resultCount)
        } finally {
            // Pop the thread
            this.remove(threadIndex)
        }
    }

    public getValues(count: number): MultiReturn {
        const values = new MultiReturn(count)
        const top = this.getTop()
        for (let i = 0; i < count; i++) {
            values[i] = this.getValue(top - count + i + 1)
        }
        return values
    }

    public pushValue(
        value: any,
        options: Partial<{ _done?: Record<string, number>; reference?: boolean; await?: boolean; raw?: boolean }> = {},
    ): void {
        const { value: target, decorations } = this.getValueDecorations(value)

        const type = typeof target

        if (options?._done?.[target]) {
            this.cmodule.lua_pushvalue(this.address, options._done[target])
            return
        }

        if (options.reference) {
            this.createAndPushJsReference(value)
            return
        }

        if (type === 'undefined' || target === null) {
            this.cmodule.lua_pushnil(this.address)
        } else if (type === 'number') {
            if (Number.isInteger(target)) {
                this.cmodule.lua_pushinteger(this.address, target)
            } else {
                this.cmodule.lua_pushnumber(this.address, target)
            }
        } else if (type === 'string') {
            this.cmodule.lua_pushstring(this.address, target)
        } else if (type === 'boolean') {
            this.cmodule.lua_pushboolean(this.address, target)
        } else if (type === 'object') {
            if (target instanceof Thread) {
                this.cmodule.lua_pushthread(target.address)
            } else if (Promise.resolve(target) === target) {
                const pointer = this.cmodule.ref(target)
                const userDataPointer = this.cmodule.lua_newuserdatauv(this.address, PointerSize, 0)
                this.cmodule.module.setValue(userDataPointer, pointer, '*')

                if (LuaType.Nil === this.cmodule.luaL_getmetatable(this.address, LuaMetatables.Promise)) {
                    // Pop the pushed nil value and the user data
                    this.cmodule.unref(pointer)
                    this.pop(2)
                    throw new Error(`metatable not found: ${LuaMetatables.Promise}`)
                }

                this.cmodule.lua_setmetatable(this.address, -2)
            } else {
                const table = this.getTop() + 1

                options._done ??= {}
                options._done[target] = table

                if (Array.isArray(target)) {
                    this.cmodule.lua_createtable(this.address, target.length, 0)

                    for (let i = 0; i < target.length; i++) {
                        this.pushValue(i + 1)
                        this.pushValue(target[i], { _done: options._done })

                        this.cmodule.lua_settable(this.address, table)
                    }
                } else {
                    this.cmodule.lua_createtable(this.address, 0, Object.getOwnPropertyNames(target).length)

                    for (const key in target) {
                        this.pushValue(key)
                        this.pushValue(target[key], { _done: options._done })

                        this.cmodule.lua_settable(this.address, table)
                    }
                }

                if (typeof decorations.metatable === 'object') {
                    this.pushValue(decorations.metatable)
                    this.cmodule.lua_setmetatable(this.address, -2)
                }
            }
        } else if (type === 'function') {
            const pointer = this.cmodule.module.addFunction((calledL: LuaState) => {
                const argsQuantity = this.cmodule.lua_gettop(calledL)
                const thread = this.stateToThread(calledL)
                const args = options.raw ? [thread] : []

                for (let i = 1; i <= argsQuantity; i++) {
                    args.push(thread.getValue(i, undefined, { raw: decorations?.rawArguments?.includes(i - 1) }))
                }

                const result = target(...args)

                if (Promise.resolve(result) !== result || !options['await']) {
                    if (options.raw) {
                        if (typeof result !== 'number') {
                            throw new Error('Must return a number when using raw functions')
                        }
                        return result
                    }
                    if (result === undefined) {
                        return 0
                    }
                    if (result instanceof MultiReturn) {
                        for (const item of result) {
                            thread.pushValue(item)
                        }
                        return result.length
                    } else {
                        thread.pushValue(result)
                        return 1
                    }
                }

                let results: any | undefined = undefined
                // Cleanup previous calls that may be left if a thread is never resumed.
                if (this.continuance !== undefined) {
                    this.cmodule.module.removeFunction(this.continuance)
                }
                this.continuance = this.cmodule.module.addFunction((continuanceState: LuaState, _status: number, context: number) => {
                    // Remove the continuance function references.
                    this.cmodule.module.removeFunction(context)
                    if (this.continuance === context) {
                        this.continuance = undefined
                    }

                    console.log('calledL vs continuanceL vs thisL', calledL, continuanceState, this.address)

                    const continuanceThread = this.stateToThread(continuanceState)
                    console.log('continuance stack')
                    continuanceThread.dumpStack()
                    if (options.raw) {
                        if (typeof results !== 'number') {
                            console.log('results', results)
                            throw new Error('Must return a promise of a number when using raw functions')
                        }
                        return results
                    }
                    if (results === undefined) {
                        return 0
                    }
                    if (results instanceof MultiReturn) {
                        for (const item of results) {
                            continuanceThread.pushValue(item)
                        }
                        return results.length
                    } else {
                        continuanceThread.pushValue(results)
                        return 1
                    }
                }, 'iiii')

                // Push promise to stack as user data to be passed back to resume.
                const promise = result.then((asyncResult: any) => {
                    console.log('asyncResult', asyncResult)
                    results = asyncResult
                })

                console.log('yielding for promise')

                thread.createAndPushJsReference(promise)

                console.log('yieldk stack')
                thread.dumpStack()

                // Pass the continuance function as the function and the context.
                return this.cmodule.lua_yieldk(calledL, 1, this.continuance, this.continuance)
            }, 'ii')
            // Creates a new userdata with metatable pointing to the function pointer.
            // Pushes the new userdata onto the stack.
            this.createAndPushFunctionReference(pointer)
            // Pass 1 to associate the closure with the userdata.
            this.cmodule.lua_pushcclosure(this.address, pointer, 1)
        } else {
            throw new Error(`The type '${type}' is not supported by Lua`)
        }
    }

    public getValue(
        idx: number,
        type: LuaType | undefined = undefined,
        options: Partial<{
            raw: boolean
            sync: boolean
            _done: Record<string, number>
        }> = {},
    ): any {
        // console.log('getValue', idx, type, options)
        if (idx === 0) {
            throw new Error('index must be non-zero')
        }
        type = type || this.cmodule.lua_type(this.address, idx)

        switch (type) {
            case LuaType.None:
                return undefined
            case LuaType.Nil:
                return null
            case LuaType.Number:
                return this.cmodule.lua_tonumberx(this.address, idx, undefined)
            case LuaType.String:
                return this.cmodule.lua_tolstring(this.address, idx, undefined)
            case LuaType.Boolean:
                return Boolean(this.cmodule.lua_toboolean(this.address, idx))
            case LuaType.Table:
                if (options.raw) {
                    return new Pointer(this.cmodule.lua_topointer(this.address, idx))
                } else {
                    return this.getTableValue(idx, options?._done)
                }
            case LuaType.Function:
                if (options.raw) {
                    return new Pointer(this.cmodule.lua_topointer(this.address, idx))
                } else {
                    this.cmodule.lua_pushvalue(this.address, idx)
                    const func = this.cmodule.luaL_ref(this.address, LUA_REGISTRYINDEX)

                    const jsFunc = async (...args: any[]): Promise<MultiReturn> => {
                        if (this.isClosed()) {
                            console.warn('Tried to call a function after closing lua state')
                            return []
                        }

                        const thread = this.newThread()
                        const threadIndex = this.getTop()
                        try {
                            const internalType = this.cmodule.lua_rawgeti(thread.address, LUA_REGISTRYINDEX, func)
                            if (internalType !== LuaType.Function) {
                                throw new Error(`A function of type '${type}' was pushed, expected is ${LuaType.Function}`)
                            }
                            for (const arg of args) {
                                thread.pushValue(arg)
                            }
                            const id = Math.floor(Math.random() * 1000)
                            console.log('jsfunc pre-enter', id, args.length, thread.getTop())
                            thread.dumpStack()
                            const resumeResult = await thread.run(args.length)
                            console.log('jsfunc post', id, resumeResult, thread.getTop())
                            return thread.getValues(resumeResult.resultCount)
                        } finally {
                            console.log('jsFunc pop thread')
                            this.dumpStack()
                            // Pop the thread
                            this.remove(threadIndex)
                        }
                    }

                    this.functionRegistry?.register(jsFunc, func)

                    return jsFunc
                }
            case LuaType.Thread: {
                const value = this.cmodule.lua_tothread(this.address, idx)
                if (options.raw) {
                    return new Pointer(value)
                } else {
                    return this.stateToThread(value)
                }
            }
            case LuaType.UserData: {
                const jsRefUserData = this.cmodule.luaL_testudata(this.address, idx, LuaMetatables.JsReference)
                if (jsRefUserData) {
                    const referencePointer = this.cmodule.module.getValue(jsRefUserData, '*')
                    return this.cmodule.getRef(referencePointer)
                }
                const promiseUserData = this.cmodule.luaL_testudata(this.address, idx, LuaMetatables.Promise)
                if (promiseUserData) {
                    const referencePointer = this.cmodule.module.getValue(promiseUserData, '*')
                    return this.cmodule.getRef(referencePointer)
                }
            }
            // Fallthrough if unrecognised user data
            default:
                console.trace(
                    `The type '${this.cmodule.lua_typename(this.address, type)}' / '${this.cmodule.luaL_tolstring(
                        this.address,
                        idx,
                    )}' returned is not supported on JS`,
                )
                // Pop string to added
                this.pop(1)
                return new Pointer(this.cmodule.lua_topointer(this.address, idx))
        }
    }

    public dumpStack(log = console.log): void {
        const top = this.getTop()

        for (let i = 1; i <= top; i++) {
            const type = this.cmodule.lua_type(this.address, i)
            const value = this.getValue(i, type, { raw: true })

            const typename = this.cmodule.lua_typename(this.address, type)
            log(i, typename, value)
        }
    }

    private assertOk(result: LuaReturn): void {
        if (result !== LuaReturn.Ok && result !== LuaReturn.Yield) {
            const resultString = LuaReturn[result]
            let message = `Lua Error(${resultString}/${result})`
            if (this.getTop() > 0) {
                const error = this.cmodule.lua_tolstring(this.address, -1, undefined)
                message += `: ${error}`
                this.pop(1)
            }
            throw new Error(message)
        }
    }

    private getTableValue(idx: number, done: Record<string, any> = {}): Record<any, any> {
        const table: Record<any, any> = {}

        const pointer = this.cmodule.lua_topointer(this.address, idx)
        if (done[pointer]) {
            return done[pointer]
        }

        done[pointer] = table

        this.cmodule.lua_pushnil(this.address)

        if (idx < 0) {
            idx--
        }

        while (this.cmodule.lua_next(this.address, idx)) {
            const keyType = this.cmodule.lua_type(this.address, -2)
            const key = this.getValue(-2, keyType, { _done: done })

            const valueType = this.cmodule.lua_type(this.address, -1)
            const value = this.getValue(-1, valueType, { _done: done })

            table[key] = value

            this.pop(1)
        }

        return table
    }

    private createAndPushFunctionReference(pointer: number): void {
        // 4 = size of pointer in wasm.
        const userDataPointer = this.cmodule.lua_newuserdatauv(this.address, PointerSize, 0)
        this.cmodule.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === this.cmodule.luaL_getmetatable(this.address, LuaMetatables.FunctionReference)) {
            // Pop the pushed nil value and the user data
            this.pop(2)
            throw new Error(`metatable not found: ${LuaMetatables.FunctionReference}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        this.cmodule.lua_setmetatable(this.address, -2)
    }

    private createAndPushJsReference(object: any): void {
        const pointer = this.cmodule.ref(object)
        // 4 = size of pointer in wasm.
        const userDataPointer = this.cmodule.lua_newuserdatauv(this.address, PointerSize, 0)
        this.cmodule.module.setValue(userDataPointer, pointer, '*')

        if (LuaType.Nil === this.cmodule.luaL_getmetatable(this.address, LuaMetatables.JsReference)) {
            // Pop the pushed nil value and the user data
            this.cmodule.unref(pointer)
            this.pop(2)
            throw new Error(`metatable not found: ${LuaMetatables.FunctionReference}`)
        }

        // Set as the metatable for the userdata.
        // -1 is the metatable, -2 is the user data.
        this.cmodule.lua_setmetatable(this.address, -2)
    }

    private stateToThread(L: LuaState): Thread {
        return L === this.parent?.address ? this.parent : new Thread(this.cmodule, L, this)
    }

    private getValueDecorations(value: any): { value: any; decorations: any } {
        return value instanceof Decoration ? { value: value.target, decorations: value.options } : { value, decorations: {} }
    }
}
