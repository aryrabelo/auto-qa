import { JevDeviceAgent, JevModel, AgentDevice } from '../src/index.mjs';

const agent = new JevDeviceAgent({
  model: new JevModel(), // Reads TYPESAFE_API_KEY.
  device: new AgentDevice({
    app: process.env.QA_APP || 'com.example.shop',
    platform: 'ios',
    session: `jev-example-${Date.now()}`,
  }),
});

const result = await agent.generate({
  prompt: 'Add a Canvas backpack to the cart, set the quantity to two, and open the checkout summary. Stop before placing an order.',
  checks: [{ name: 'Checkout summary', textIncludes: 'Checkout summary' }],
});

console.log(result.status, result.directory);

