"use jco";
import { get, set } from 'component:smartcms/kvstore';

const _debugLog = (...args) => {
  if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
  console.debug(...args);
}
const ASYNC_DETERMINISM = 'random';

class GlobalComponentAsyncLowers {
  static map = new Map();
  
  constructor() { throw new Error('GlobalComponentAsyncLowers should not be constructed'); }
  
  static define(args) {
    const { componentIdx, qualifiedImportFn, fn } = args;
    let inner = GlobalComponentAsyncLowers.map.get(componentIdx);
    if (!inner) {
      inner = new Map();
      GlobalComponentAsyncLowers.map.set(componentIdx, inner);
    }
    
    inner.set(qualifiedImportFn, fn);
  }
  
  static lookup(componentIdx, qualifiedImportFn) {
    let inner = GlobalComponentAsyncLowers.map.get(componentIdx);
    if (!inner) {
      inner = new Map();
      GlobalComponentAsyncLowers.map.set(componentIdx, inner);
    }
    
    const found = inner.get(qualifiedImportFn);
    if (found) { return found; }
    
    // In some cases, async lowers are *not* host provided, and
    // but contain/will call an async function in the host.
    //
    // One such case is `stream.write`/`stream.read` trampolines which are
    // actually re-exported through a patch up container *before*
    // they call the relevant async host trampoline.
    //
    // So the path of execution from a component export would be:
    //
    // async guest export --> stream.write import (host wired) -> guest export (patch component) -> async host trampoline
    //
    // On top of all this, the trampoline that is eventually called is async,
    // so we must await the patched guest export call.
    //
    if (qualifiedImportFn.includes("[stream-write-") || qualifiedImportFn.includes("[stream-read-")) {
      return async (...args) => {
        const [originalFn, ...params] = args;
        return await originalFn(...params);
      };
    }
    
    // All other cases can call the registered function directly
    return (...args) => {
      const [originalFn, ...params] = args;
      return originalFn(...params);
    };
  }
}

class GlobalAsyncParamLowers {
  static map = new Map();
  
  static generateKey(args) {
    const { componentIdx, iface, fnName } = args;
    if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
    if (iface === undefined) { throw new TypeError("missing iface name"); }
    if (fnName === undefined) { throw new TypeError("missing function name"); }
    return `${componentIdx}-${iface}-${fnName}`;
  }
  
  static define(args) {
    const { componentIdx, iface, fnName, fn } = args;
    if (!fn) { throw new TypeError('missing function'); }
    const key = GlobalAsyncParamLowers.generateKey(args);
    GlobalAsyncParamLowers.map.set(key, fn);
  }
  
  static lookup(args) {
    const { componentIdx, iface, fnName } = args;
    const key = GlobalAsyncParamLowers.generateKey(args);
    return GlobalAsyncParamLowers.map.get(key);
  }
}

class GlobalComponentMemories {
  static map = new Map();
  
  constructor() { throw new Error('GlobalComponentMemories should not be constructed'); }
  
  static save(args) {
    const { idx, componentIdx, memory } = args;
    let inner = GlobalComponentMemories.map.get(componentIdx);
    if (!inner) {
      inner = [];
      GlobalComponentMemories.map.set(componentIdx, inner);
    }
    inner.push({ memory, idx });
  }
  
  static getMemoriesForComponentIdx(componentIdx) {
    const metas = GlobalComponentMemories.map.get(componentIdx);
    return metas.map(meta => meta.memory);
  }
  
  static getMemory(componentIdx, idx) {
    const metas = GlobalComponentMemories.map.get(componentIdx);
    return metas.find(meta => meta.idx === idx)?.memory;
  }
}

class RepTable {
  #data = [0, null];
  #target;
  
  constructor(args) {
    this.target = args?.target;
  }
  
