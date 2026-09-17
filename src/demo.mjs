import { JevDeviceAgent } from './agent.mjs';
import { SimulatedShop, SimulatedDecisions } from '../examples/simulated-shop.mjs';

console.log('SIMULATION: no model API, device, video, or real benchmark measurements.');
const agent = new JevDeviceAgent({ model: new SimulatedDecisions(), device: new SimulatedShop(), record: false,
  onStep: s => console.log(`${s.step}. ${s.action}`) });
const result = await agent.generate({
  prompt: 'Add a Canvas backpack to the cart, increase the quantity to two, and open checkout. Verify that the checkout summary shows the backpack and a quantity of two.',
});
console.log(`${result.status.toUpperCase()}: ${result.reason}`);
console.log(`Report: ${result.directory}/report.html`);
process.exitCode = result.status === 'passed' ? 0 : 1;

