const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AguaClient,evaluateFormula} = require('./dist');

function fixture({mapId=7,enabled=1,failWrite=false,limit=false}={}) {
  const calls=[];
  const register=(reg_key,offset,extra={}) => ({reg_key,offset,mask:255,reg_type:'GET',...extra});
  const devices=[{id_device:2,id_product:3,name:'Ilvar 7'}];
  const map=[register('temp_air_get',1,{formula:'#/2'}),
    register('temp_air_set',2,{formula:'#/2',formula_inverse:'#*2',reg_type:'SET',set_min:5,set_max:35,step:.5}),
    register('temp_air_enable',3,{reg_type:'ENABLE'}),register('temp_fumes_get',4)];
  const routes={
    appSignup:{},userLogin:{token:'first',refresh_token:'refresh'},refreshToken:{token:'second'},
    deviceList:{device:devices},deviceGetInfo:{device_info:[{id_registers_map:mapId}]},
    deviceGetRegistersMap:{device_registers_map:{registers_map:[{id:7,registers:map}]}},
    deviceGetBufferReading:{idRequest:'read'},deviceRequestWriting:{idRequest:'write'},
    'deviceJobStatus/read':{jobAnswerStatus:'completed',jobAnswerData:{Items:[1,2,3,4],Values:[43,44,enabled,0x8000]}},
    'deviceJobStatus/write':{jobAnswerStatus:'completed',jobAnswerData:{Cmd:1}}
  };
  const fetch=async (url,init) => {
    const endpoint=url.pathname.slice(1);
    calls.push({endpoint,body:init.body && JSON.parse(init.body)});
    if (endpoint==='deviceRequestWriting' && failWrite) throw Error('connection lost');
    if(endpoint==='deviceList' && init.headers.Authorization==='first') return Response.json({}, {status:401});
    assert.ok(Object.hasOwn(routes,endpoint));
    return Response.json(routes[endpoint]);
  };
  const budget={day:new Date().toISOString().slice(0,10),count:20};
  const client=new AguaClient({email:'test@example.invalid',password:'fake',appId:'client',fetch,
    writeBudgetStore:limit?{get:async()=>budget,set:async()=>{}}:undefined});
  return {client,calls};
}

test('formulas accept arithmetic but cannot execute JavaScript',()=>{
  assert.equal(evaluateFormula('IF(#>3,int(#/2),# Mod 2)',7),3);
  assert.throws(()=>evaluateFormula('globalThis.process.exit()',1));
});
test('discovers exact map, refreshes auth once and decodes temperatures',async()=>{
  const {client,calls}=fixture();
  const [stove]=await client.getDevices();
  await stove.refresh();
  assert.equal(stove.getValue('temp_air_get'),21.5);
  assert.equal(stove.getValue('temp_fumes_get'),null);
  assert.equal(stove.getCapabilities().temp_air_set.enabled,true);
  assert.equal(stove.supports('vent_front_set'),false);
  assert.equal(calls.filter(c=>c.endpoint==='refreshToken').length,1);
});
test('rejects mismatched maps',async()=>{
  const [stove]=await fixture({mapId:99}).client.getDevices();
  await assert.rejects(stove.refresh(),/Matching register map/);
});
test('validates range, step, access and inverse conversion',async()=>{
  const {client,calls}=fixture();
  const [stove]=await client.getDevices();
  await assert.rejects(stove.setTargetTemperature(36),/limits/);
  await assert.rejects(stove.setTargetTemperature(21.25),/step/);
  await assert.rejects(stove.setRegister('temp_air_get',21),/writable/);
  await stove.setTargetTemperature(21.5);
  assert.deepEqual(calls.filter(c=>c.endpoint==='deviceRequestWriting').map(c=>c.body.Values),[[43]]);
});
test('blocks disabled writes and respects a persisted daily write limit',async()=>{
  for(const [options,message] of [[{enabled:0},/disabled/],[{limit:true},/budget/]]) {
    const {client,calls}=fixture(options);
    const [stove]=await client.getDevices();
    await assert.rejects(stove.setTargetTemperature(21.5),message);
    assert.equal(calls.some(c=>c.endpoint==='deviceRequestWriting'),false);
  }
});
test('does not resubmit an ambiguous write',async()=>{
  const {client,calls}=fixture({failWrite:true});
  const [stove]=await client.getDevices();
  await assert.rejects(stove.setTargetTemperature(21.5),/connection lost/);
  assert.equal(calls.filter(c=>c.endpoint==='deviceRequestWriting').length,1);
});