  insert(val) {
    _debugLog('[RepTable#insert()] args', { val, target: this.target });
    const freeIdx = this.#data[0];
    if (freeIdx === 0) {
      this.#data.push(val);
      this.#data.push(null);
      return (this.#data.length >> 1) - 1;
    }
    this.#data[0] = this.#data[freeIdx << 1];
    const placementIdx = freeIdx << 1;
    this.#data[placementIdx] = val;
    this.#data[placementIdx + 1] = null;
    return freeIdx;
  }
  
  get(rep) {
    _debugLog('[RepTable#get()] args', { rep, target: this.target });
    const baseIdx = rep << 1;
    const val = this.#data[baseIdx];
    return val;
  }
  
  contains(rep) {
    _debugLog('[RepTable#contains()] args', { rep, target: this.target });
    const baseIdx = rep << 1;
    return !!this.#data[baseIdx];
  }
  
  remove(rep) {
    _debugLog('[RepTable#remove()] args', { rep, target: this.target });
    if (this.#data.length === 2) { throw new Error('invalid'); }
    
    const baseIdx = rep << 1;
    const val = this.#data[baseIdx];
    if (val === 0) { throw new Error('invalid resource rep (cannot be 0)'); }
    
    this.#data[baseIdx] = this.#data[0];
    this.#data[0] = rep;
    
    return val;
  }
  
  clear() {
    _debugLog('[RepTable#clear()] args', { rep, target: this.target });
    this.#data = [0, null];
  }
}
const _coinFlip = () => { return Math.random() > 0.5; };
let SCOPE_ID = 0;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;

const _typeCheckAsyncFn= (f) => {
  return f instanceof ASYNC_FN_CTOR;
};

const ASYNC_FN_CTOR = (async () => {}).constructor;
const ASYNC_CURRENT_TASK_IDS = [];
const ASYNC_CURRENT_COMPONENT_IDXS = [];

function unpackCallbackResult(result) {
  _debugLog('[unpackCallbackResult()] args', { result });
  if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
  const eventCode = result & 0xF;
  if (eventCode < 0 || eventCode > 3) {
    throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
  }
  if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
  // TODO: table max length check?
  const waitableSetRep = result >> 4;
  return [eventCode, waitableSetRep];
}

function promiseWithResolvers() {
  if (Promise.withResolvers) {
    return Promise.withResolvers();
  } else {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
}

function _prepareCall(
memoryIdx,
getMemoryFn,
startFn,
returnFn,
callerInstanceIdx,
calleeInstanceIdx,
taskReturnTypeIdx,
isCalleeAsyncInt,
stringEncoding,
resultCountOrAsync,
) {
  _debugLog('[_prepareCall()]', {
    callerInstanceIdx,
    calleeInstanceIdx,
    taskReturnTypeIdx,
    isCalleeAsyncInt,
    stringEncoding,
    resultCountOrAsync,
  });
  const argArray = [...arguments];
  
  // Since Rust will happily pass large u32s over, resultCountOrAsync should be one of:
  // (a) u32 max size     => callee is async fn with no result
  // (b) u32 max size - 1 => callee is async fn with result
  // (c) any other value  => callee is sync with the given result count
  //
  // Due to JS handling the value as 2s complement, the `resultCountOrAsync` ends up being:
  // (a) -1 as u32 max size
  // (b) -2 as u32 max size - 1
  // (c) x
  //
  // Due to JS mishandling the value as 2s complement, the actual values we get are:
  // see. https://github.com/wasm-bindgen/wasm-bindgen/issues/1388
  let isAsync = false;
  let hasResultPointer = false;
  if (resultCountOrAsync === -1) {
    isAsync = true;
    hasResultPointer = false;
  } else if (resultCountOrAsync === -2) {
    isAsync = true;
    hasResultPointer = true;
  }
  
  const currentCallerTaskMeta = getCurrentTask(callerInstanceIdx);
  if (!currentCallerTaskMeta) {
    throw new Error('invalid/missing current task for caller during prepare call');
  }
  
  const currentCallerTask = currentCallerTaskMeta.task;
  if (!currentCallerTask) {
    throw new Error('unexpectedly missing task in meta for caller during prepare call');
  }
  
  if (currentCallerTask.componentIdx() !== callerInstanceIdx) {
    throw new Error(`task component idx [${ currentCallerTask.componentIdx() }] !== [${ callerInstanceIdx }] (callee ${ calleeInstanceIdx })`);
  }
  
  let getCalleeParamsFn;
  let resultPtr = null;
  if (hasResultPointer) {
    const directParamsArr = argArray.slice(11);
    getCalleeParamsFn = () => directParamsArr;
    resultPtr = argArray[10];
  } else {
    const directParamsArr = argArray.slice(10);
    getCalleeParamsFn = () => directParamsArr;
  }
  
  let encoding;
  switch (stringEncoding) {
    case 0:
    encoding = 'utf8';
    break;
    case 1:
    encoding = 'utf16';
    break;
    case 2:
    encoding = 'compact-utf16';
    break;
    default:
    throw new Error(`unrecognized string encoding enum [${stringEncoding}]`);
  }
  
  const [newTask, newTaskID] = createNewCurrentTask({
    componentIdx: calleeInstanceIdx,
    isAsync: isCalleeAsyncInt !== 0,
    getCalleeParamsFn,
    // TODO: find a way to pass the import name through here
    entryFnName: 'task/' + currentCallerTask.id() + '/new-prepare-task',
    stringEncoding,
  });
  
  const subtask = currentCallerTask.createSubtask({
    componentIdx: callerInstanceIdx,
    parentTask: currentCallerTask,
    childTask: newTask,
    callMetadata: {
      memory: getMemoryFn(),
      memoryIdx,
      resultPtr,
      returnFn,
      startFn,
    }
  });
  
  newTask.setParentSubtask(subtask);
  // NOTE: This isn't really a return memory idx for the caller, it's for checking
  // against the task.return (which will be called from the callee)
  newTask.setReturnMemoryIdx(memoryIdx);
}

function _asyncStartCall(args, callee, paramCount, resultCount, flags) {
  const { getCallbackFn, callbackIdx, getPostReturnFn, postReturnIdx } = args;
  _debugLog('[_asyncStartCall()] args', args);
  
  const taskMeta = getCurrentTask(ASYNC_CURRENT_COMPONENT_IDXS.at(-1), ASYNC_CURRENT_TASK_IDS.at(-1));
  if (!taskMeta) { throw new Error('invalid/missing current async task meta during prepare call'); }
  
  const argArray = [...arguments];
  
  // NOTE: at this point we know the current task is the one that was started
  // in PrepareCall, so we *should* be able to pop it back off and be left with
  // the previous task
  const preparedTask = taskMeta.task;
  if (!preparedTask) { throw new Error('unexpectedly missing task in task meta during prepare call'); }
  
  if (resultCount < 0 || resultCount > 1) { throw new Error('invalid/unsupported result count'); }
  
  const callbackFnName = 'callback_' + callbackIdx;
  const callbackFn = getCallbackFn();
  preparedTask.setCallbackFn(callbackFn, callbackFnName);
  preparedTask.setPostReturnFn(getPostReturnFn());
  
  const subtask = preparedTask.getParentSubtask();
  
  if (resultCount < 0 || resultCount > 1) { throw new Error(`unsupported result count [${ resultCount }]`); }
  
  const params = preparedTask.getCalleeParams();
  if (paramCount !== params.length) {
    throw new Error(`unexpected callee param count [${ params.length }], _asyncStartCall invocation expected [${ paramCount }]`);
  }
  
  subtask.setOnProgressFn(() => {
    subtask.setPendingEventFn(() => {
      if (subtask.resolved()) { subtask.deliverResolve(); }
      return {
        code: ASYNC_EVENT_CODE.SUBTASK,
        index: rep,
        result: subtask.getStateNumber(),
      }
    });
  });
  
  const subtaskState = subtask.getStateNumber();
  if (subtaskState < 0 || subtaskState > 2**5) {
    throw new Error('invalid subtask state, out of valid range');
  }
  
  const callerComponentState = getOrCreateAsyncState(subtask.componentIdx());
  const rep = callerComponentState.subtasks.insert(subtask);
  subtask.setRep(rep);
  
  const calleeComponentState = getOrCreateAsyncState(preparedTask.componentIdx());
  const calleeBackpressure = calleeComponentState.hasBackpressure();
  
  // Set up a handler on subtask completion to lower results from the call into the caller's memory region.
  //
  // NOTE: during fused guest->guest calls this handler is triggered, but does not actually perform
  // lowering manually, as fused modules provider helper functions that can
  subtask.registerOnResolveHandler((res) => {
    _debugLog('[_asyncStartCall()] handling subtask result', { res, subtaskID: subtask.id() });
    let subtaskCallMeta = subtask.getCallMetadata();
    
    // NOTE: in the case of guest -> guest async calls, there may be no memory/realloc present,
    // as the host will intermediate the value storage/movement between calls.
    //
    // We can simply take the value and lower it as a parameter
    if (subtaskCallMeta.memory || subtaskCallMeta.realloc) {
      throw new Error("call metadata unexpectedly contains memory/realloc for guest->guest call");
    }
    
    const callerTask = subtask.getParentTask();
    const calleeTask = preparedTask;
    const callerMemoryIdx = callerTask.getReturnMemoryIdx();
    const callerComponentIdx = callerTask.componentIdx();
    
    // If a helper function was provided we are likely in a fused guest->guest call,
    // and the result will be delivered (lift/lowered) via helper function
    if (subtaskCallMeta.returnFn) {
      _debugLog('[_asyncStartCall()] return function present while ahndling subtask result, returning early (skipping lower)');
      return;
    }
    
    // If there is no where to lower the results, exit early
    if (!subtaskCallMeta.resultPtr) {
      _debugLog('[_asyncStartCall()] no result ptr during subtask result handling, returning early (skipping lower)');
      return;
    }
    
    let callerMemory;
    if (callerMemoryIdx) {
      callerMemory = GlobalComponentMemories.getMemory(callerComponentIdx, callerMemoryIdx);
    } else {
      const callerMemories = GlobalComponentMemories.getMemoriesForComponentIdx(callerComponentIdx);
      if (callerMemories.length != 1) { throw new Error(`unsupported amount of caller memories`); }
      callerMemory = callerMemories[0];
    }
    
    if (!callerMemory) {
      throw new Error(`missing memory for to guest->guest call result (subtask [${subtask.id()}])`);
    }
    
    const lowerFns = calleeTask.getReturnLowerFns();
    if (!lowerFns || lowerFns.length === 0) {
      throw new Error(`missing result lower metadata for guest->guests call (subtask [${subtask.id()}])`);
    }
    
    if (lowerFns.length !== 1) {
      throw new Error(`only single result supported for guest->guest calls (subtask [${subtask.id()}])`);
    }
    
    lowerFns[0]({
      realloc: undefined,
      memory: callerMemory,
      vals: [res],
      storagePtr: subtaskCallMeta.resultPtr,
      componentIdx: callerComponentIdx
    });
    
  });
  
  // Build call params
  const subtaskCallMeta = subtask.getCallMetadata();
  let startFnParams = [];
  let calleeParams = [];
  if (subtaskCallMeta.startFn && subtaskCallMeta.resultPtr) {
    // If we're using a fused component start fn  and a result pointer is present,
    // then we need to pass the result pointer and other params to the start fn
    startFnParams.push(subtaskCallMeta.resultPtr, ...params);
  } else {
    // if not we need to pass params to the callee instead
    startFnParams.push(...params);
    calleeParams.push(...params);
  }
  
  preparedTask.registerOnResolveHandler((res) => {
    _debugLog('[_asyncStartCall()] signaling subtask completion due to task completion', {
      childTaskID: preparedTask.id(),
      subtaskID: subtask.id(),
      parentTaskID: subtask.getParentTask().id(),
    });
    subtask.onResolve(res);
  });
  
  // TODO(fix): start fns sometimes produce results, how should they be used?
  // the result should theoretically be used for flat lowering, but fused components do
  // this automatically!
  subtask.onStart({ startFnParams });
  
  _debugLog("[_asyncStartCall()] initial call", {
    task: preparedTask.id(),
    subtaskID: subtask.id(),
    calleeFnName: callee.name,
  });
  
  const callbackResult = callee.apply(null, calleeParams);
  
  _debugLog("[_asyncStartCall()] after initial call", {
    task: preparedTask.id(),
    subtaskID: subtask.id(),
    calleeFnName: callee.name,
  });
  
  const doSubtaskResolve = () => {
    subtask.deliverResolve();
  };
  
  // If a single call resolved the subtask and there is no backpressure in the guest,
  // we can return immediately
  if (subtask.resolved() && !calleeBackpressure) {
    _debugLog("[_asyncStartCall()] instantly resolved", {
      calleeComponentIdx: preparedTask.componentIdx(),
      task: preparedTask.id(),
      subtaskID: subtask.id(),
      callerComponentIdx: subtask.componentIdx(),
    });
    
    // If a fused component return function was specified for the subtask,
    // we've likely already called it during resolution of the task.
    //
    // In this case, we do not want to actually return 2 AKA "RETURNED",
    // but the normal started task state, because the fused component expects to get
    // the waitable + the original subtask state (0 AKA "STARTING")
    //
    if (subtask.getCallMetadata().returnFn) {
      return Number(subtask.waitableRep()) << 4 | subtaskState;
    }
    
    doSubtaskResolve();
    return AsyncSubtask.State.RETURNED;
  }
  
  // Start the (event) driver loop that will resolve the task
  new Promise(async (resolve, reject) => {
    if (subtask.resolved() && calleeBackpressure) {
      await calleeComponentState.waitForBackpressure();
      
      _debugLog("[_asyncStartCall()] instantly resolved after cleared backpressure", {
        calleeComponentIdx: preparedTask.componentIdx(),
        task: preparedTask.id(),
        subtaskID: subtask.id(),
        callerComponentIdx: subtask.componentIdx(),
      });
      return;
    }
    
    const started = await preparedTask.enter();
    if (!started) {
      _debugLog('[_asyncStartCall()] task failed early', {
        taskID: preparedTask.id(),
        subtaskID: subtask.id(),
      });
      throw new Error("task failed to start");
      return;
    }
    
    // TODO: retrieve/pass along actual fn name the callback corresponds to
    // (at least something like `<lifted fn name>_callback`)
    const fnName = [
    '<task ',
    subtask.parentTaskID(),
    '/subtask ',
    subtask.id(),
    '/task ',
    preparedTask.id(),
    '>',
    ].join("");
    
    try {
      _debugLog("[_asyncStartCall()] starting driver loop", { fnName, componentIdx: preparedTask.componentIdx(), });
      await _driverLoop({
        componentState: calleeComponentState,
        task: preparedTask,
        fnName,
        isAsync: true,
        callbackResult,
        resolve,
        reject
      });
    } catch (err) {
      _debugLog("[AsyncStartCall] drive loop call failure", { err });
    }
    
  });
  
  return Number(subtask.waitableRep()) << 4 | subtaskState;
}

function _syncStartCall(callbackIdx) {
  _debugLog('[_syncStartCall()] args', { callbackIdx });
  throw new Error('synchronous start call not implemented!');
}

let dv = new DataView(new ArrayBuffer());
const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);
const TEXT_DECODER_UTF8 = new TextDecoder();
const TEXT_ENCODER_UTF8 = new TextEncoder();

function _utf8AllocateAndEncode(s, realloc, memory) {
  if (typeof s !== 'string') {
    throw new TypeError('expected a string, received [' + typeof s + ']');
  }
  if (s.length === 0) { return { ptr: 1, len: 0 }; }
  let buf = TEXT_ENCODER_UTF8.encode(s);
  let ptr = realloc(0, 0, 1, buf.length);
  new Uint8Array(memory.buffer).set(buf, ptr);
  return { ptr, len: buf.length, codepoints: [...s].length };
}


function getCurrentTask(componentIdx) {
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index [' + componentIdx + '] while getting current task');
  }
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (tasks === undefined) { return undefined; }
  if (tasks.length === 0) { return undefined; }
  return tasks[tasks.length - 1];
}

function createNewCurrentTask(args) {
  _debugLog('[createNewCurrentTask()] args', args);
  const {
    componentIdx,
    isAsync,
    entryFnName,
    parentSubtaskID,
    callbackFnName,
    getCallbackFn,
    getParamsFn,
    stringEncoding,
    errHandling,
    getCalleeParamsFn,
    resultPtr,
    callingWasmExport,
  } = args;
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while starting task');
  }
  const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  const callbackFn = getCallbackFn ? getCallbackFn() : null;
  
