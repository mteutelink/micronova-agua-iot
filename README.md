# micronova-agua-iot

Standalone Node.js client for Nordic Fire 2.0 and the Micronova Agua IoT cloud. The compiled package runs on Node.js 18+. Rebuild from TypeScript on Node.js 24 with `node build.cjs`, then run `npm test`.

```js
const {AguaClient} = require('micronova-agua-iot');
const client = new AguaClient({
  email: process.env.AGUA_EMAIL,
  password: process.env.AGUA_PASSWORD,
  appId: process.env.AGUA_APP_ID // Persistent client UUID
});
for (const stove of await client.getDevices()) {
  await stove.refresh();
  console.log(stove.getCapabilities());
  console.log(stove.getValue('temp_air_get'));
}
```

Each stove uses its own register map. `supports(key)` checks whether a register exists and `getEnabled(key)` checks whether it is currently enabled. The library exposes metadata, value descriptions and supported writes. Standard controls use `setOn`, `setTargetTemperature`, `setPower` and `setFan`. Writes honor the map's bounds and enable registers. Word, hexadecimal and big-endian writes are currently unsupported. The default budget is 20 EEPROM writes per stove per UTC day. Supply a `writeBudgetStore` with async `get(id)` and `set(id,budget)` methods to persist the budget across restarts.

The initial implementation has been tested against a simulated API. Actual Ilvar 7 register coverage still requires a hardware check.

Protocol reference: [Micronova Agua IoT for Home Assistant](https://github.com/vincentwolsink/home_assistant_micronova_agua_iot).
