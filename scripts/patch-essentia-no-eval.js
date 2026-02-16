#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'node_modules', 'essentia.js', 'dist', 'essentia-wasm.umd.js');

function fail(msg) {
  console.error(`[patch-essentia] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(target)) {
  fail(`Target not found: ${target}. Run npm install first.`);
}

let src = fs.readFileSync(target, 'utf8');

const replacements = [
  {
    name: 'createNamedFunction',
    re: /function createNamedFunction\(name,body\)\{[^]*?\}\bfunction extendError\(/,
    to: 'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return function(){"use strict";return body.apply(this,arguments)}}function extendError(',
  },
  {
    name: 'makeDynCaller',
    re: /function makeDynCaller\(dynCall\)\{[^]*?\}\bvar dc=Module\["dynCall_"\+signature\];/,
    to: 'function makeDynCaller(dynCall){return function(){var callArgs=[rawFunction];for(var i=0;i<arguments.length;++i){callArgs.push(arguments[i])}return dynCall.apply(null,callArgs)}}var dc=Module["dynCall_"+signature];',
  },
  {
    name: 'craftEmvalAllocator',
    re: /function craftEmvalAllocator\(argCount\)\{[^]*?\}\bvar emval_newers=\{\};/,
    to: 'function craftEmvalAllocator(argCount){return function(constructor,argTypes,args){var ctorArgs=[];for(var i=0;i<argCount;++i){var argType=requireRegisteredType(Module["HEAP32"][(argTypes>>>2)+i],"parameter "+i);ctorArgs.push(argType.readValueFromPointer(args));args+=argType["argPackAdvance"]}var obj=new constructor(...ctorArgs);return __emval_register(obj)}}var emval_newers={};',
  },
  {
    name: 'emval_get_global',
    re: /function emval_get_global\(\)\{[^]*?\}\bfunction __emval_get_global\(name\)\{/,
    to: 'function emval_get_global(){if(typeof globalThis==="object"){return globalThis}if(typeof self==="object"){return self}if(typeof window==="object"){return window}if(typeof global==="object"){return global}throw new Error("global object unavailable")}function __emval_get_global(name){',
  },
  {
    name: 'craftInvokerFunction_no_dynamic',
    re: /function yB\(A,B,I,Q,g\)\{[^]*?\}\bfunction UB\(/,
    to: `function yB(A,B,I,Q,g){var E=B.length;E<2&&XA("argTypes array size mismatch! Must at least get return value and 'this' types!");for(var C=null!==B[1]&&null!==I,G=!1,D=1;D<B.length;++D)if(null!==B[D]&&void 0===B[D].destructorFunction){G=!0;break}var i="void"!==B[0].name,a=E-2;return function(){if(arguments.length!==a)throw XA("function "+A+" called with "+arguments.length+" arguments, expected "+a+" args!"),new Error("unreachable");var E=G?[]:null,o=C?B[1].toWireType(E,this):void 0,h=new Array(a);for(var F=0;F<a;++F)h[F]=B[F+2].toWireType(E,arguments[F]);var M=C?[o].concat(h):h,R=Q.apply(null,[g].concat(M));if(G)wB(E);else for(var Y=C?1:2,U=Y;U<B.length;++U)if(null!==B[U].destructorFunction){var S=1===U?o:h[U-2];B[U].destructorFunction(S)}return i?B[0].fromWireType(R):void 0}}function UB(`,
  },
  {
    name: 'craftInvokerFunction_readable_no_dynamic',
    re: /function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc\)\{[^]*?return invokerFunction\}/,
    to: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";return function(){if(arguments.length!==argCount-2){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+(argCount-2)+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired=isClassMethodFunc?argTypes[1].toWireType(destructors,this):undefined;var wiredArgs=new Array(argCount-2);for(var i=0;i<argCount-2;++i){wiredArgs[i]=argTypes[i+2].toWireType(destructors,arguments[i])}var callArgs=isClassMethodFunc?[cppTargetFunc,thisWired].concat(wiredArgs):[cppTargetFunc].concat(wiredArgs);var rv=cppInvokerFunc.apply(null,callArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var type=argTypes[i];if(type!==null&&type.destructorFunction!==null){var value=i===1?thisWired:wiredArgs[i-2];type.destructorFunction(value)}}}if(returns){return argTypes[0].fromWireType(rv)}}}`,
  },
  {
    name: 'emval_method_caller_no_dynamic',
    re: /function __emval_get_method_caller\(argCount,argTypes\)\{[^]*?\}\bfunction __emval_get_module_property\(name\)\{/,
    to: `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var offset=0;var callArgs=new Array(argCount-1);for(var i=0;i<argCount-1;++i){var argType=types[1+i];callArgs[i]=argType.readValueFromPointer(args+(offset?offset:0));offset+=argType["argPackAdvance"]}var rv=handle[name].apply(handle,callArgs);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(callArgs[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};return __emval_addMethodCaller(invokerFunction)}function __emval_get_module_property(name){`,
  },
];

for (const item of replacements) {
  if (item.re.test(src)) {
    src = src.replace(item.re, item.to);
    console.log(`[patch-essentia] Patched ${item.name}`);
  } else {
    console.log(`[patch-essentia] Skipped ${item.name} (already patched or pattern missing)`);
  }
}

if (src.includes('new Function(')) {
  fail('Patch incomplete: `new Function(` still present in essentia-wasm.umd.js');
}

if (/(^|[^.$\w])Function\s*\(/.test(src)) {
  fail('Patch incomplete: direct `Function(...)` constructor call still present in essentia-wasm.umd.js');
}

fs.writeFileSync(target, src);
console.log('[patch-essentia] Success: essentia-wasm.umd.js now avoids Function constructor');
