// This fixture exercises the actual loop but neither calls Jev nor controls a device.
export class SimulatedShop {
  constructor() { this.screen = 'product'; this.quantity = 0; this.generation = 0; this.calls = []; }
  async open() { this.calls.push('open'); return { app: 'simulated-shop' }; }
  async snapshot() {
    this.generation++;
    const node = (id, role, label, extra = {}) => ({ ref: `@e${this.generation * 10 + id}`, index: id, role, label, ...extra });
    const nodes = this.screen === 'product' ? [
      node(0, 'text', 'Canvas backpack'), node(1, 'text', `Cart: ${this.quantity} items`),
      node(2, 'button', 'Add to cart'), node(3, 'button', 'View cart'),
    ] : this.screen === 'cart' ? [
      node(0, 'text', 'Your cart'), node(1, 'text', `Quantity: ${this.quantity}`),
      node(2, 'button', 'Increase quantity'), node(3, 'button', 'Checkout'),
    ] : [
      node(0, 'text', 'Checkout summary'),
      node(1, 'text', 'Canvas backpack', { identifier: 'checkout-product' }),
      node(2, 'text', 'Quantity', { identifier: 'checkout-quantity', value: String(this.quantity) }),
    ];
    this.current = { nodes, refsGeneration: this.generation, appName: 'Simulated shop' };
    return this.current;
  }
  async act(action) {
    this.calls.push(action.kind);
    const node = this.current.nodes.find(n => `${n.ref}~s${this.generation}` === action.ref);
    if (!node) throw new Error('The simulated device received a stale or unknown ref.');
    if (node.label === 'Add to cart' || node.label === 'Increase quantity') this.quantity++;
    else if (node.label === 'View cart') this.screen = 'cart';
    else if (node.label === 'Checkout') this.screen = 'checkout';
  }
  async startRecording() { throw new Error('Simulation has no device video.'); }
  async stopRecording() { this.calls.push('stopRecording'); }
  async screenshot() { throw new Error('Simulation has no device screenshot.'); }
  async close() { this.calls.push('close'); }
}

export class SimulatedDecisions {
  mode = 'simulation';
  async decide({ state, actions }) {
    const text = JSON.stringify(state.screen.nodes);
    const label = text.includes('Checkout summary') ? null
      : text.includes('Your cart') ? (text.includes('Quantity: 2') ? 'Checkout' : 'Increase quantity')
      : text.includes('Cart: 0 items') ? 'Add to cart' : 'View cart';
    const action = label ? actions.find(a => a.description.includes(JSON.stringify(label))) : actions.find(a => a.id === 'done');
    return { choice: action.id, confidence: 0.99, model: 'simulation', latencyMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