  const newTask = new AsyncTask({
    componentIdx,
    isAsync,
    entryFnName,
    callbackFn,
    callbackFnName,
    stringEncoding,
    getCalleeParamsFn,
    resultPtr,
    errHandling,
  });
  
  const newTaskID = newTask.id();
  const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
  
  ASYNC_CURRENT_TASK_IDS.push(newTaskID);
  ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
  
  if (!taskMetas) {
    ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
  } else {
    taskMetas.push(newTaskMeta);
  }
  
  return [newTask, newTaskID];
}

function endCurrentTask(componentIdx, taskID) {
  componentIdx ??= ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
  taskID ??= ASYNC_CURRENT_TASK_IDS.at(-1);
  _debugLog('[endCurrentTask()] args', { componentIdx, taskID });
  
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while ending current task');
  }
  
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (!tasks || !Array.isArray(tasks)) {
    throw new Error('missing/invalid tasks for component instance while ending task');
  }
  if (tasks.length == 0) {
    throw new Error('no current task(s) for component instance while ending task');
  }
  
  if (taskID) {
    const last = tasks[tasks.length - 1];
    if (last.id !== taskID) {
      // throw new Error('current task does not match expected task ID');
      return;
    }
  }
  
  ASYNC_CURRENT_TASK_IDS.pop();
  ASYNC_CURRENT_COMPONENT_IDXS.pop();
  
  const taskMeta = tasks.pop();
  return taskMeta.task;
}
const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();

