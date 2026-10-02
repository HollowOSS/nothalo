import { test } from 'node:test';
import assert from 'node:assert/strict';
let sequence=0;
async function load(config){
 globalThis.fetch=async()=>new Response(JSON.stringify(config),{headers:{'content-type':'application/json'}});
 const module=await import(`../src/shared/runtime-config.ts?test=${sequence++}`);
 await module.loadRuntimeConfig();return module;
}
test('IPFS directory and individual overrides resolve without changing application code',async()=>{
 const m=await load({assetsBase:'ipfs://bafyAssetPack',ipfsGateway:'http://127.0.0.1:8080/ipfs/',assetOverrides:{'/assets/models/player.glb':'ipfs://bafyReplacement/player.glb'}});
 assert.equal(m.assetUrl('/assets/maps/test.glb'),'http://127.0.0.1:8080/ipfs/bafyAssetPack/maps/test.glb');
 assert.equal(m.assetUrl('/assets/models/player.glb'),'http://127.0.0.1:8080/ipfs/bafyReplacement/player.glb');
 assert.equal(m.assetUrl('/ws'),'/ws');
 assert.throws(()=>m.gatewayUrl('javascript:alert(1)'));
});
test('external data supports a separate pack and rejects HTML fallback pages',async()=>{
 const m=await load({dataBase:'https://example.test/data/'});
 globalThis.fetch=async url=>{assert.equal(url,'https://example.test/data/arena.json');return new Response('{"default":{"value":1}}',{headers:{'content-type':'application/json'}})};
 assert.deepEqual(await m.loadExternalData('arena.json'),{default:{value:1}});
 globalThis.fetch=async()=>new Response('<html>fallback</html>',{headers:{'content-type':'text/html'}});
 await assert.rejects(m.loadExternalData('arena.json'),/unavailable/);
});
test('unconfigured installs never silently fetch a third-party asset pack',async()=>{
 const m=await load({});assert.equal(m.assetUrl('/assets/example.glb'),'/assets/example.glb');
 await assert.rejects(m.loadExternalData('arena.json'),/Configure dataBase/);
});
