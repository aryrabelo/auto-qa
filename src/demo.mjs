import { readFile } from 'node:fs/promises';
import { JevDeviceAgent } from './agent.mjs';
import { SimulatedShop, SimulatedDecisions } from '../examples/simulated-shop.mjs';

console.log('SIMULATION: no model API, device, video, or real benchmark measurements.');
const checks = JSON.parse(await readFile(new URL('../examples/cart-checks.json', import.meta.url)));
const agent = new JevDeviceAgent({ model: new SimulatedDecisions(), device: new SimulatedShop(), record: false,
  onStep: s => console.log(`${s.step}. ${s.action}`) });
const result = await agent.generate({
  prompt: 'Add a Canvas backpack to the cart, increase the quantity to two, and open checkout.', checks,
});
console.log(`${result.status.toUpperCase()}: ${result.checks.map(c => `${c.name}: ${c.status}`).join(', ')}`);
console.log(`Report: ${result.directory}/report.html`);
process.exitCode = result.status === 'passed' ? 0 : 1;

