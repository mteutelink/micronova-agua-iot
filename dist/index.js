'use strict';
                          
                                           
                                                                                 
                                                                                                             
                                                                            
                                                                                              
                                                                                           
                                                                                              
                                                                                          

function evaluateFormula(formula                    , value        )         {
  if (!formula || formula === 'x') return value;
  const input = formula.replace(/Mod\b/g, '%').replace(/\s/g,'');
  const tokens = input.match(/\d+(?:\.\d+)?|#|>=|<=|==|!=|[+*/%(),<>-]|[A-Za-z]+/g) ?? [];
  if (tokens.join('') !== input || tokens.length > 256) throw Error('Unsupported formula');
  let i = 0;
  const read = (token       ) => {if(tokens[i++] !== token) throw Error('Invalid formula');};
  function atom()        {
    const token = tokens[i++];
    if (token === '#') return value;
    if (token === '-') return -atom();
    if (token === '+') return atom();
    if (token === '(') {const n = expression(); read(')'); return n;}
    if (token === 'int') {read('('); const n = expression(); read(')'); return Math.trunc(n);}
    if (token === 'IF') {
      read('('); const condition = expression(); read(','); const yes = expression();
      read(','); const no = expression(); read(')'); return condition ? yes : no;
    }
    if (token && /^\d/.test(token)) return Number(token);
    throw Error('Unsupported formula token');
  }
  function product()        {
    let n = atom();
    while (['*','/','%'].includes(tokens[i])) {
      const op = tokens[i++], b = atom();
      n = op === '*' ? n*b : op === '/' ? n/b : n%b;
    }
    return n;
  }
  function sum()        {
    let n = product();
    while (['+','-'].includes(tokens[i])) {
      const op = tokens[i++], b = product();
      n = op === '+' ? n+b : n-b;
    }
    return n;
  }
  function expression()        {
    const a = sum(), op = tokens[i];
    if (!['<','>','<=','>=','==','!='].includes(op)) return a;
    i++;
    const b = sum();
    return Number(op === '<' ? a<b : op === '>' ? a>b : op === '<=' ? a<=b : op === '>=' ? a>=b : op === '==' ? a===b : a!==b);
  }
  const result = expression();
  if (i !== tokens.length || !Number.isFinite(result)) throw Error('Invalid formula');
  return result;
}

class HttpError extends Error {
  status       ;
  constructor(status       ) {super(`Agua IoT HTTP ${status}`); this.status = status;}
}
class AguaClient {
          options        ;
          token        ;
          refreshToken        ;
          auth               ;
          budgets = new Map               ();
          budgetQueue = Promise.resolve();
  constructor(options        ) {
    if (!options.email || !options.password || !options.appId) throw Error('Email, password and appId are required');
    this.options = options;
  }
          async raw(path       , body        , authorization        , local=false) {
    const response = await (this.options.fetch ?? fetch)(new URL(path,'https://nordicfire.agua-iot.com'),{
      method: body ? 'POST' : 'GET', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json',Accept:'application/json',Origin:'file://',
        id_brand:'1',customer_code:'132678',...(authorization ? {Authorization:authorization,local:String(local)} : {})},
      body:body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new HttpError(response.status);
    if (path === '/appSignup') return;
    return response.json();
  }
          async authenticate(expired        ) {
    if (this.auth) return this.auth;
    if (this.token && this.token !== expired) return;
    const work = async () => {
      let result;
      if (this.refreshToken) {
        try {result = await this.raw('/refreshToken',{refresh_token:this.refreshToken});}
        catch(error) {if (!(error instanceof HttpError) || ![400,401,403].includes(error.status)) throw error;}
      }
      if (!result?.token) {
        const {appId,email,password} = this.options;
        await this.raw('/appSignup',{phone_type:'Android',phone_id:appId,phone_version:'1.0',language:'en',
          id_app:appId,push_notification_token:appId,push_notification_active:false});
        result = await this.raw('/userLogin',{email,password},appId,true);
        this.refreshToken = undefined;
      }
      if (typeof result?.token !== 'string' || !result.token) throw Error('Cloud returned no access token');
      this.token = result.token;
      this.refreshToken = result.refresh_token ?? this.refreshToken;
    };
    this.auth = work().finally(() => {this.auth = undefined;});
    return this.auth;
  }
  async login() {await this.authenticate();}
  async request(path       ,body        ) {
    if (!/^\/(deviceList|deviceGetInfo|deviceGetRegistersMap|deviceGetBufferReading|deviceRequestWriting|deviceJobStatus\/[\w%.-]+)$/.test(path)) throw Error('Invalid device endpoint');
    await this.authenticate();
    const token = this.token;
    try {return await this.raw(path,body,token);}
    catch(error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      await this.authenticate(token);
      return this.raw(path,body,this.token);
    }
  }
  async getDevices()                  {
    const result = await this.request('/deviceList',{});
    if (!Array.isArray(result?.device)) throw Error('Invalid device list');
    return Promise.all(result.device.map(async (device     ) => {
      const {id_device,id_product} = device;
      const info = await this.request('/deviceGetInfo',{id_device,id_product});
      const id_registers_map = info?.device_info?.[0]?.id_registers_map;
      if (id_registers_map == null) throw Error('Device did not identify its register map');
      return new Stove(this,{...device,id_registers_map});
    }));
  }
  async job(id   ) {
    if (id == null || !String(id) || ['.','..'].includes(String(id))) throw Error('Missing or invalid request identifier');
    const deadline = Date.now() + 30000;
    do {
      const result = await this.request('/deviceJobStatus/'+encodeURIComponent(String(id)));
      if (result?.jobAnswerStatus === 'completed' && result.jobAnswerData) return result.jobAnswerData;
      if (result?.jobAnswerStatus !== 'waiting') throw Error('Stove request failed');
      await new Promise(resolve => setTimeout(resolve,1000));
    } while (Date.now() < deadline);
    throw Error('Stove request timed out');
  }
  reserve(id       ,count       ) {
    const operation = this.budgetQueue.then(async () => {
      const day = new Date().toISOString().slice(0,10);
      const previous = this.budgets.get(id) ?? await this.options.writeBudgetStore?.get(id);
      const used = previous?.day === day ? previous.count : 0;
      if (used+count > 20) throw Error('Daily EEPROM write budget reached');
      const budget = {day,count:used+count};
      await this.options.writeBudgetStore?.set(id,budget);
      this.budgets.set(id,budget);
    });
    this.budgetQueue = operation.catch(() => {});
    return operation;
  }
}

class Stove {
           info     ;
          client           ;
          registers = new Map                 ();
          values = new Map               ();
          queue = Promise.resolve();
  constructor(client           ,info     ) {this.client=client; this.info=info;}
          address() {return {id_device:this.info.id_device,id_product:this.info.id_product};}
          async loadRegisters() {
    const result = await this.client.request('/deviceGetRegistersMap',{...this.address(),last_update:'2018-06-03T08:59:54.043'});
    const map = result?.device_registers_map?.registers_map?.find((item        ) => String(item.id)===String(this.info.id_registers_map));
    if (!Array.isArray(map?.registers) || !map.registers.length) throw Error('Matching register map not found');
    this.registers = new Map(map.registers.filter((r         ) => typeof r.reg_key==='string' && Number.isInteger(r.mask) && Number.isInteger(r.offset))
      .map((r         ) => [r.reg_key.toLowerCase(),r]));
    if (!this.registers.size) throw Error('Register map contains no valid registers');
  }
          serialize   (fn               )            {
    const operation = this.queue.then(fn);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  refresh() {return this.serialize(() => this.read());}
          async read() {
    if (!this.registers.size) await this.loadRegisters();
    const response = await this.client.request('/deviceGetBufferReading',{...this.address(),BufferId:1});
    const result = await this.client.job(response?.idRequest);
    if (!Array.isArray(result.Items) || !Array.isArray(result.Values) || result.Items.length !== result.Values.length) throw Error('Invalid stove readings');
    const raw = new Map(result.Items.map((offset   ,i       ) => [Number(offset),result.Values[i]]));
    const next = new Map               ();
    for (const [key,r] of this.registers) {
      const word = raw.get(r.offset);
      if (typeof word !== 'number' || !Number.isInteger(word) || word === 0x8000) continue;
      let n = word & r.mask;
      const bits = r.is_word ? 16 : 8;
      if (r.with_sign && (n & (1 << (bits-1)))) n -= 2**bits;
      try {next.set(key,evaluateFormula(r.formula,n));} catch { /* Unsupported conversions remain unknown. */ }
    }
    this.values = next;
    return Object.fromEntries(next);
  }
  supports(key       ) {return this.registers.has(key);}
  getRegister(key       ) {const r=this.registers.get(key); return r && structuredClone(r);}
  getValue(key       ) {return this.values.get(key) ?? null;}
  getOptions(key       ,language='ENG') {
    const options=this.registers.get(key)?.enc_val ?? [];
    const lang=options.some(option => option.lang===language) ? language : 'ENG';
    return options.filter(option => option.lang===lang).map(option => ({...option}));
  }
  getDescription(key       ,language='ENG') {
    const value=this.getValue(key);
    return value===null ? null : this.getOptions(key,language).find(option => option.value===value)?.description ?? String(value);
  }
          enabled(key       )              {
    const reg=this.registers.get(key);
    if (!reg) return true;
    const value=this.getValue(key);
    if (value===null || reg.reg_type!=='ENABLE') return null;
    return reg.enable_val ? reg.enable_val.some(option => option.value===value) : value===1;
  }
  getEnabled(key       ) {return this.supports(key) ? this.enabled(key.replace(/_[^_]+$/,'_enable')) : false;}
  canWrite(key       ) {
    const r=this.registers.get(key);
    return !!r && !r.readonly && !r.is_hex && !r.is_word && !r.big_endian &&
      (r.reg_type==='SET' || key==='status_managed_get');
  }
  getCapabilities() {
    return Object.fromEntries(Array.from(this.registers,([key,r]) => [key,{
      supported:true, enabled:this.getEnabled(key), writable:this.canWrite(key),
      min:r.set_min,max:r.set_max,step:r.step,options:this.getOptions(key)
    }]));
  }
  getOnState() {
    const value=this.getValue('status_get');
    const label=this.getDescription('status_get')?.trim().toUpperCase();
    if (value===null) return null;
    if (value===0 || /^(OFF|FINAL CLEANING|CLEANING FINAL|STOP|SHUT OFF)$/.test(label ?? '') || /ALAR[M]|ALLARM/.test(label ?? '')) return false;
    return label && label!==String(value) ? true : null;
  }
  setRegister(key       ,value       ) {return this.serialize(async () => {await this.read(); await this.write(key,value);});}
  setTargetTemperature(value       ) {return this.setRegister('temp_air_set',value);}
  setPower(value       ) {return this.setRegister('power_set',value);}
  setFan(value       ) {return this.setRegister('vent_front_set',value);}
  setOn(on        ) {
    return this.serialize(async () => {
      await this.read();
      const command=on?'ON':'OFF';
      const option=this.getOptions('status_managed_get').find(item => item.description.trim().toUpperCase()===command);
      if (!option) throw Error('On/off command absent from register map');
      await this.write('status_managed_get',option.value);
    });
  }
          async write(key       ,value       ) {
    const reg=this.registers.get(key);
    if (!reg || !this.canWrite(key)) throw Error('Register is not writable: '+key);
    if (this.getEnabled(key)!==true) throw Error('Register is disabled: '+key);
    if (![value,reg.set_min,reg.set_max].every(Number.isFinite) || value<reg.set_min || value>reg.set_max) throw Error('Value outside register limits');
    if (reg.step) {
      const step=(value-reg.set_min)/reg.step;
      if (Math.abs(step-Math.round(step))>1e-6) throw Error('Value does not match the register step');
    }
    if (key==='status_managed_get') {
      const option=this.getOptions(key).find(item => item.value===value);
      const command=option?.description.trim().toLowerCase();
      if (!command || !['on','off'].includes(command) || this.enabled('status_managed_'+command+'_enable')!==true) throw Error('On/off command disabled');
    }
    const raw=evaluateFormula(reg.formula_inverse,value);
    if (!Number.isInteger(raw) || raw<0 || raw>255 || (raw & reg.mask)!==raw) throw Error('Unsupported register encoding');
    if (key!=='status_managed_get' && this.getValue(key)===value) return;
    if (reg.eeprom!==false) await this.client.reserve(String(this.info.id_device),1);
    const result=await this.client.request('/deviceRequestWriting',{...this.address(),Protocol:'RWMSmaster',
      BitData:[8],Endianess:['L'],Items:[reg.offset],Masks:[reg.mask],Values:[raw]});
    const answer=await this.client.job(result?.idRequest);
    if (!Object.hasOwn(answer,'Cmd')) throw Error('Stove did not acknowledge the write');
  }
}

module.exports = {AguaClient, Stove, evaluateFormula};
