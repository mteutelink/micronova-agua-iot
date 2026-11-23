const fs = require('node:fs');
const {stripTypeScriptTypes} = require('node:module');
const source = fs.readFileSync('src/index.ts','utf8').replace(/^export (class|function) /gm,'$1 ');
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/index.js',"'use strict';\n"+stripTypeScriptTypes(source)+"\nmodule.exports = {AguaClient, Stove, evaluateFormula};\n");