class AsyncTask {
  static _ID = 0n;
  
  static State = {
    INITIAL: 'initial',
    CANCELLED: 'cancelled',
    CANCEL_PENDING: 'cancel-pending',
    CANCEL_DELIVERED: 'cancel-delivered',
    RESOLVED: 'resolved',
  }
  
  static BlockResult = {
    CANCELLED: 'block.cancelled',
    NOT_CANCELLED: 'block.not-cancelled',
  }
  
  #id;
  #componentIdx;
  #state;
  #isAsync;
  #entryFnName = null;
  #subtasks = [];
  
  #onResolveHandlers = [];
  #completionPromise = null;
  
  #memoryIdx = null;
  
  #callbackFn = null;
  #callbackFnName = null;
  
  #postReturnFn = null;
  
  #getCalleeParamsFn = null;
  
  #stringEncoding = null;
  
  #parentSubtask = null;
  
  #needsExclusiveLock = false;
  
  #errHandling;
  
  #backpressurePromise;
  #backpressureWaiters = 0n;
  
  #returnLowerFns = null;
  
  cancelled = false;
  requested = false;
  alwaysTaskReturn = false;
  
  returnCalls =  0;
  storage = [0, 0];
  borrowedHandles = {};
  
  awaitableResume = null;
  awaitableCancel = null;
  
  constructor(opts) {
    this.#id = ++AsyncTask._ID;
    
    if (opts?.componentIdx === undefined) {
      throw new TypeError('missing component id during task creation');
    }
    this.#componentIdx = opts.componentIdx;
    
    this.#state = AsyncTask.State.INITIAL;
    this.#isAsync = opts?.isAsync ?? false;
    this.#entryFnName = opts.entryFnName;
    
    const {
      promise: completionPromise,
      resolve: resolveCompletionPromise,
      reject: rejectCompletionPromise,
    } = promiseWithResolvers();
    this.#completionPromise = completionPromise;
    
    this.#onResolveHandlers.push((results) => {
      resolveCompletionPromise(results);
    })
    
    if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
    if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
    
    if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
    
    if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
    
    if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
    
    this.#needsExclusiveLock = this.isSync() || !this.hasCallback();
    
    if (opts.errHandling) { this.#errHandling = opts.errHandling; }
  }
  
  taskState() { return this.#state; }
  id() { return this.#id; }
  componentIdx() { return this.#componentIdx; }
  isAsync() { return this.#isAsync; }
  entryFnName() { return this.#entryFnName; }
  completionPromise() { return this.#completionPromise; }
  
  isAsync() { return this.#isAsync; }
  isSync() { return !this.isAsync(); }
  
  getErrHandling() { return this.#errHandling; }
  
  hasCallback() { return this.#callbackFn !== null; }
  
  setReturnMemoryIdx(idx) { this.#memoryIdx = idx; }
  getReturnMemoryIdx() { return this.#memoryIdx; }
  
  setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
  getReturnLowerFns() { return this.#returnLowerFns; }
  
  setParentSubtask(subtask) {
    if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
    if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
    this.#parentSubtask = subtask;
  }
  
  getParentSubtask() { return this.#parentSubtask; }
  
  // TODO(threads): this is very inefficient, we can pass along a root task,
  // and ideally do not need this once thread support is in place
  getRootTask() {
    let currentSubtask = this.getParentSubtask();
    let task = this;
    while (currentSubtask) {
      task = currentSubtask.getParentTask();
      currentSubtask = task.getParentSubtask();
    }
    return task;
  }
  
  setPostReturnFn(f) {
    if (!f) { return; }
    if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
    this.#postReturnFn = f;
  }
  
  setCallbackFn(f, name) {
    if (!f) { return; }
    if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
    this.#callbackFn = f;
    this.#callbackFnName = name;
  }
  
  getCallbackFnName() {
    if (!this.#callbackFnName) { return undefined; }
    return this.#callbackFnName;
  }
  
  runCallbackFn(...args) {
    if (!this.#callbackFn) { throw new Error('on callback function has been set for task'); }
    return this.#callbackFn.apply(null, args);
  }
  
  getCalleeParams() {
    if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
    return this.#getCalleeParamsFn();
  }
  
  mayEnter(task) {
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (cstate.hasBackpressure()) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
      return false;
    }
    if (!cstate.callingSyncImport()) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
      return false;
    }
    const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
    if (!callingSyncExportWithSyncPending) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
      return false;
    }
    return true;
  }
  
  async enter() {
    _debugLog('[AsyncTask#enter()] args', { taskID: this.#id });
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    
    if (this.isSync()) { return true; }
    
    if (cstate.hasBackpressure()) {
      cstate.addBackpressureWaiter();
      
      const result = await this.waitUntil({
        readyFn: () => !cstate.hasBackpressure(),
        cancellable: true,
      });
      
      cstate.removeBackpressureWaiter();
      
      if (result === AsyncTask.BlockResult.CANCELLED) {
        this.cancel();
        return false;
      }
    }
    
    if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
    
    return true;
  }
  
  isRunning() {
    return this.#state !== AsyncTask.State.RESOLVED;
  }
  
  async waitUntil(opts) {
    const { readyFn, waitableSetRep, cancellable } = opts;
    _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, waitableSetRep, cancellable });
    
    const state = getOrCreateAsyncState(this.#componentIdx);
    const wset = state.waitableSets.get(waitableSetRep);
    
    let event;
    
    wset.incrementNumWaiting();
    
    const keepGoing = await this.suspendUntil({
      readyFn: () => {
        const hasPendingEvent = wset.hasPendingEvent();
        return readyFn() && hasPendingEvent;
      },
      cancellable,
    });
    
    if (keepGoing) {
      event = wset.getPendingEvent();
    } else {
      event = {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        index: 0,
        result: 0,
      };
    }
    
    wset.decrementNumWaiting();
    
    return event;
  }
  
  async onBlock(awaitable) {
    _debugLog('[AsyncTask#onBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }
    
    // Build a promise that this task can await on which resolves when it is awoken
    const { promise, resolve, reject } = promiseWithResolvers();
    this.awaitableResume = () => {
      _debugLog('[AsyncTask] resuming after onBlock', { taskID: this.#id });
      resolve();
    };
    this.awaitableCancel = (err) => {
      _debugLog('[AsyncTask] rejecting after onBlock', { taskID: this.#id, err });
      reject(err);
    };
    
    // Park this task/execution to be handled later
    const state = getOrCreateAsyncState(this.#componentIdx);
    state.parkTaskOnAwaitable({ awaitable, task: this });
    
    try {
      await promise;
      return AsyncTask.BlockResult.NOT_CANCELLED;
    } catch (err) {
      // rejection means task cancellation
      return AsyncTask.BlockResult.CANCELLED;
    }
  }
  
  async asyncOnBlock(awaitable) {
    _debugLog('[AsyncTask#asyncOnBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }
    // TODO: watch for waitable AND cancellation
    // TODO: if it WAS cancelled:
    // - return true
    // - only once per subtask
    // - do not wait on the scheduler
    // - control flow should go to the subtask (only once)
    // - Once subtask blocks/resolves, reqlinquishControl() will tehn resolve request_cancel_end (without scheduler lock release)
    // - control flow goes back to request_cancel
    //
    // Subtask cancellation should work similarly to an async import call -- runs sync up until
    // the subtask blocks or resolves
    //
    throw new Error('AsyncTask#asyncOnBlock() not yet implemented');
  }
  
  async yieldUntil(opts) {
    const { readyFn, cancellable } = opts;
    _debugLog('[AsyncTask#yieldUntil()] args', { taskID: this.#id, cancellable });
    
    const keepGoing = await this.suspendUntil({ readyFn, cancellable });
    if (!keepGoing) {
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        index: 0,
        result: 0,
      };
    }
    
    return {
      code: ASYNC_EVENT_CODE.NONE,
      index: 0,
      result: 0,
    };
  }
  
  async suspendUntil(opts) {
    const { cancellable, readyFn } = opts;
    _debugLog('[AsyncTask#suspendUntil()] args', { cancellable });
    
    const pendingCancelled = this.deliverPendingCancel({ cancellable });
    if (pendingCancelled) { return false; }
    
    const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
    return completed;
  }
  
  // TODO(threads): equivalent to thread.suspend_until()
  async immediateSuspendUntil(opts) {
    const { cancellable, readyFn } = opts;
    _debugLog('[AsyncTask#immediateSuspendUntil()] args', { cancellable, readyFn });
    
    const ready = readyFn();
    if (ready && !ASYNC_DETERMINISM && _coinFlip()) {
      return true;
    }
    
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    cstate.addPendingTask(this);
    
    const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
    return keepGoing;
  }
  
  async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
  // TODO(threads): store readyFn on the thread
  const { cancellable, readyFn } = opts;
  _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
  
  const pendingCancelled = this.deliverPendingCancel({ cancellable });
  if (pendingCancelled) { return false; }
  
  const cstate = getOrCreateAsyncState(this.#componentIdx);
  
  // TODO(fix): update this to tick until there is no more action to take.
  setTimeout(() => cstate.tick(), 0);
  
  const taskWait = await cstate.suspendTask({ task: this, readyFn });
  const keepGoing = await taskWait;
  return keepGoing;
}

deliverPendingCancel(opts) {
  const { cancellable } = opts;
  _debugLog('[AsyncTask#deliverPendingCancel()] args', { cancellable });
  
  if (cancellable && this.#state === AsyncTask.State.PENDING_CANCEL) {
    this.#state = Task.State.CANCEL_DELIVERED;
    return true;
  }
  
  return false;
}

isCancelled() { return this.cancelled }

cancel() {
  _debugLog('[AsyncTask#cancel()] args', { });
  if (!this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
    throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state for cancellation`);
  }
  if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
  this.cancelled = true;
  this.onResolve(new Error('cancelled'));
  this.#state = AsyncTask.State.RESOLVED;
}

onResolve(taskValue) {
  for (const f of this.#onResolveHandlers) {
    try {
      f(taskValue);
    } catch (err) {
      console.error("error during task resolve handler", err);
      throw err;
    }
  }
  
  if (this.#postReturnFn) {
    _debugLog('[AsyncTask#onResolve()] running post return ', {
      componentIdx: this.#componentIdx,
      taskID: this.#id,
    });
    this.#postReturnFn();
  }
}

registerOnResolveHandler(f) {
  this.#onResolveHandlers.push(f);
}

resolve(results) {
  _debugLog('[AsyncTask#resolve()] args', {
    results,
    componentIdx: this.#componentIdx,
    taskID: this.#id,
  });
  
  if (this.#state === AsyncTask.State.RESOLVED) {
    throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
  }
  if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
  switch (results.length) {
    case 0:
    this.onResolve(undefined);
    break;
    case 1:
    this.onResolve(results[0]);
    break;
    default:
    throw new Error('unexpected number of results');
  }
  this.#state = AsyncTask.State.RESOLVED;
}

exit() {
  _debugLog('[AsyncTask#exit()] args', { });
  
  // TODO: ensure there is only one task at a time (scheduler.lock() functionality)
  if (this.#state !== AsyncTask.State.RESOLVED) {
    // TODO(fix): only fused, manually specified post returns seem to break this invariant,
    // as the TaskReturn trampoline is not activated it seems.
    //
    // see: test/p3/ported/wasmtime/component-async/post-return.js
    //
    // We *should* be able to upgrade this to be more strict and throw at some point,
    // which may involve rewriting the upstream test to surface task return manually somehow.
    //
    //throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
    _debugLog('[AsyncTask#exit()] task exited without resolution', {
      componentIdx: this.#componentIdx,
      taskID: this.#id,
      subtask: this.getParentSubtask(),
      subtaskID: this.getParentSubtask()?.id(),
    });
    this.#state = AsyncTask.State.RESOLVED;
  }
  
  if (this.borrowedHandles > 0) {
    throw new Error('task [${this.#id}] exited without clearing borrowed handles');
  }
  
  const state = getOrCreateAsyncState(this.#componentIdx);
  if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
  if (!this.#isAsync && !state.inSyncExportCall) {
    throw new Error('sync task must be run from components known to be in a sync export call');
  }
  state.inSyncExportCall = false;
  
  if (this.needsExclusiveLock() && !state.isExclusivelyLocked()) {
    throw new Error('task [' + this.#id + '] exit: component [' + this.#componentIdx + '] should have been exclusively locked');
  }
  
  state.exclusiveRelease();
}

needsExclusiveLock() { return this.#needsExclusiveLock; }

createSubtask(args) {
  _debugLog('[AsyncTask#createSubtask()] args', args);
  const { componentIdx, childTask, callMetadata } = args;
  const newSubtask = new AsyncSubtask({
    componentIdx,
    childTask,
    parentTask: this,
    callMetadata,
  });
  this.#subtasks.push(newSubtask);
  return newSubtask;
}

getLatestSubtask() { return this.#subtasks.at(-1); }

currentSubtask() {
  _debugLog('[AsyncTask#currentSubtask()]');
  if (this.#subtasks.length === 0) { return undefined; }
  return this.#subtasks.at(-1);
}

endCurrentSubtask() {
  _debugLog('[AsyncTask#endCurrentSubtask()]');
  if (this.#subtasks.length === 0) { throw new Error('cannot end current subtask: no current subtask'); }
  const subtask = this.#subtasks.pop();
  subtask.drop();
  return subtask;
}
}

function _lowerImport(args, exportFn) {
  const params = [...arguments].slice(2);
  _debugLog('[_lowerImport()] args', { args, params, exportFn });
  const {
    functionIdx,
    componentIdx,
    isAsync,
    paramLiftFns,
    resultLowerFns,
    metadata,
    memoryIdx,
    getMemoryFn,
    getReallocFn,
  } = args;
  
  const parentTaskMeta = getCurrentTask(componentIdx);
  const parentTask = parentTaskMeta?.task;
  if (!parentTask) { throw new Error('missing parent task during lower of import'); }
  
  const cstate = getOrCreateAsyncState(componentIdx);
  
  const subtask = parentTask.createSubtask({
    componentIdx,
    parentTask,
    callMetadata: {
      memoryIdx,
      memory: getMemoryFn(),
      realloc: getReallocFn(),
      resultPtr: params[0],
    }
  });
  parentTask.setReturnMemoryIdx(memoryIdx);
  
  const rep = cstate.subtasks.insert(subtask);
  subtask.setRep(rep);
  
  subtask.setOnProgressFn(() => {
    subtask.setPendingEventFn(() => {
      if (subtask.resolved()) { subtask.deliverResolve(); }
      return {
        code: ASYNC_EVENT_CODE.SUBTASK,
        index: rep,
        result: subtask.getStateNumber(),
      }
    });
  });
  
  // Set up a handler on subtask completion to lower results from the call into the caller's memory region.
  subtask.registerOnResolveHandler((res) => {
    _debugLog('[_lowerImport()] handling subtask result', { res, subtaskID: subtask.id() });
    const { memory, resultPtr, realloc } = subtask.getCallMetadata();
    if (resultLowerFns.length === 0) { return; }
    resultLowerFns[0]({ componentIdx, memory, realloc, vals: [res], storagePtr: resultPtr });
  });
  
  const subtaskState = subtask.getStateNumber();
  if (subtaskState < 0 || subtaskState > 2**5) {
    throw new Error('invalid subtask state, out of valid range');
  }
  
  // NOTE: we must wait a bit before calling the export function,
  // to ensure the subtask state is not modified before the lower call return
  //
  // TODO: we should trigger via subtask state changing, rather than a static wait?
  setTimeout(async () => {
    try {
      _debugLog('[_lowerImport()] calling lowered import', { exportFn, params });
      exportFn.apply(null, params);
      
      const task = subtask.getChildTask();
      task.registerOnResolveHandler((res) => {
        _debugLog('[_lowerImport()] cascading subtask completion', {
          childTaskID: task.id(),
          subtaskID: subtask.id(),
          parentTaskID: parentTask.id(),
        });
        
        subtask.onResolve(res);
        
        cstate.tick();
      });
    } catch (err) {
      console.error("post-lower import fn error:", err);
      throw err;
    }
  }, 100);
  
  return Number(subtask.waitableRep()) << 4 | subtaskState;
}

function _liftFlatStringUTF8(ctx) {
  _debugLog('[_liftFlatStringUTF8()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
    const offset = ctx.params[0];
    if (!Number.isSafeInteger(offset)) {  throw new Error('invalid offset'); }
    const len = ctx.params[1];
    if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
    val = TEXT_DECODER_UTF8.decode(new DataView(ctx.memory.buffer, offset, len));
    ctx.params = ctx.params.slice(2);
    return [val, ctx];
  }
  
  const start = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, params[0], true);
  const codeUnits = new DataView(memory.buffer).getUint32(ctx.storagePtr, params[0] + 4, true);
  val = TEXT_DECODER_UTF8.decode(new Uint8Array(ctx.memory.buffer, start, codeUnits));
  ctx.storagePtr += codeUnits;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= codeUnits; }
  
  return [val, ctx];
}

function _lowerFlatOption(size, memory, vals, storagePtr, storageLen) {
  _debugLog('[_lowerFlatOption()] args', { size, memory, vals, storagePtr, storageLen });
  let [start] = vals;
  if (storageLen !== undefined && size !== undefined && size > storageLen) {
    throw new Error('not enough storage remaining for option flat lower');
  }
  const data = new Uint8Array(memory.buffer, start, size);
  new Uint8Array(memory.buffer, storagePtr, size).set(data);
  return data.byteLength;
}
const ASYNC_STATE = new Map();

function getOrCreateAsyncState(componentIdx, init) {
  if (!ASYNC_STATE.has(componentIdx)) {
    const newState = new ComponentAsyncState({ componentIdx });
    ASYNC_STATE.set(componentIdx, newState);
  }
  return ASYNC_STATE.get(componentIdx);
}

class ComponentAsyncState {
  static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
  
  #componentIdx;
  #callingAsyncImport = false;
  #syncImportWait = promiseWithResolvers();
  #locked = false;
  #parkedTasks = new Map();
  #suspendedTasksByTaskID = new Map();
  #suspendedTaskIDs = [];
  #pendingTasks = [];
  #errored = null;
  
  #backpressure = 0;
  #backpressureWaiters = 0n;
  
  #handlerMap = new Map();
  #nextHandlerID = 0n;
  
  mayLeave = true;
  
  #streams;
  
  waitableSets;
  waitables;
  subtasks;
  
  constructor(args) {
    this.#componentIdx = args.componentIdx;
    this.waitableSets = new RepTable({ target: `component [${this.#componentIdx}] waitable sets` });
    this.waitables = new RepTable({ target: `component [${this.#componentIdx}] waitables` });
    this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
    this.#streams = new Map();
  };
  
  componentIdx() { return this.#componentIdx; }
  streams() { return this.#streams; }
  
  errored() { return this.#errored !== null; }
  setErrored(err) {
    _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
    if (this.#errored) { return; }
    if (!err) {
      err = new Error('error elswehere (see other component instance error)')
      err.componentIdx = this.#componentIdx;
    }
    this.#errored = err;
  }
  
  callingSyncImport(val) {
    if (val === undefined) { return this.#callingAsyncImport; }
    if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
    const prev = this.#callingAsyncImport;
    this.#callingAsyncImport = val;
    if (prev === true && this.#callingAsyncImport === false) {
      this.#notifySyncImportEnd();
    }
  }
  
  #notifySyncImportEnd() {
    const existing = this.#syncImportWait;
    this.#syncImportWait = promiseWithResolvers();
    existing.resolve();
  }
  
  async waitForSyncImportCallEnd() {
    await this.#syncImportWait.promise;
  }
  
  setBackpressure(v) { this.#backpressure = v; }
  getBackpressure(v) { return this.#backpressure; }
  incrementBackpressure() {
    const newValue = this.getBackpressure() + 1;
    if (newValue > 2**16) { throw new Error("invalid backpressure value, overflow"); }
    this.setBackpressure(newValue);
  }
  decrementBackpressure() {
    this.setBackpressure(Math.max(0, this.getBackpressure() - 1));
  }
  hasBackpressure() { return this.#backpressure > 0; }
  
  waitForBackpressure() {
    let backpressureCleared = false;
    const cstate = this;
    cstate.addBackpressureWaiter();
    const handlerID = this.registerHandler({
      event: 'backpressure-change',
      fn: (bp) => {
        if (bp === 0) {
          cstate.removeHandler(handlerID);
          backpressureCleared = true;
        }
      }
    });
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (backpressureCleared) { return; }
        clearInterval(interval);
        cstate.removeBackpressureWaiter();
        resolve(null);
      }, 0);
    });
  }
  
  registerHandler(args) {
    const { event, fn } = args;
    if (!event) { throw new Error("missing handler event"); }
    if (!fn) { throw new Error("missing handler fn"); }
    
    if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
      throw new Error(`unrecognized event handler [${event}]`);
    }
    
    const handlerID = this.#nextHandlerID++;
    let handlers = this.#handlerMap.get(event);
    if (!handlers) {
      handlers = [];
      this.#handlerMap.set(event, handlers)
    }
    
    handlers.push({ id: handlerID, fn, event });
    return handlerID;
  }
  
  removeHandler(args) {
    const { event, handlerID } = args;
    const registeredHandlers = this.#handlerMap.get(event);
    if (!registeredHandlers) { return; }
    const found = registeredHandlers.find(h => h.id === handlerID);
    if (!found) { return; }
    this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
  }
  
  getBackpressureWaiters() { return this.#backpressureWaiters; }
  addBackpressureWaiter() { this.#backpressureWaiters++; }
  removeBackpressureWaiter() {
    this.#backpressureWaiters--;
    if (this.#backpressureWaiters < 0) {
      throw new Error("unexepctedly negative number of backpressure waiters");
    }
  }
  
  parkTaskOnAwaitable(args) {
    if (!args.awaitable) { throw new TypeError('missing awaitable when trying to park'); }
    if (!args.task) { throw new TypeError('missing task when trying to park'); }
    const { awaitable, task } = args;
    
    let taskList = this.#parkedTasks.get(awaitable.id());
    if (!taskList) {
      taskList = [];
      this.#parkedTasks.set(awaitable.id(), taskList);
    }
    taskList.push(task);
    
    this.wakeNextTaskForAwaitable(awaitable);
  }
  
  wakeNextTaskForAwaitable(awaitable) {
    if (!awaitable) { throw new TypeError('missing awaitable when waking next task'); }
    const awaitableID = awaitable.id();
    
    const taskList = this.#parkedTasks.get(awaitableID);
    if (!taskList || taskList.length === 0) {
      _debugLog('[ComponentAsyncState] no tasks waiting for awaitable', { awaitableID: awaitable.id() });
      return;
    }
    
    let task = taskList.shift(); // todo(perf)
    if (!task) { throw new Error('no task in parked list despite previous check'); }
    
    if (!task.awaitableResume) {
      throw new Error('task ready due to awaitable is missing resume', { taskID: task.id(), awaitableID });
    }
    task.awaitableResume();
  }
  
  // TODO: we might want to check for pre-locked status here
  exclusiveLock() {
    this.#locked = true;
  }
  
  exclusiveRelease() {
    _debugLog('[ComponentAsyncState#exclusiveRelease()] releasing', {
      locked: this.#locked,
      componentIdx: this.#componentIdx,
    });
    
    this.#locked = false
  }
  
  isExclusivelyLocked() { return this.#locked === true; }
  
  #getSuspendedTaskMeta(taskID) {
    return this.#suspendedTasksByTaskID.get(taskID);
  }
  
  #removeSuspendedTaskMeta(taskID) {
    _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', { taskID });
    const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
    const meta = this.#suspendedTasksByTaskID.get(taskID);
    this.#suspendedTaskIDs[idx] = null;
    this.#suspendedTasksByTaskID.delete(taskID);
    return meta;
  }
  
  #addSuspendedTaskMeta(meta) {
    if (!meta) { throw new Error('missing task meta'); }
    const taskID = meta.taskID;
    this.#suspendedTasksByTaskID.set(taskID, meta);
    this.#suspendedTaskIDs.push(taskID);
    if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
      this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
    }
  }
  
  suspendTask(args) {
    // TODO(threads): readyFn is normally on the thread
    const { task, readyFn } = args;
    const taskID = task.id();
    _debugLog('[ComponentAsyncState#suspendTask()]', { taskID });
    
    if (this.#getSuspendedTaskMeta(taskID)) {
      throw new Error('task [' + taskID + '] already suspended');
    }
    
    const { promise, resolve } = Promise.withResolvers();
    this.#addSuspendedTaskMeta({
      task,
      taskID,
      readyFn,
      resume: () => {
        _debugLog('[ComponentAsyncState#suspendTask()] resuming suspended task', { taskID });
        // TODO(threads): it's thread cancellation we should be checking for below, not task
        resolve(!task.isCancelled());
      },
    });
    
    return promise;
  }
  
  resumeTaskByID(taskID) {
    const meta = this.#removeSuspendedTaskMeta(taskID);
    if (!meta) { return; }
    if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
    meta.resume();
  }
  
  tick() {
    _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
    const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
    for (const taskID of resumableTasks) {
      const meta = this.#suspendedTasksByTaskID.get(taskID);
      if (!meta || !meta.readyFn) {
        throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
      }
      
      const isReady = meta.readyFn();
      if (!isReady) { continue; }
      
      this.resumeTaskByID(taskID);
    }
    
    return this.#suspendedTaskIDs.filter(t => t !== null).length === 0;
  }
  
  addPendingTask(task) {
    this.#pendingTasks.push(task);
  }
  
  addStreamEnd(args) {
    _debugLog('[ComponentAsyncState#addStreamEnd()] args', args);
    const { tableIdx, streamEnd } = args;
    
    let tbl = this.#streams.get(tableIdx);
    if (!tbl) {
      tbl = new RepTable({ target: `component [${this.#componentIdx}] streams` });
      this.#streams.set(tableIdx, tbl);
    }
    
    const streamIdx = tbl.insert(streamEnd);
    return streamIdx;
  }
  
  createStream(args) {
    _debugLog('[ComponentAsyncState#createStream()] args', args);
    const { tableIdx, elemMeta } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding stream"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding stream"); }
    
    let tbl = this.#streams.get(tableIdx);
    if (!tbl) {
      tbl = new RepTable({ target: `component [${this.#componentIdx}] streams` });
      this.#streams.set(tableIdx, tbl);
    }
    
    const stream = new InternalStream({
      tableIdx,
      componentIdx: this.#componentIdx,
      elemMeta,
    });
    const writeEndIdx = tbl.insert(stream.getWriteEnd());
    stream.setWriteEndIdx(writeEndIdx);
    const readEndIdx = tbl.insert(stream.getReadEnd());
    stream.setReadEndIdx(readEndIdx);
    
    const rep = STREAMS.insert(stream);
    stream.setRep(rep);
    
    return { writeEndIdx, readEndIdx };
  }
  
  getStreamEnd(args) {
    _debugLog('[ComponentAsyncState#getStreamEnd()] args', args);
    const { tableIdx, streamIdx } = args;
    if (tableIdx === undefined) { throw new Error('missing table idx while retrieveing stream end'); }
    if (streamIdx === undefined) { throw new Error('missing stream idx while retrieveing stream end'); }
    
    const tbl = this.#streams.get(tableIdx);
    if (!tbl) {
      throw new Error(`missing stream table [${tableIdx}] in component [${this.#componentIdx}] while getting stream`);
    }
    
    const stream = tbl.get(streamIdx);
    return stream;
  }
  
  removeStreamEnd(args) {
    _debugLog('[ComponentAsyncState#removeStreamEnd()] args', args);
    const { tableIdx, streamIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamIdx === undefined) { throw new Error("missing stream idx while removing stream end"); }
    
    const tbl = this.#streams.get(tableIdx);
    if (!tbl) {
      throw new Error(`missing stream table [${tableIdx}] in component [${this.#componentIdx}] while removing stream end`);
    }
    
    const stream = tbl.get(streamIdx);
    if (!stream) { throw new Error(`component [${this.#componentIdx}] missing stream [${streamIdx}]`); }
    
    const removed = tbl.remove(streamIdx);
    if (!removed) {
      throw new Error(`missing stream [${streamIdx}] (table [${tableIdx}]) in component [${this.#componentIdx}] while removing stream end`);
    }
    
    return stream;
  }
}

const base64Compile = str => WebAssembly.compile(typeof Buffer !== 'undefined' ? Buffer.from(str, 'base64') : Uint8Array.from(atob(str), b => b.charCodeAt(0)));

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let _fs;
async function fetchCompile (url) {
  if (isNode) {
    _fs = _fs || await import('node:fs/promises');
    return WebAssembly.compile(await _fs.readFile(url));
  }
  return fetch(url).then(WebAssembly.compileStreaming);
}

const instantiateCore = WebAssembly.instantiate;


let exports0;
let exports1;
let memory0;
let realloc0;

let lowered_import_0_metadata = {
  qualifiedImportFn: 'component:smartcms/kvstore#get',
  moduleIdx: null,
};


function trampoline0(arg0, arg1, arg2) {
  var ptr0 = arg0;
  var len0 = arg1;
  var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  _debugLog('[iface="component:smartcms/kvstore", function="get"] [Instruction::CallInterface] (sync, @ enter)');
  let hostProvided = false;
  hostProvided = get?._isHostProvided;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      entryFnName: 'get',
      getCallbackFn: () => null,
      callbackFnName: 'null',
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(0)?.task;
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    const isHostAsyncImport = hostProvided && false;
    if (isHostAsyncImport) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error("Missing subtask for host import, has the import been lowered? (ensure asyncImports are set properly)");
      }
      subtask.setChildTask(task);
      task.setParentSubtask(subtask);
    }
  }
  
  let ret =  get(result0);
  endCurrentTask(0);
  var variant2 = ret;
  if (variant2 === null || variant2=== undefined) {
    dataView(memory0).setInt8(arg2 + 0, 0, true);
  } else {
    const e = variant2;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    
    var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
    var ptr1= encodeRes.ptr;
    var len1 = encodeRes.len;
    
    dataView(memory0).setUint32(arg2 + 8, len1, true);
    dataView(memory0).setUint32(arg2 + 4, ptr1, true);
  }
  _debugLog('[iface="component:smartcms/kvstore", function="get"][Instruction::Return]', {
    funcName: 'get',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}


let lowered_import_1_metadata = {
  qualifiedImportFn: 'component:smartcms/kvstore#set',
  moduleIdx: null,
};


function trampoline1(arg0, arg1, arg2, arg3) {
  var ptr0 = arg0;
  var len0 = arg1;
  var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  var ptr1 = arg2;
  var len1 = arg3;
  var result1 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr1, len1));
  _debugLog('[iface="component:smartcms/kvstore", function="set"] [Instruction::CallInterface] (sync, @ enter)');
  let hostProvided = false;
  hostProvided = set?._isHostProvided;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: 0,
      isAsync: false,
      entryFnName: 'set',
      getCallbackFn: () => null,
      callbackFnName: 'null',
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(0)?.task;
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    const isHostAsyncImport = hostProvided && false;
    if (isHostAsyncImport) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error("Missing subtask for host import, has the import been lowered? (ensure asyncImports are set properly)");
      }
      subtask.setChildTask(task);
      task.setParentSubtask(subtask);
    }
  }
  
  let ret; set(result0, result1);
  endCurrentTask(0);
  _debugLog('[iface="component:smartcms/kvstore", function="set"][Instruction::Return]', {
    funcName: 'set',
    paramCount: 0,
    async: false,
    postReturn: false
  });
}

let exports2;
let postReturn0;

GlobalComponentAsyncLowers.define({
  componentIdx: lowered_import_0_metadata.moduleIdx,
  qualifiedImportFn: lowered_import_0_metadata.qualifiedImportFn,
  fn: _lowerImport.bind(
  null,
  {
    trampolineIdx: 0,
    componentIdx: 0,
    isAsync: false,
    paramLiftFns: [_liftFlatStringUTF8],
    metadata: lowered_import_0_metadata,
    resultLowerFns: [_lowerFlatOption.bind(null, 0)],
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
  },
  ),
});


GlobalComponentAsyncLowers.define({
  componentIdx: lowered_import_1_metadata.moduleIdx,
  qualifiedImportFn: lowered_import_1_metadata.qualifiedImportFn,
  fn: _lowerImport.bind(
  null,
  {
    trampolineIdx: 1,
    componentIdx: 0,
    isAsync: false,
    paramLiftFns: [_liftFlatStringUTF8,_liftFlatStringUTF8],
    metadata: lowered_import_1_metadata,
    resultLowerFns: [],
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    getReallocFn: () => null,
  },
  ),
});

let exports1Run;

function run() {
  _debugLog('[iface="run", function="run"][Instruction::CallWasm] enter', {
    funcName: 'run',
    paramCount: 0,
    async: false,
    postReturn: true,
  });
  const hostProvided = false;
  
  const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
    componentIdx: 0,
    isAsync: false,
    entryFnName: 'exports1Run',
    getCallbackFn: () => null,
    callbackFnName: 'null',
    errHandling: 'none',
    callingWasmExport: true,
  });
  
  let ret = exports1Run();
  endCurrentTask(0);
  var ptr0 = dataView(memory0).getUint32(ret + 0, true);
  var len0 = dataView(memory0).getUint32(ret + 4, true);
  var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
  _debugLog('[iface="run", function="run"][Instruction::Return]', {
    funcName: 'run',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  const retCopy = result0;
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  return retCopy;
  
}

const $init = (() => {
  let gen = (function* _initGenerator () {
    const module0 = fetchCompile(new URL('./guest.core.wasm', import.meta.url));
    const module1 = base64Compile('AGFzbQEAAAABDgJgA39/fwBgBH9/f38AAwMCAAEEBQFwAQICBxQDATAAAAExAAEIJGltcG9ydHMBAAofAg0AIAAgASACQQARAAALDwAgACABIAIgA0EBEQEACwAvCXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQ13aXQtY29tcG9uZW50BzAuMjQ0LjA');
    const module2 = base64Compile('AGFzbQEAAAABDgJgA39/fwBgBH9/f38AAhoDAAEwAAAAATEAAQAIJGltcG9ydHMBcAECAgkIAQBBAAsCAAEALwlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQENd2l0LWNvbXBvbmVudAcwLjI0NC4w');
    ({ exports: exports0 } = yield instantiateCore(yield module1));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      'component:smartcms/kvstore': {
        get: exports0['0'],
        set: exports0['1'],
      },
    }));
    memory0 = exports1.memory;
    GlobalComponentMemories.save({ idx: 0, componentIdx: 1, memory: memory0 });
    realloc0 = exports1.cabi_realloc;
    ({ exports: exports2 } = yield instantiateCore(yield module2, {
      '': {
        $imports: exports0.$imports,
        '0': trampoline0,
        '1': trampoline1,
      },
    }));
    postReturn0 = exports1.cabi_post_run;
    exports1Run = exports1.run;
  })();
  let promise, resolve, reject;
  function runNext (value) {
    try {
      let done;
      do {
        ({ value, done } = gen.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolve) resolve(value);
        else return value;
      }
      if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
      value.then(runNext, reject);
    }
    catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
  const maybeSyncReturn = runNext(null);
  return promise || maybeSyncReturn;
})();

await $init;

export { run,  }